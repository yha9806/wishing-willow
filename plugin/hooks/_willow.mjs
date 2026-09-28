// Shared helpers for the two hooks.
//
// Design rule that governs this whole file: a hook that throws is a hook that
// gets in the way. UserPromptSubmit blocks the user's Enter key until it
// returns, so every path here either succeeds quickly or gives up silently.
// Nothing in this plugin is important enough to interrupt someone's work.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const SCHEMA = 16;   // 16：加 listHeld（一轮很长、清单变化全攒到末尾）与 listAuthorSeen（作者面板改动说到哪）；11：加 plan、next（计划块与「下一步」）、touched（本会话动过的路径）、shown（上一轮说过的待触发条目）；12：加 listShown（长清单上次完整列出）；13：加 lang（写给模型的话用的语言）；14：加 listInherit（续接时从前身继承清单）；15：加 nextProblem（「下一步」没点清单编号）

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
 * Calibrated against real turns from the conversation this plugin came out of (the examples below are made-up
 * stand-ins of the same shape): "好的 继续吧 没问题" (9 chars) must pass through untouched, while
 * "可以继续 先把上一版的三个参数对一遍 再看要不要换方法..." (30 chars) must not.
 */
const ACK_ONLY = /^(?:[好可行]的?|可以|没问题|继续(?:吧)?|开始(?:吧)?|走吧|对|是的|嗯+|谢谢|多谢|辛苦了?|ok|okay|k|yes|yep|sure|thanks|thx|go|go ahead|continue|proceed|next|done|lgtm|\s|[，。、！？~…,.!?])+$/iu;


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
// The list lives in envelopes.json, beside this file, so that the writing loop reads the same rule instead of keeping
// a copy: two copies had already drifted (the loop learnt `!` shell input on 2026-09-21, this file never did, so a
// shell command was recorded as the person's request). A block is removed whole, with everything inside it; a record
// is an envelope only when nothing is left afterwards. Checked against 30 days of this machine's transcripts
// (2026-09-24): every tag-led record was tags only, except one annotation that carried the person's own sentence.
const ENVELOPES = (() => {
  try {
    const r = JSON.parse(readFileSync(new URL('./envelopes.json', import.meta.url), 'utf8'));
    if (!Array.isArray(r.tags) || !Array.isArray(r.prefixes)) throw new Error('shape');
    return { tags: r.tags, prefixes: r.prefixes, problem: null };
  } catch (e) {
    return { tags: [], prefixes: ['[SYSTEM NOTIFICATION'], problem: `envelopes.json 读不出（${e?.message ?? e}）` };
  }
})();
const BLOCK = ENVELOPES.tags.length
  ? new RegExp(`<(${ENVELOPES.tags.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b[^>]*>[\\s\\S]*?</\\1>`, 'gi')
  : null;
/** Not null when the rule file could not be read: then only the prefixes are known, and capture says so. */
export const envelopeRulesProblem = ENVELOPES.problem;

/**
 * 这句原话是不是系统塞进来的信封。capture 用它决定要不要提醒，也把结果作为
 * 事实记进状态（`origin`）—— 读方照这个字段显示，不再自己拿一份正则去猜。
 * 两份规则分别写在 JS 和 Swift 里，迟早漂成两套。
 */
export function isSystemEnvelope(prompt) {
  if (typeof prompt !== 'string') return false;
  const t = prompt.trim();
  if (!t) return false;
  if (ENVELOPES.prefixes.some((p) => t.startsWith(p))) return true;
  if (!BLOCK || !t.startsWith('<')) return false;
  let rest = t, prev;
  do { prev = rest; rest = rest.replace(BLOCK, ''); } while (rest !== prev);
  return rest.trim() === '';
}

export function shouldBypass(prompt) {
  if (typeof prompt !== 'string') return true;
  const t = prompt.trim();
  if (t.length === 0) return true;
  if (t.startsWith('/')) return true;              // slash command
  if (isSystemEnvelope(t)) return true;           // 系统塞进来的，不是人说的
  if (ACK_ONLY.test(t)) return true;               // purely an acknowledgement
  // 以前还按「分量」跳过短句（< 20，汉字算 2.5）：「推吧」「先别发」「选 1」「你直接弄吧」都被跳过，
  // 而批准和叫停恰恰多是短句，读偏了代价最大（09-27 面板 grill 第二轮 N5）。现在只有纯确认（上面那条）不问。
  // 代价不对称：多问一次几十个 token，少问一次可能是一整轮做错方向。
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

// 本轮动过的路径（待触发清单判断「和会话相关」用）。本机多数会话从一个仓库启动，再用绝对路径去改别的仓，
// 只看 cwd 会漏。只收绝对路径和 ~/ 开头的路径；相对路径没有 cwd 之外的信息，收了也判不了。
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];
const PATH_IN_COMMAND = /(?:^|[\s'"=(:])((?:\/|~\/)[^\s'"`;|&<>()*?]+)/g;
export const TOUCHED_KEEP = 100;

/** 这一轮工具调用里出现的路径，按出现先后、去重。读不到聊天记录就返回 []。 */
export function touchedPaths(input, prev) {
  const path = input?.transcript_path;
  if (typeof path !== 'string' || !path || typeof prev?.transcriptOffset !== 'number') return [];
  const text = turnSlice(path, prev.transcriptOffset);
  const out = [];
  const add = (s) => {
    if (typeof s !== 'string') return;
    const v = s.trim().replace(/[.,:]+$/, '');
    if ((v.startsWith('/') && v.length > 1) || v.startsWith('~/')) { if (!out.includes(v)) out.push(v); }
  };
  for (const line of text.split('\n')) {
    if (!line.includes('tool_use')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== 'assistant' || row.isSidechain === true || !Array.isArray(row.message?.content)) continue;
    for (const b of row.message.content) {
      if (b?.type !== 'tool_use' || !b.input || typeof b.input !== 'object') continue;
      for (const k of PATH_KEYS) add(b.input[k]);
      if (typeof b.input.command === 'string') {
        for (const m of b.input.command.matchAll(PATH_IN_COMMAND)) add(m[1]);
      }
    }
  }
  return out;
}

/** 把本轮的路径并进以前的：新的排在后面，只留最近 TOUCHED_KEEP 个。 */
export function mergeTouched(before, now) {
  const all = [...(Array.isArray(before) ? before : []).filter((x) => !now.includes(x)), ...now];
  return all.slice(-TOUCHED_KEEP);
}

/**
 * 这一轮最后一段文字里的「下一步：」。
 * 桌面端聊天记录一轮只存第一次调用工具之前的文字和最后一段文字（2026-09-13 实测），
 * 「下一步」写在回复结尾，正好落在最后一段里。读不到聊天记录时退回 last_assistant_message。
 */
export function findNext(input, prev) {
  const path = input?.transcript_path;
  if (typeof path === 'string' && path && typeof prev?.transcriptOffset === 'number') {
    const text = turnSlice(path, prev.transcriptOffset);
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

/**
 * 这一轮助手写的每一条消息：{uuid, texts}，按顺序。有 capture 记下的偏移就从那里往后读聊天记录；
 * 读不到时退回 last_assistant_message（只有最后一段，没有 uuid）。清单变化块可能写在任何一段里。
 * uuid 给清单用：同一条消息里的清单变化只执行一次，哪怕压缩把它又写进了后面的一轮（见 turnSlice）。
 */
export function turnAssistantRows(input, prev) {
  const path = input?.transcript_path;
  if (typeof path === 'string' && path && typeof prev?.transcriptOffset === 'number') {
    const text = turnSlice(path, prev.transcriptOffset);
    if (text) {
      const out = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const texts = assistantTexts(row);
        if (texts.length) out.push({ uuid: typeof row.uuid === 'string' ? row.uuid : null, texts });
      }
      if (out.length) return out;
    }
  }
  return typeof input?.last_assistant_message === 'string' ? [{ uuid: null, texts: [input.last_assistant_message] }] : [];
}

/**
 * 这一轮在聊天记录里最后一条消息的时刻（毫秒），取不到是 null。结束钩子本身的时刻不可靠：
 * 09-28 实测一轮凌晨一点多就答完，机器睡着，结束钩子到早上八点醒来才跑，面板上这一轮写「7 小时 37 分」。
 * 读的是 turnSlice 给的这一段，压缩重写进来的旧副本已经挡掉。
 */
/** 这一轮第一条消息的时刻（毫秒）：量一轮多长用它，不用 capture 跑的时刻（回放与真实记录一致）。读不到返回 null。 */
export function turnFirstAt(input, prev) {
  const path = input?.transcript_path;
  if (typeof path !== 'string' || !path || typeof prev?.transcriptOffset !== 'number') return null;
  const text = turnSlice(path, prev.transcriptOffset);
  if (!text) return null;
  let first = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== 'assistant' && row?.type !== 'user') continue;
    const t = Date.parse(row.timestamp ?? '');
    if (Number.isFinite(t) && (first === null || t < first)) first = t;
  }
  return first;
}

export function turnLastAt(input, prev) {
  const path = input?.transcript_path;
  if (typeof path !== 'string' || !path || typeof prev?.transcriptOffset !== 'number') return null;
  const text = turnSlice(path, prev.transcriptOffset);
  if (!text) return null;
  let last = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== 'assistant' && row?.type !== 'user') continue;
    const t = Date.parse(row.timestamp ?? '');
    if (Number.isFinite(t) && (last === null || t > last)) last = t;
  }
  return last;
}

/** 这一轮助手写的全部文字，按顺序。 */
export function turnAssistantTexts(input, prev) {
  return turnAssistantRows(input, prev).flatMap((r) => r.texts);
}

// 压缩会把旧消息原样重写进聊天记录末尾。2026-09-24 实测：一轮中途自动压缩之后，3,836 行旧消息带着原来的 uuid
// 和时间戳（最新的也比这一轮早三小时）追加在本轮偏移之后；结束钩子把它们当成这一轮，旧消息里 31 项清单操作又执行了一遍。
// 从偏移往后读到的因此不全是这一轮：时间比这一段第一行早 COPY_SKEW_MS 以上的不算，同一个 uuid 只算第一次。
// 第一行作锚而不用 capture 的时钟：偏移处的第一行一定是这一轮写的（副本总在它后面），用例里的时间也不必跟着真实时钟走。
// 挡不住的：只比第一行早不到一分钟的副本（上一轮刚写完就压缩）——那种由清单快照记下的 uuid 挡（_list.mjs appliedRows）。
export const COPY_SKEW_MS = 60_000;

/** 偏移往后、属于这一轮的那些行，原样拼回文本。 */
export function turnSlice(path, from) {
  const text = slice(path, from, 64 << 20);
  if (!text) return text;
  const kept = [];
  const seen = new Set();
  let anchor = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { /* 截断的行：读方自己会跳过 */ }
    const t = typeof row?.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    if (Number.isFinite(t)) {
      if (anchor === null) anchor = t;
      else if (t < anchor - COPY_SKEW_MS) continue;
    }
    const u = typeof row?.uuid === 'string' ? row.uuid : null;
    if (u !== null) {
      if (seen.has(u)) continue;
      seen.add(u);
    }
    kept.push(line);
  }
  return kept.join('\n');
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
    const text = turnSlice(path, prev.transcriptOffset);
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
