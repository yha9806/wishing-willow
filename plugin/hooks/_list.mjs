// 整场对话的长清单。
//
// 以前只有这一轮的「计划：」和一行「下一步：」，每轮重写，事项会不声不响地掉。现在清单跨轮留着：
// 模型只在清单有变化时，在回复末尾写一个「清单变化：」块，一行一条——
//   + 在做：… / + 等你：… / + 等 <什么>：… / + 以后：…（末尾可带「（依据：…）」，不带就是预测）
//   L3 做完：<证据>   L3 → <状态>[：说明]   L3 撤掉：<原因>   L3 挪到以后：<条件>   L3 认可
// 编号由这里分配。一项只能靠明写的一行离开清单；没提到的原样留着，所以「悄悄消失」在写法上就不会发生。
// 撤掉没写原因的不撤，做完没附证据的照记，引用了不存在的编号——都记为问题，下一轮说出来。
//
// 每轮有变化就往 <状态目录>/<会话>.list.jsonl 追加一行快照（{at, turnId, turnIndex, items, changes, problems, rows}）。
// rows 是这一份的操作出自哪几条消息（uuid）：同一条消息只执行一次，压缩把它重写进后面的一轮也一样（见 appliedRows）。
// 不用 .json 结尾：app 把状态目录顶层的每个 .json 都当成一个会话。

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './_willow.mjs';
import { pick } from './_lang.mjs';

// 清单的写法，每轮开头随提醒注入（capture.mjs），压缩后原样重交一次（compacted.mjs）。
// 长清单（2026-09-24 用户：要整场对话的长链路清单，跟着对话变，不只下一步）。旧的「计划：」块并进来：
// 这一轮要做的步骤就是清单里「在做」的项。只写变化，一项只能靠明写的一行离开。
const LIST_RULES_ZH =
  '这场对话有一张长清单（【清单】里是还开着的项）。每条回复末尾（「下一步：」之前）照【清单】给的那一行写「清单：…」，本轮有变化就先改好再写。' +
  '这一轮让清单有变化时——出现了要做或要等的事、做完了、换了状态、撤掉——' +
  '在「下一步：」那一行之前写「清单变化：」，下面一行一条：「+ 在做：<事>」「+ 等你：<事>」「+ 等 <什么>：<事>」「+ 以后：<事>」新增' +
  '（有事实依据时在末尾加「（依据：<提交号、文件或 CI>）」，不加就算预测）；「L3 做完：<证据>」「L3 → 等你：<为什么>」' +
  '「L3 撤掉：<原因>」「L3 认可」（用户这一轮认可了它）。没提到的项原样留着；清单没有变化就不写这一块。\n' +
  '回复的最后一行写「下一步：<这一轮之后等用户什么，或你接着做什么>」。';

// 英文版（2026-09-27 装机演练 F2）。与中文版逐条对应；写法两种都认（parseOps）。
const LIST_RULES_EN =
  'This conversation has a long list (the open items are under [Wishing-Willow · List]). End every reply, just before the "Next:" line, '
  + 'with the "List: …" line given there; if the list changed this turn, update that line first. '
  + 'When this turn changes the list — something new to do or to wait for, something finished, moved or dropped — '
  + 'write "List changes:" before the "Next:" line, one change per line: "+ Doing: <item>", "+ Waiting on you: <item>", '
  + '"+ Waiting on <what>: <item>", "+ Later: <item>" to add one (end it with "(basis: <commit, file or CI>)" when a fact backs it; '
  + 'without that it counts as a forecast); "L3 done: <evidence>", "L3 → waiting on you: <why>", "L3 dropped: <reason>", '
  + '"L3 approved" (the user approved it this turn). Items you don\'t mention stay as they are; if the list didn\'t change, leave the block out.\n'
  + 'End the reply with one line: "Next: <what you wait on the user for after this turn, or what you do next>".';

export const listRules = (lang) => pick(lang, LIST_RULES_ZH, LIST_RULES_EN);

export const STALE_TURNS = 5;
// 「等你」10 轮以上没动的标出来（2026-09-24：26 项等你大半是早上提的、没人再问过，刘海上的「等你 N」因此失去意义）。
export const STALE_YOU_TURNS = 10;
const CLOSED = new Set(['做完', '撤掉']);
const STATUS = '(在做|等你|以后|等\\s*[^：:]+?|doing|waiting on you|later|waiting on\\s+[^：:]+?)';
const ADD = new RegExp(`^\\+\\s*${STATUS}\\s*[：:]\\s*(.+)$`, 'i');
const DONE = /^(L\d+)\s*(?:做完|done)\s*(?:[：:]\s*(.*))?$/i;
const MOVE = new RegExp(`^(L\\d+)\\s*(?:→|->)\\s*${STATUS}\\s*(?:[：:]\\s*(.*))?$`, 'i');
const DROP = /^(L\d+)\s*(?:撤掉|dropped)\s*(?:[：:]\s*(.*))?$/i;
const LATER = /^(L\d+)\s*(?:挪到以后|moved to later)\s*(?:[：:]\s*(.*))?$/i;
const APPROVE = /^(L\d+)\s*(?:认可|approved)\s*$/i;
const HEAD = /^(?:清单变化|List changes)\s*[：:]\s*$/i;
const BASIS = /[（(]\s*(?:依据|basis)\s*[：:]\s*([^）)]+)[）)]\s*$/i;

export function listPath(sessionId) {
  return join(stateDir(), `${sessionId}.list.jsonl`);
}

/** 最后一份快照；没有文件是 null；读不出是 {error}——读不出不能当成空清单。 */
export function readList(sessionId) {
  const p = listPath(sessionId);
  if (!existsSync(p)) return null;
  try {
    const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    const last = JSON.parse(lines[lines.length - 1]);
    if (!last || !Array.isArray(last.items)) throw new Error('最后一行不是快照');
    return last;
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

// 磁盘上的状态值始终是中文键（app 按键翻译），英文写法在这里换成同一个键。
function status(s) {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t === '在做' || t === '等你' || t === '以后') return { status: t, wait: null };
  const low = t.toLowerCase();
  if (low === 'doing') return { status: '在做', wait: null };
  if (low === 'waiting on you') return { status: '等你', wait: null };
  if (low === 'later') return { status: '以后', wait: null };
  if (low.startsWith('waiting on ')) return { status: '等', wait: t.slice('waiting on '.length).trim() };
  return { status: '等', wait: t.replace(/^等\s*/, '') };
}

/** 从这一轮的文字里取出所有「清单变化：」块里的行，按出现顺序。块在空行、「下一步：」或一行不认识的字处结束。 */
export function parseOps(texts) {
  const ops = [];
  for (const text of texts ?? []) {
    if (typeof text !== 'string') continue;
    let inBlock = false;
    for (const raw of text.split('\n')) {
      // 「\+」是 Markdown 列表里对 + 的转义（2026-09-27 实测：模型写了「- \+ Later: …」，这一行和块里其后的行都静默丢了）。
      const line = raw.trim().replace(/^[-*]\s+/, '').replace(/^\\(?=\+)/, '');
      if (HEAD.test(line)) { inBlock = true; continue; }
      if (!inBlock) continue;
      let m;
      const before = ops.length;
      if ((m = ADD.exec(line))) {
        const b = BASIS.exec(m[2]);
        ops.push({ op: 'add', ...status(m[1]), text: (b ? m[2].slice(0, b.index) : m[2]).trim(), basis: b ? b[1].trim() : '预测' });
      } else if ((m = DONE.exec(line))) ops.push({ op: 'done', id: m[1], note: (m[2] ?? '').trim() });
      else if ((m = MOVE.exec(line))) ops.push({ op: 'move', id: m[1], ...status(m[2]), note: (m[3] ?? '').trim() });
      else if ((m = DROP.exec(line))) ops.push({ op: 'drop', id: m[1], note: (m[2] ?? '').trim() });
      else if ((m = LATER.exec(line))) ops.push({ op: 'move', id: m[1], status: '以后', wait: null, note: (m[2] ?? '').trim() });
      else if ((m = APPROVE.exec(line))) ops.push({ op: 'approve', id: m[1] });
      else if (/^(\+|L\d+)/.test(line)) ops.push({ op: 'bad', line });
      else inBlock = false;   // 空行、「下一步：」、正文：块到此为止
      if (ops.length > before) ops[ops.length - 1].raw = line;   // 用命令记过的行，回复末尾再写一遍时认得出
    }
  }
  return ops;
}

/** 把一轮的操作应用到上一份快照上。turn = {turnId, turnIndex}。 */
export function applyOps(prevItems, ops, turn, lang = 'zh') {
  const T = (zh, en) => pick(lang, zh, en);
  const items = (prevItems ?? []).map((x) => ({ ...x }));
  const changes = [];
  const problems = [];
  let next = items.reduce((n, x) => Math.max(n, Number(String(x.id).slice(1)) || 0), 0) + 1;
  const find = (id) => items.find((x) => x.id === id);
  for (const o of ops) {
    if (o.op === 'bad') { problems.push(T(`看不懂这一行：${o.line}`, `Can't read this line: ${o.line}`)); continue; }
    if (o.op === 'add') {
      const id = `L${next++}`;
      items.push({ id, text: o.text, status: o.status, wait: o.wait, basis: o.basis,
        sourceTurn: turn.turnId ?? null, since: turn.turnIndex ?? null, touched: turn.turnIndex ?? null });
      changes.push(T(`新增 ${id}`, `added ${id}`));
      continue;
    }
    const it = find(o.id);
    if (!it) { problems.push(T(`${o.id} 不存在`, `${o.id} doesn't exist`)); continue; }
    if (o.op === 'approve') { it.approvedTurn = turn.turnId ?? null; changes.push(T(`${o.id} 认可`, `${o.id} approved`)); continue; }
    if (o.op === 'drop' && !o.note) { problems.push(T(`${o.id} 撤掉没写原因，没撤`, `${o.id} dropped without a reason, so not dropped`)); continue; }
    if (o.op === 'done' && !o.note) problems.push(T(`${o.id} 做完没附证据`, `${o.id} done without evidence`));
    if (o.op === 'done') { it.status = '做完'; it.wait = null; it.evidence = o.note || null; }
    else if (o.op === 'drop') { it.status = '撤掉'; it.wait = null; it.reason = o.note; }
    else { it.status = o.status; it.wait = o.wait; if (o.note) it.note = o.note; }
    it.touched = turn.turnIndex ?? it.touched;
    changes.push(`${o.id} ${label(it, lang)}`);
  }
  return { items, changes, problems };
}

/**
 * 已经执行过清单变化的消息（所有快照的 rows 并起来）。压缩会把旧消息带着原来的 uuid 重写进聊天记录末尾；
 * 比这一轮早一分钟以上的由 turnSlice 按时间挡掉，挡不住的那一分钟由这里按 uuid 挡。
 * 读不出就是空集：那种时候 extract 本来就不写新快照（readList 报错）。
 */
export function appliedRows(sessionId) {
  const out = new Set();
  const p = listPath(sessionId);
  if (!existsSync(p)) return out;
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let snap;
      try { snap = JSON.parse(line); } catch { continue; }
      for (const u of Array.isArray(snap?.rows) ? snap.rows : []) if (typeof u === 'string') out.add(u);
    }
  } catch { /* 见上 */ }
  return out;
}

/**
 * 这一轮用命令记过的行（listctl.mjs 写的快照：via = 'command'，lines 是原样的行）。
 * 回复末尾的「清单变化：」里再写一遍同一行，extract 跳过它——一行只算一次。
 */
export function commandedLines(sessionId, turnId) {
  const out = new Set();
  const p = listPath(sessionId);
  if (!existsSync(p) || turnId === null || turnId === undefined) return out;
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let snap;
      try { snap = JSON.parse(line); } catch { continue; }
      if (snap?.via !== 'command' || snap.turnId !== turnId) continue;
      for (const l of Array.isArray(snap.lines) ? snap.lines : []) if (typeof l === 'string') out.add(l);
    }
  } catch { /* 读不出就不跳：最坏是同一行记两次，比丢一行好认 */ }
  return out;
}

/**
 * 一轮中途改清单的那条命令（2026-09-24 作者要求进度和内容实时更新）。清单原来只在回复结束时记下，
 * 一轮做二十分钟，刘海上的清单二十分钟不动。命令一跑就追加一份快照，app 靠 FSEvents 一秒内读到。
 * 会话号直接写进命令：跑命令的 shell 不知道自己属于哪个会话。
 */
export function listCommand(sessionId) {
  const script = fileURLToPath(new URL('./listctl.mjs', import.meta.url));
  return `node "${script}" --session ${sessionId}`;
}

export function commandRule(sessionId, lang = 'zh') {
  if (lang === 'en') {
    return 'Record a list change the moment it happens instead of waiting for the end of the reply (the notch shows it at once): run '
      + `${listCommand(sessionId)} "<line>" ["<line>" …]` + ', each line written as under "List changes:"; it replies with what changed and the new list line. '
      + 'Lines recorded this way need not be repeated at the end of the reply; if you do repeat them, they count once.';
  }
  return '清单一变就立刻记下，不用等到回复末尾（刘海马上就能看到）：跑 '
    + `${listCommand(sessionId)} "<一行>" ["<一行>" …]` + '，一行的写法和「清单变化：」里的一样；它会回你改了什么和新的清单那一行。'
    + '用命令记过的，回复末尾不用再写，写了也只算一次。';
}

export function appendSnapshot(sessionId, snap) {
  appendFileSync(listPath(sessionId), JSON.stringify(snap) + '\n');
}

const EN = { 在做: 'doing', 等你: 'waiting on you', 以后: 'later', 做完: 'done', 撤掉: 'dropped' };

function label(x, lang = 'zh') {
  if (lang === 'en') return x.status === '等' ? `waiting on ${x.wait}` : (EN[x.status] ?? x.status);
  return x.status === '等' ? `等 ${x.wait}` : x.status;
}

// 英文词长，同样一眼的量要多给些字符。
const brief = (t, lang = 'zh') => { const n = lang === 'en' ? 24 : 12; return t.length > n ? t.slice(0, n) + '…' : t; };

/**
 * 回复里的那一行清单（作者 09-24：「每次回复应该有一个 inline 的 todolist」）。钩子写好，模型照抄——
 * 让模型从十几项里自己摘，摘法每轮会不一样；照抄一行，本轮有变化再改。
 */
export function inlineLine(open, lang = 'zh') {
  const T = (zh, en) => pick(lang, zh, en);
  const by = (st) => open.filter((x) => x.status === st);
  const parts = [];
  const doing = by('在做');
  if (doing.length) {
    parts.push(T('◧ 在做 ', '◧ Doing ') + doing.slice(0, 2).map((x) => `${x.id} ${brief(x.text, lang)}`).join(T('、', ', '))
      + (doing.length > 2 ? T(` 等 ${doing.length} 项`, ` and ${doing.length - 2} more`) : ''));
  }
  // 最近动过的等你排前面：按编号列出来的总是最早那两项，而那两项往往早就没人问了。
  const you = by('等你').map((x, i) => [x, i])
    .sort((a, b) => ((b[0].touched ?? -1) - (a[0].touched ?? -1)) || (a[1] - b[1])).map(([x]) => x);
  if (you.length) {
    parts.push(T(`□ 等你 ${you.length}：`, `□ Waiting on you ${you.length}: `) + you.slice(0, 2).map((x) => `${x.id} ${brief(x.text, lang)}`).join(T('、', ', ')) + (you.length > 2 ? '…' : ''));
  }
  const other = by('等');
  if (other.length) parts.push(T(`⬚ 等别的 ${other.length}`, `⬚ Waiting on other ${other.length}`));
  const later = by('以后');
  if (later.length) parts.push(T(`▫ 以后 ${later.length}`, `▫ Later ${later.length}`));
  return parts.length ? T('清单：', 'List: ') + parts.join(T(' ｜ ', ' | ')) : T('清单：没有开着的事', 'List: nothing open');
}

export const REFRESH_TURNS = 10;

/**
 * 这一轮注入的清单：{text, shown}。mode：'full'（普通轮）或 'always'（短确认、系统信封：只放等你的）。
 *
 * 注入的内容会一直留在对话里。清单没变时每轮重列一遍，一百轮就是十几万 token 的重复，所以普通轮里：
 * 清单自上次完整列出以来有变化，或者隔了 REFRESH_TURNS 轮（压缩上下文会丢掉早先那份）——完整列；
 * 否则只列等你的、N 轮没动的和问题，并说其余和第几轮列的一样。shown 是新的「上次完整列出」，没完整列就原样返回。
 * 上一次有变化的那一轮留下的问题照样带上，直到下一份快照。
 */
export function listBlock(sessionId, mode, turnIndex, lastShown = null, lang = 'zh') {
  const T = (zh, en) => pick(lang, zh, en);
  const cur = readList(sessionId);
  if (cur === null) return { text: null, shown: lastShown };
  if (cur.error) return { text: T(`【Wishing-Willow · 清单】清单文件读不出（${cur.error}），不能当作没有开着的事。`,
    `[Wishing-Willow · List] The list file can't be read (${cur.error}). Don't take that as nothing being open.`), shown: lastShown };
  const snap = `${cur.turnIndex ?? ''}@${cur.at ?? ''}`;
  const full = mode === 'full' && (!lastShown || lastShown.snap !== snap
    || typeof lastShown.turn !== 'number' || typeof turnIndex !== 'number' || turnIndex - lastShown.turn >= REFRESH_TURNS);
  const open = cur.items.filter((x) => !CLOSED.has(x.status));
  const idleOf = (x) => ((x.status === '在做' || x.status === '等你') && typeof turnIndex === 'number' && typeof x.touched === 'number'
    ? turnIndex - x.touched : 0);
  const staleAt = (x) => (x.status === '等你' ? STALE_YOU_TURNS : STALE_TURNS);
  const shownItems = full ? open : open.filter((x) => x.status === '等你' || (mode === 'full' && x.status === '在做' && idleOf(x) >= STALE_TURNS));
  const lines = shownItems.map((x) => {
    const idle = idleOf(x);
    if (lang === 'en') {
      return `${x.id} ${label(x, lang)}: ${x.text}`
        + (x.basis && x.basis !== '预测' ? ` (basis: ${x.basis})` : '')
        + (x.approvedTurn ? ' (approved)' : '')
        + (idle >= staleAt(x) ? ` (untouched for ${idle} turns)` : '');
    }
    return `${x.id} ${label(x)}：${x.text}`
      + (x.basis && x.basis !== '预测' ? `（依据：${x.basis}）` : '')
      + (x.approvedTurn ? '（已认可）' : '')
      + (idle >= staleAt(x) ? `（${idle} 轮没动）` : '');
  });
  const problems = Array.isArray(cur.problems) ? cur.problems : [];
  const rest = open.length - shownItems.length;
  const count = (st) => open.filter((x) => x.status === st).length;
  const head = T(`【Wishing-Willow · 清单】开着 ${open.length} 项（等你 ${count('等你')}、在做 ${count('在做')}、`
    + `等别的 ${count('等')}、以后 ${count('以后')}）。编号给「清单变化：」用；清单只在本机，别抄进公开仓。`,
  `[Wishing-Willow · List] ${open.length} open (waiting on you ${count('等你')}, doing ${count('在做')}, `
    + `waiting on other ${count('等')}, later ${count('以后')}). The IDs are for "List changes:". The list stays on this Mac; don't copy it into public repos.`);
  const tail = [];
  if (!full && mode === 'full' && rest > 0) tail.push(T(`其余 ${rest} 项和第 ${lastShown.turn} 轮列出的一样。`, rest === 1 ? `The other item is as listed in turn ${lastShown.turn}.` : `The other ${rest} are as listed in turn ${lastShown.turn}.`));
  if (problems.length) tail.push(T(`上一次清单变化的问题：${problems.join('；')}`, `Problems with the last list changes: ${problems.join('; ')}`));
  // 每条回复都带：短确认、系统信封开始的一轮也一样。
  tail.push(T(`回复末尾照写这一行（本轮有变化就先改好）：\n${inlineLine(open)}`, `End your reply with this line (update it first if the list changed this turn):\n${inlineLine(open, lang)}`));
  return { text: [head, ...lines, ...tail].join('\n'), shown: full ? { snap, turn: turnIndex } : lastShown };
}
