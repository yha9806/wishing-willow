// Shared helpers for the two hooks.
//
// Design rule that governs this whole file: a hook that throws is a hook that
// gets in the way. UserPromptSubmit blocks the user's Enter key until it
// returns, so every path here either succeeds quickly or gives up silently.
// Nothing in this plugin is important enough to interrupt someone's work.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const SCHEMA = 11;   // 11：加 plan、next（计划块与「下一步」）

/** Where state lives. Overridable so tests never touch the real directory. */
export function stateDir() {
  return process.env.WILLOW_STATE_DIR || join(homedir(), '.claude', 'willow');
}

/** Read all of stdin. Returns '' if anything goes wrong. */
export function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Parse hook input. Returns null rather than throwing on malformed JSON. */
export function parseInput(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Pull the user's prompt out of the hook input, and say which key it came from.
 *
 * The field name is `prompt` — verified against the shipped Claude Code binary
 * (2.1.252), not against the docs, which say `user_prompt`. Writing the code
 * from the docs is how this plugin spent its first day capturing nothing at
 * all: the hook ran, found no `user_prompt`, and exited 0 in silence.
 *
 * Both names are accepted so that whichever one a given build sends, the
 * prompt still lands. Returning the key alongside the text lets the reader
 * tell "the model declared nothing" apart from "we could not read the input" —
 * two states that otherwise look identical, which is the failure this whole
 * plugin exists to break.
 */
export function readPrompt(input) {
  for (const field of ['prompt', 'user_prompt']) {
    const v = input?.[field];
    if (typeof v === 'string') return { text: v, field };
  }
  return { text: null, field: null };
}

/** A session id safe to use as a filename. */
function safeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(id) ? id : null;
}

export function statePath(sessionId) {
  const id = safeId(sessionId);
  return id ? join(stateDir(), `${id}.json`) : null;
}

/**
 * 轮次日志的路径。`.log.jsonl` 而不是 `.json` —— 读方 glob 的是 `*.json`，
 * 两者不能撞上。
 */
export function logPath(sessionId) {
  const id = safeId(sessionId);
  return id ? join(stateDir(), `${id}.log.jsonl`) : null;
}

/**
 * 把刚结束的这一轮追加进日志，只留最近 LOG_KEEP 条。
 *
 * **这份日志是索引，不是真源。** 承重的那几个字段 —— 原话、解码、标签、两个时间戳、
 * 这一轮问没问 —— 都能从 transcript 重新算出来（问没问看那一轮有没有
 * `hook_additional_context` 附件）。两者打架时以 transcript 为准，日志随时可以删掉。
 * `promptField` 是例外：它记的是 hook 输入用了哪个键名，transcript 里没有这个信息，
 * 所以它只是诊断用，任何统计都不许拿它当依据。
 * 不把这条写死，就是在造第二份「真相」，然后开始查代理不查本体。
 *
 * 它存在的唯一理由是那个可证伪的验收指标：漂移发生在第 N 轮、人第 M 轮才发现，
 * M−N 就是代价。没有历史，这个数永远算不出来。
 */
const LOG_KEEP = 20;

export function appendTurnLog(sessionId, entry) {
  const p = logPath(sessionId);
  if (!p) return false;
  try {
    mkdirSync(stateDir(), { recursive: true });
    let lines = [];
    if (existsSync(p)) {
      lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    }
    lines.push(JSON.stringify(entry));
    const kept = lines.slice(-LOG_KEEP).join('\n') + '\n';
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, kept, 'utf8');
    renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

export function readState(sessionId) {
  const p = statePath(sessionId);
  if (!p || !existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write state atomically: temp file, then rename(2).
 *
 * The temp name deliberately does not end in `.json` — readers glob for
 * `*.json`, so an in-flight write can never be picked up half-written.
 */
export function writeState(sessionId, record) {
  const p = statePath(sessionId);
  if (!p) return false;
  try {
    mkdirSync(stateDir(), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Requests that should not be interrupted with a reminder.
 *
 * Calibrated against real turns from the conversation this plugin came out of:
 * "好的 继续吧 没问题" (9 chars) must pass through untouched, while
 * "可以继续吧 问题就是我需要你找到最优解 基于..." (40 chars) must not.
 */
const ACK_ONLY = /^(?:[好可行]的?|可以|没问题|继续(?:吧)?|开始(?:吧)?|走吧|对|是的|嗯+|谢谢|多谢|辛苦了?|ok|okay|k|yes|yep|sure|thanks|thx|go|go ahead|continue|proceed|next|done|lgtm|\s|[，。、！？~…,.!?])+$/iu;

/**
 * Rough information weight, not character count.
 *
 * Calibrated on real turns: "这是什么意思 给我解释一下" is 13 characters but a
 * complete request, while "explain this to me please" is 25 characters and the
 * same request. Counting characters bypasses the Chinese one and catches the
 * English one, which is backwards. A CJK character carries roughly 2.5x what a
 * Latin one does, so weigh accordingly.
 */
function weigh(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    const cjk =
      (c >= 0x3400 && c <= 0x9fff) ||   // CJK unified ideographs (+ ext A)
      (c >= 0xf900 && c <= 0xfaff) ||   // compatibility ideographs
      (c >= 0x3040 && c <= 0x30ff) ||   // kana
      (c >= 0xac00 && c <= 0xd7af) ||   // hangul syllables
      (c >= 0x20000 && c <= 0x3ffff);   // CJK ext B+
    if (cjk) w += 2.5;
    else if (/\s/.test(ch)) w += 0.5;
    else w += 1;
  }
  return w;
}

// Deliberately low, with ACK_ONLY carrying the acknowledgements. The costs are
// asymmetric: an unnecessary reminder costs a few dozen tokens, a missed one
// costs a whole turn of work in the wrong direction. Err toward reminding.
const MIN_WEIGHT = 20;

/**
 * 信封：不是人敲进去的东西。
 *
 * Claude Code 会把后台任务通知、CI 事件、斜杠命令的本地输出这类东西同样送进
 * `UserPromptSubmit`。2026-09-12 13:52 实测：一条 `<task-notification>` 让插件
 * 要求模型声明「用户批准了什么」——而用户一个字都没说。没有请求，就没有解码。
 *
 * 认的是已知的几种信封头，认不出的照旧注入：多注入一次几十 token，漏一次是
 * 一整轮走错方向。不对称在这里，宁可多。
 *
 * 另一个 Claude 会话发来的消息（`<cross-session-message …>`）也是信封：它是说给模型听的，
 * 不是你说的。2026-09-17 核对本机记录：两条都被记成了「你的要求」，并把进行中的那一轮挤进了日志。
 */
const SYSTEM_ENVELOPE =
  /^\s*(?:<(?:task-notification|ci-monitor-event|system-reminder|command-name|command-message|local-command-stdout|cross-session-message)\b|\[SYSTEM NOTIFICATION)/i;

/**
 * 这句原话是不是系统塞进来的信封。capture 用它决定要不要提醒，也把结果作为
 * 事实记进状态（`origin`）—— 读方照这个字段显示，不再自己拿一份正则去猜。
 * 两份规则分别写在 JS 和 Swift 里，迟早漂成两套。
 */
export function isSystemEnvelope(prompt) {
  return typeof prompt === 'string' && SYSTEM_ENVELOPE.test(prompt.trim());
}

export function shouldBypass(prompt) {
  if (typeof prompt !== 'string') return true;
  const t = prompt.trim();
  if (t.length === 0) return true;
  if (t.startsWith('/')) return true;              // slash command
  if (SYSTEM_ENVELOPE.test(t)) return true;        // 系统塞进来的，不是人说的
  if (ACK_ONLY.test(t)) return true;               // purely an acknowledgement
  if (weigh(t) < MIN_WEIGHT) return true;          // too slight to misread meaningfully
  return false;
}

/** Exit without disturbing anything. Never exit 2 — that erases the user's prompt. */
export function quietExit() {
  process.exit(0);
}

/**
 * 清掉早就没用的状态文件。
 *
 * 只删同时满足两条的：**写它的进程已经不在了**，而且**超过 7 天没更新**。
 * 两条都是事实判断，不涉及内容。任何一条不满足就留着 —— 留一个过期文件的代价
 * 是几百字节，删错一个正在用的文件的代价是那个会话的整轮记录。
 * 只在 Stop 里调用：它不挡用户的回车。
 */
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function pruneState(keepId) {
  try {
    const dir = stateDir();
    if (!existsSync(dir)) return;
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (id === keepId) continue;
      const p = join(dir, name);
      let rec;
      try { rec = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
      const pid = rec?.pid;
      if (typeof pid !== 'number' || pid <= 0) continue;   // 不知道进程 → 不动
      try { process.kill(pid, 0); continue; } catch (e) {
        if (e?.code === 'EPERM') continue;                 // 别人的进程，活着
      }
      let mtime;
      try { mtime = statSync(p).mtimeMs; } catch { continue; }
      if (now - mtime < PRUNE_AFTER_MS) continue;
      try { unlinkSync(p); } catch { /* 下次再说 */ }
      try { unlinkSync(join(dir, `${id}.log.jsonl`)); } catch { /* 可能本来就没有 */ }
    }
  } catch { /* 清理失败从来不是要紧事 */ }
}

// ── 提取声明（Stop 与 capture 共用一份：被打断的一轮要在被覆盖前补回它的声明）──

// Chinese full-width and ASCII colons both, plus an English form so the plugin
// is usable outside Chinese sessions.
const DECODE_LINE = /^\s*(?:我读成了|我理解为|How I read it|Read as)\s*[：:]\s*(.+?)\s*$/iu;
const TAG_LINE = /^\s*(?:标签|Tag)\s*[：:]\s*(.+?)\s*$/iu;
// 计划块：四行之后「计划：」起头，下面每步一行「① 现在：…」「② 等 某事：…」。
// 「现在 / 等 什么」原样留着，不改写、不归一：那是模型自己排的先后，读方只转述。
const PLAN_HEAD = /^\s*(?:计划|Plan)\s*[：:]\s*$/iu;
const PLAN_STEP = /^\s*([①②③④⑤⑥⑦⑧⑨⑩])\s*(现在|Now|(?:等|After)\s*[^：:]+?)\s*[：:]\s*(.+?)\s*$/iu;
const NEXT_LINE = /^\s*(?:下一步|Next)\s*[：:]\s*(.+?)\s*$/iu;
const NEXT_SCAN = 6;     // 「下一步」属于回复的最后几行，不在就是没写

const SCAN_LINES = 12;   // the declaration belongs at the top of a message or not at all

/**
 * Find the declaration near the start of one message.
 *
 * Lines inside a code fence, a blockquote, or an indented block are skipped:
 * **quoting a declaration is not making one.** On 2026-09-12 the model pasted
 * another session's two lines into a fenced block to demonstrate them, and this
 * function recorded the quotation as that turn's declaration — the same bug then
 * corrupted a measurement later the same day (31 declarations counted where
 * there were 9). Returns null unless a decode line is found; a lone tag means
 * nothing on its own.
 */
function scanMessage(message) {
  if (typeof message !== 'string' || !message) return null;
  let seen = 0;
  let fence = null;
  let decode = null;
  let tag = null;
  let plan = null;          // null = 没写计划块；[] 不会出现（有块头没有一步也算没写）
  let inPlan = false;

  for (const line of message.split(/\r?\n/)) {
    const t = line.trim();

    const f = /^(`{3,}|~{3,})/.exec(t);
    if (f) {
      const kind = f[1][0];
      if (fence === kind) fence = null;
      else if (fence === null) fence = kind;
      continue;
    }
    if (fence !== null) continue;              // 栅栏内 = 引用
    if (t === '') continue;
    if (t.startsWith('>')) continue;           // 引用块
    if (/^\s{4,}\S/.test(line)) continue;      // 缩进代码

    if (inPlan) {
      const s = PLAN_STEP.exec(line);
      if (s) {
        (plan ??= []).push({ mark: s[1], when: s[2].trim(), text: s[3].trim() });
        continue;                               // 计划的每一步不占四行的扫描额度
      }
      inPlan = false;
      break;                                    // 计划块之后就是正文了
    }

    if (++seen > SCAN_LINES) break;

    if (decode !== null && PLAN_HEAD.test(line)) { inPlan = true; continue; }

    if (decode === null) {
      const m = DECODE_LINE.exec(line);
      if (m) decode = m[1].trim() || null;     // ⚠ 若在，原样留着：那是模型自己的判断
    }
    if (tag === null) {
      const m = TAG_LINE.exec(line);
      if (m) tag = m[1].trim() || null;
    }
  }

  return decode === null ? null : { decode, tag, plan };
}

/** 一条消息最后几行里的「下一步：」。引用、代码块里的不算。 */
function scanNext(message) {
  if (typeof message !== 'string' || !message) return null;
  const kept = [];
  let fence = null;
  for (const line of message.split(/\r?\n/)) {
    const t = line.trim();
    const f = /^(`{3,}|~{3,})/.exec(t);
    if (f) {
      const kind = f[1][0];
      if (fence === kind) fence = null;
      else if (fence === null) fence = kind;
      continue;
    }
    if (fence !== null || t === '' || t.startsWith('>') || /^\s{4,}\S/.test(line)) continue;
    kept.push(line);
  }
  for (const line of kept.slice(-NEXT_SCAN).reverse()) {
    const m = NEXT_LINE.exec(line);
    if (m) return m[1].trim() || null;
  }
  return null;
}

/**
 * 这一轮最后一段文字里的「下一步：」。
 * 桌面端聊天记录一轮只存第一次调用工具之前的文字和最后一段文字（2026-09-13 实测），
 * 「下一步」写在回复结尾，正好落在最后一段里。读不到聊天记录时退回 last_assistant_message。
 */
export function findNext(input, prev) {
  const path = input?.transcript_path;
  if (typeof path === 'string' && path && typeof prev?.transcriptOffset === 'number') {
    const text = slice(path, prev.transcriptOffset, 64 << 20);
    if (text) {
      let last = null;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const ts = assistantTexts(row);
        if (ts.length) last = ts[ts.length - 1];
      }
      if (last !== null) return scanNext(last);
    }
  }
  return scanNext(input?.last_assistant_message);
}

/** Read from `from` to EOF, at most `max` bytes. Returns '' on any failure. */
function slice(path, from, max) {
  let fd;
  try {
    const size = statSync(path).size;
    if (!(from >= 0) || from > size) return '';
    const len = Math.min(size - from, max);
    if (len <= 0) return '';
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, from);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* nothing to do */ } }
  }
}

/** Scan a chunk of transcript rows in order; returns the first declaration found. */
function scanRows(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }   // 截断的半行
    for (const t of assistantTexts(row)) {
      const hit = scanMessage(t);
      if (hit) return hit;
    }
  }
  return null;
}

/** Read at most `max` bytes from the end of a file. Returns '' on any failure. */
function tail(path, max) {
  let fd;
  try {
    const size = statSync(path).size;
    const len = Math.min(size, max);
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    // A window that starts mid-file almost certainly starts mid-line.
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* nothing to do */ } }
  }
}

/** A transcript row that is the human speaking — not a tool result, not a sidechain. */
function isUserTurn(row) {
  if (row?.type !== 'user' || row.isSidechain === true || row.isMeta === true) return false;
  const c = row.message?.content;
  if (typeof c === 'string') return true;
  if (!Array.isArray(c)) return false;
  return c.some((b) => b?.type === 'text') && !c.some((b) => b?.type === 'tool_result');
}

/** Assistant text blocks, in order. */
function assistantTexts(row) {
  if (row?.type !== 'assistant' || row.isSidechain === true) return [];
  const c = row.message?.content;
  if (typeof c === 'string') return [c];
  if (!Array.isArray(c)) return [];
  return c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
}

/**
 * 上一轮到底是被打断了，还是你在 Claude 干活时又追加了一条。
 *
 * 上一轮没结束就来了新的用户消息，有两种来历（2026-09-13 核对本机 142 份聊天记录）：
 * - 你按了打断：记录里先出现一条「[Request interrupted by user…]」的用户消息，之后才是你的新消息；
 * - 你没打断，只是又发了一条：Claude Code 把它排进队列，等 Claude 做完手头那次工具调用，
 *   在**同一轮**里交给 Claude（记录里是 queued_command 附件 + queue-operation remove，没有新的用户行）。
 *   这一轮没停，Claude 接着做。你打的字被移出队列的 30 次里，27 次是这样送达的。
 * 从上一轮的偏移往后找打断标记：找到 = 被打断；没找到 = 中途追加。
 * 读不到聊天记录或不知道偏移时按旧办法算被打断——宁可沿用旧判定，也不凭空说「中途追加」。
 */
export function interruptedSince(path, offset) {
  if (typeof path !== 'string' || !path || typeof offset !== 'number') return true;
  try { statSync(path); } catch { return true; }
  const text = slice(path, offset, 64 << 20);
  for (const line of text.split('\n')) {
    if (!line.includes('Request interrupted by user')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== 'user' || row.isSidechain === true) continue;
    const c = row.message?.content;
    const t = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(' ') : '';
    if (t.trim().startsWith('[Request interrupted by user')) return true;
  }
  return false;
}

/**
 * Find the decode line in the turn that just ended.
 *
 * `last_assistant_message` is not the reply — it is the *last* message of the
 * turn. A turn that calls tools ends with whatever prose came after the final
 * tool result, fifteen messages downstream of where the declaration belongs.
 * The first real turn this plugin ever saw did exactly that: the model declared
 * correctly in message #1 and `last_assistant_message` was message #15, so the
 * declaration was recorded as absent. Read the transcript instead, and treat
 * `last_assistant_message` as the fallback for when it cannot be read.
 */
export function findDeclaration(input, prev) {
  const path = input?.transcript_path;

  // 首选：capture 在提交那一刻记下的偏移。从那里往后读就是这一轮，
  // 没有边界搜索，也没有「窗口不够大」这种失败模式。
  if (typeof path === 'string' && path && typeof prev?.transcriptOffset === 'number') {
    const text = slice(path, prev.transcriptOffset, 64 << 20);
    if (text) {
      const hit = scanRows(text);
      if (hit) return hit;
      // 偏移有效但这一轮里没有声明 —— 这是确定的答案，不必再回溯。
      if (prev.transcriptOffset <= (() => { try { return statSync(path).size; } catch { return -1; } })()) {
        return null;
      }
    }
  }

  if (typeof path === 'string' && path) {
    // Two bounded passes: a turn with large tool output can be several MB.
    // WILLOW_TAIL_MAX exists so a test can shrink the window and actually
    // exercise the "boundary is out of reach" path instead of asserting against
    // a window big enough to hide it.
    const cap = Number(process.env.WILLOW_TAIL_MAX) || 0;
    const windows = cap > 0 ? [cap] : [2 << 20, 16 << 20];
    for (const window of windows) {
      const text = tail(path, window);
      if (!text) break;

      const rows = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* truncated or not a row */ }
      }

      let start = -1;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (isUserTurn(rows[i])) { start = i; break; }
      }
      // Boundary not in this window: a wider one may contain it. Never scan
      // without a boundary — a hit from an earlier turn would be reported as
      // this turn's declaration, which is worse than reporting none.
      if (start === -1) continue;

      for (const row of rows.slice(start + 1)) {
        for (const t of assistantTexts(row)) {
          const hit = scanMessage(t);
          if (hit) return hit;
        }
      }
      return null;   // boundary found, turn scanned, nothing declared
    }
  }
  return scanMessage(input?.last_assistant_message);
}
