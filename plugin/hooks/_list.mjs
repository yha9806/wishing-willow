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
  '「L3 撤掉：<原因>」「L3 认可」（用户这一轮认可了它）「L3 改题：<新标题>」（事情变了、原标题读起来像还悬着时）' +
  '「L3 挡着：L5、L7」（它一落地就能放开哪几项；也可以写外部的事，如「投稿」；写「无」清空）。' +
  '标题一行写完（约 40 字内），背景写进依据或说明。编号只在这场对话里算数，提到别的对话的编号要带上对话名（「会话甲的 L3」）。' +
  '没提到的项原样留着；清单没有变化就不写这一块。\n' +
  '回复的最后一行写「下一步：Lx <这件事>——<为什么是它>」：清单上还有开着的项时，点名其中一项，说它为什么排第一（挡着别的、在等你、快到期）；' +
  '清单上没有开着的项时，写这一轮之后等用户什么，或你接着做什么。';

// 英文版（2026-09-27 装机演练 F2）。与中文版逐条对应；写法两种都认（parseOps）。
const LIST_RULES_EN =
  'This conversation has a long list (the open items are under [Wishing-Willow · List]). End every reply, just before the "Next:" line, '
  + 'with the "List: …" line given there; if the list changed this turn, update that line first. '
  + 'When this turn changes the list — something new to do or to wait for, something finished, moved or dropped — '
  + 'write "List changes:" before the "Next:" line, one change per line: "+ Doing: <item>", "+ Waiting on you: <item>", '
  + '"+ Waiting on <what>: <item>", "+ Later: <item>" to add one (end it with "(basis: <commit, file or CI>)" when a fact backs it; '
  + 'without that it counts as a forecast); "L3 done: <evidence>", "L3 → waiting on you: <why>", "L3 dropped: <reason>", '
  + '"L3 approved" (the user approved it this turn), "L3 retitled: <new title>" (when things changed and the old title reads as still open). '
  + '"L3 blocks: L5, L7" (what it frees once it lands; an outside event such as "submission" is fine; "none" clears it). '
  + 'Keep a title to one line (about 80 characters); background goes in the basis or the note. '
  + 'IDs are only meaningful inside this conversation; when you mention another conversation\'s ID, name the conversation ("session A\'s L3"). '
  + 'Items you don\'t mention stay as they are; if the list didn\'t change, leave the block out.\n'
  + 'End the reply with one line: "Next: Lx <the item> — <why it comes first>": while the list has open items, name one and say why it comes first (it blocks others, it waits on the user, it is due); '
  + 'when nothing is open, say what you wait on the user for after this turn, or what you do next.';

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
// 一项挡着什么（09-28 spec「清单与下一步的分工」D1）：它一落地就能放开的项，或外部的事（投稿）。
const BLOCKS = /^(L\d+)\s*(?:挡着|blocks)\s*[：:]\s*(.+)$/i;
const BLOCKS_TAIL = /[（(]\s*(?:挡着|blocks)\s*[：:]\s*([^）)]+)[）)]\s*$/i;
const TARGETS = /\s*[、,，;；]\s*|\s+(?=L\d)/;
export function splitTargets(t) {
  const v = String(t).trim();
  if (/^(无|none|nothing|-)$/i.test(v)) return [];
  return v.split(TARGETS).map((x) => x.trim()).filter(Boolean);
}
const APPROVE = /^(L\d+)\s*(?:认可|approved)\s*$/i;
const RETITLE = /^(L\d+)\s*(?:改题|retitled?)\s*[：:]\s*(\S.*)$/i;
// 标题一行写完：中文约 40 字、英文约 80 个字符（CJK 记 1、其余记 0.5）。09-28 面板 grill 第三轮 R1：
// 建项时写成三到五行的问句，事情定了标题还在问，面板上比「现在那句」显眼得多。
export const TITLE_MAX = 40;
export function titleWidth(t) {
  let w = 0;
  for (const c of String(t)) w += c.codePointAt(0) >= 0x2e80 ? 1 : 0.5;
  return w;
}
const HEAD = /^(?:清单变化|List changes)\s*[：:]\s*$/i;
// 标题里写了会被新提交取代的东西（09-28：「领先 31 个提交」「c2210ee 连同改动说明……」——事情还成立，标题先过时了）。
// 提交号：7–40 位十六进制、既有数字又有字母（deadbeef、日期、纯数字不算）；提交数：「N 个提交」「N commits」。只报不拦，要求挪进依据。
const HASH_IN_TITLE = /(?<![0-9A-Za-z])(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![0-9A-Za-z])/;
const COUNT_IN_TITLE = /\d+\s*个(?:本地|新)?提交|\d+\s+commits?\b/i;
// 「（依据：…」起到末尾不算标题正文：依据里套了括号时解析拆不开，整段依据会留在标题里——那是照规矩写的依据，不该再催。
const BASIS_TAIL = /[（(]\s*(?:依据|basis)\s*[：:][\s\S]*$/i;
export function volatileProblem(id, text, lang = 'zh') {
  const T = (zh, en) => pick(lang, zh, en);
  const head = String(text).replace(BASIS_TAIL, '');
  const h = HASH_IN_TITLE.exec(head);
  if (h) {
    return T(`${id} 的标题里有提交号 ${h[0]}：新提交一来它就过时了，写进依据（可以「${id} 改题：…」去掉它）`,
      `${id}'s title carries a commit id (${h[0]}): the next commit makes it stale; put it in the basis (drop it with "${id} retitled: …")`);
  }
  const c = COUNT_IN_TITLE.exec(head);
  return c ? T(`${id} 的标题里写了提交数（${c[0]}）：数会变，写进依据`,
    `${id}'s title carries a commit count (${c[0]}): the count changes; put it in the basis`) : null;
}
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
        // 末尾的「（依据：…）」「（挡着：…）」两种都可以有，先后不论。
        let text = m[2], basis = '预测', blocks = null;
        for (let k = 0; k < 2; k++) {
          const b = BASIS.exec(text);
          if (b) { basis = b[1].trim(); text = text.slice(0, b.index); continue; }
          const t = BLOCKS_TAIL.exec(text);
          if (t) { blocks = splitTargets(t[1]); text = text.slice(0, t.index); }
        }
        ops.push({ op: 'add', ...status(m[1]), text: text.trim(), basis, ...(blocks ? { blocks } : {}) });
      } else if ((m = BLOCKS.exec(line))) ops.push({ op: 'blocks', id: m[1], targets: splitTargets(m[2]) }); else if ((m = DONE.exec(line))) ops.push({ op: 'done', id: m[1], note: (m[2] ?? '').trim() });
      else if ((m = MOVE.exec(line))) ops.push({ op: 'move', id: m[1], ...status(m[2]), note: (m[3] ?? '').trim() });
      else if ((m = DROP.exec(line))) ops.push({ op: 'drop', id: m[1], note: (m[2] ?? '').trim() });
      else if ((m = LATER.exec(line))) ops.push({ op: 'move', id: m[1], status: '以后', wait: null, note: (m[2] ?? '').trim() });
      else if ((m = APPROVE.exec(line))) ops.push({ op: 'approve', id: m[1] });
      else if ((m = RETITLE.exec(line))) ops.push({ op: 'retitle', id: m[1], text: m[2].trim() });
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
      // 「+ 以后：L23 发布前……」：正文以一个已有的编号开头，是在复述那一项，不是新事（09-27 面板 grill 第二轮 N6：
      // 命令记过 L21、L23 之后，回复末尾又带着编号写了一遍，各多出一项）。不新增，记成问题，下一轮说出来。
      const ref = /^(L\d+)(?![\d])/.exec(o.text);
      if (ref && find(ref[1])) {
        problems.push(T(`${ref[1]} 已在清单上，这一行是在复述它，没有新增`, `${ref[1]} is already on the list; this line restates it, so nothing was added`));
        continue;
      }
      const id = `L${next++}`;
      items.push({ id, text: o.text, status: o.status, wait: o.wait, basis: o.basis,
        sourceTurn: turn.turnId ?? null, since: turn.turnIndex ?? null, touched: turn.turnIndex ?? null,
        ...(o.blocks && o.blocks.length ? { blocks: o.blocks } : {}) });
      changes.push(T(`新增 ${id}`, `added ${id}`));
      if (titleWidth(o.text) > TITLE_MAX) {
        problems.push(T(`${id} 的标题太长（一行写完，约 40 字内），背景写进依据或说明；可以「${id} 改题：…」改短`,
          `${id}'s title is too long (keep it to one line, about 80 characters); put background in the basis or the note, or shorten it with "${id} retitled: …"`));
      }
      const v = volatileProblem(id, o.text, lang);
      if (v) problems.push(v);
      continue;
    }
    const it = find(o.id);
    if (!it) { problems.push(T(`${o.id} 不存在`, `${o.id} doesn't exist`)); continue; }
    if (o.op === 'approve') { it.approvedTurn = turn.turnId ?? null; changes.push(T(`${o.id} 认可`, `${o.id} approved`)); continue; }
    if (o.op === 'blocks') {
      // 编号只认这场对话里有的；外部的事（投稿、截止）照写。写「无」清空。
      const missing = o.targets.filter((t) => /^L\d+$/.test(t) && !find(t));
      for (const t of missing) problems.push(T(`${o.id} 挡着的 ${t} 不存在`, `${o.id} blocks ${t}, which doesn't exist`));
      const kept = o.targets.filter((t) => !missing.includes(t));
      if (kept.length) it.blocks = kept; else delete it.blocks;
      it.touched = turn.turnIndex ?? it.touched;
      changes.push(kept.length ? T(`${o.id} 挡着 ${kept.join('、')}`, `${o.id} blocks ${kept.join(', ')}`) : T(`${o.id} 不再挡着别的`, `${o.id} blocks nothing now`));
      continue;
    }
    if (o.op === 'retitle') {
      // 建项原句留在 firstText：面板和记录都还能查到当初是怎么写的。
      if (it.firstText === undefined) it.firstText = it.text;
      it.text = o.text;
      it.touched = turn.turnIndex ?? it.touched;
      changes.push(T(`${o.id} 改题`, `${o.id} retitled`));
      const v = volatileProblem(o.id, o.text, lang);
      if (v) problems.push(v);
      continue;
    }
    if (o.op === 'drop' && !o.note) { problems.push(T(`${o.id} 撤掉没写原因，没撤`, `${o.id} dropped without a reason, so not dropped`)); continue; }
    if (o.op === 'done' && !o.note) problems.push(T(`${o.id} 做完没附证据`, `${o.id} done without evidence`));
    if (o.op === 'done') { it.status = '做完'; it.wait = null; it.evidence = o.note || null; }
    else if (o.op === 'drop') { it.status = '撤掉'; it.wait = null; it.reason = o.note; }
    // 不带说明的转状态清掉旧说明：旧那句说的是上一个状态，留着面板就显示过期的话（L15，_list.mjs 原 119 行）。
    else { it.status = o.status; it.wait = o.wait; if (o.note) it.note = o.note; else delete it.note; }
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
/** 比较「同一行」时不看 Markdown 的修饰（反引号、加粗）和多余空白：回复末尾复述命令记过的行时常带这些。 */
export const normLine = (l) => String(l).replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();

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
      for (const l of Array.isArray(snap.lines) ? snap.lines : []) if (typeof l === 'string') out.add(normLine(l));
    }
  } catch { /* 读不出就不跳：最坏是同一行记两次，比丢一行好认 */ }
  return out;
}

/**
 * 作者在 lintel 面板里做的改动（09-28 spec「清单实时」C）：app 调 listctl --by author 写的快照，via = 'author'。
 * 列出某一刻之后的，下一轮在【清单】里告诉模型「你在面板里改了什么」。
 */
export function authorChanges(sessionId, sinceIso) {
  const out = [];
  const p = listPath(sessionId);
  if (!existsSync(p)) return out;
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let snap;
      try { snap = JSON.parse(line); } catch { continue; }
      if (snap?.via !== 'author' || (sinceIso && !(String(snap.at) > sinceIso))) continue;
      for (const c of Array.isArray(snap.changes) ? snap.changes : []) if (typeof c === 'string') out.push(c);
    }
  } catch { /* 读不出就不说：最坏是模型下一轮才从清单本身看到变化 */ }
  return out;
}

/** 一轮做了这么久，清单变化却全攒到回复末尾，就说出来（09-28 spec「清单实时」A）。 */
export const HELD_MS = 5 * 60 * 1000;

/**
 * 回复末尾的「清单变化」里有做完、撤掉或换状态，这一轮却一次都没用命令记过清单，而且一轮 ≥ 5 分钟：
 * 这些变化本该发生时就记下（刘海一直是旧的）。新增不算——新增常常就是回复末尾才想清楚的。
 */
export function heldProblem(ops, commandedCount, startedMs, endedMs, lang) {
  if (commandedCount > 0 || !Number.isFinite(startedMs) || !Number.isFinite(endedMs)) return null;
  const mins = Math.floor((endedMs - startedMs) / 60000);
  if (endedMs - startedMs < HELD_MS) return null;
  const n = ops.filter((o) => o.op === 'done' || o.op === 'drop' || o.op === 'move').length;
  if (!n) return null;
  return pick(lang, `上一轮做了 ${mins} 分钟，${n} 处清单变化（做完、撤掉、换状态）都攒到了回复末尾，刘海上一直是旧的：发生时就用命令记`,
    `Last turn ran ${mins} minutes and ${n} list changes (done, dropped, moved) waited until the end of the reply, so the notch stayed stale: record them with the command as they happen`);
}

// 一轮有提交之后核一遍等你（09-28：一张清单 9 项等你里 6 项过时——前提被新提交取代、条件已经满足、默认做法已经落稿，
// 每项都只在记下它的那一轮被看过，「落稿后扫一遍」只是一条记在别处的规矩）。同一项核过后 SWEEP_EVERY 轮内不再问，
// 它被改动过就重新算：每轮都提交的会话里每轮把每项点一遍，这一行很快就没人读了。
export const SWEEP_EVERY = 5;
const SWEEP_SHOW = 6;

/** 该核的等你：这一轮之前记下、这一轮没碰过、改动以来没核过或核过已 SWEEP_EVERY 轮。swept 是 {编号: 上次核的轮次}。 */
export function sweepDue(items, turnIndex, swept) {
  if (!Array.isArray(items) || typeof turnIndex !== 'number') return [];
  const s = swept && typeof swept === 'object' ? swept : {};
  return items.filter((x) => {
    if (x.status !== '等你' || x.touched === turnIndex) return false;
    const at = s[x.id];
    return typeof at !== 'number' || (typeof x.touched === 'number' && at < x.touched) || turnIndex - at >= SWEEP_EVERY;
  });
}

/** 下一轮开头说的那一句；没有提交或没有该核的是 null。commits 是 turnCommits 的结果。 */
export function sweepText(commits, due, lang = 'zh') {
  if (!commits?.length || !due?.length) return null;
  const T = (zh, en) => pick(lang, zh, en);
  // 安静提交读不到提交号（turnCommits 的 hash 为 null）：有号的列前三个，其余只报个数。
  const known = commits.filter((c) => c.hash).slice(0, 3).map((c) => c.hash.slice(0, 7));
  const hashes = !known.length ? T(`${commits.length} 次`, `${commits.length} time${commits.length === 1 ? '' : 's'}`)
    : known.join(T('、', ', ')) + (commits.length > known.length
      ? T(` 等 ${commits.length} 个`, ` and ${commits.length - known.length} more`) : '');
  const ids = due.slice(0, SWEEP_SHOW).map((x) => `${x.id} ${brief(x.text, lang)}`).join(T('、', ', '))
    + (due.length > SWEEP_SHOW ? T(` 等 ${due.length} 项`, ` and ${due.length - SWEEP_SHOW} more`) : '');
  return T(`上一轮提交了 ${hashes}。之前记下、那一轮没碰过的等你 ${due.length} 项，逐条核它是否还成立：${ids}。`
    + '前提被这些提交取代的改题或撤掉，条件已经满足的改状态或做完；仍成立的不用写。',
  `Last turn committed ${hashes}. ${due.length} item(s) waiting on the user were recorded earlier and not touched in that turn; `
    + `check each still holds: ${ids}. Retitle or drop what the commits superseded, move or finish what they satisfied; `
    + 'nothing to write for what still holds.');
}

// 挂久了的项点一次名（09-28：一项「在做」连续 9 轮被标「N 轮没动」没人处理——每轮都在的被动标记会被读麻木；
// 一项「等别的会话」挂了 184 轮，「等 X」连标记都没有）。门槛：在做 STALE_TURNS、等你 STALE_YOU_TURNS、等别的 STALE_WAIT_TURNS；
// 点过以后，没动的轮数翻倍、并且至少又过 NUDGE_EVERY 轮才再点（在做 5→15→30、等你 10→20→40、等别的 20→40→80）：
// 长期停着等外部的事不会每十轮点一次（按固定十轮，一个会话 170 轮里有 68 轮要点名）。改动过就重新算。
// 「问过」与提交后核对共用一张记录（{编号: 轮次}），同一项一轮里不会被点两次。
export const STALE_WAIT_TURNS = 20;
export const NUDGE_EVERY = 10;
const NUDGE_SHOW = 6;

/** 该点名的项，各带 idle（没动的轮数）。asked 是 {编号: 上次问的轮次}。以后的不点。 */
export function idleDue(items, turnIndex, asked) {
  if (!Array.isArray(items) || typeof turnIndex !== 'number') return [];
  const a = asked && typeof asked === 'object' ? asked : {};
  const limit = { 在做: STALE_TURNS, 等你: STALE_YOU_TURNS, 等: STALE_WAIT_TURNS };
  return items.filter((x) => {
    const lim = limit[x.status];
    if (!lim || typeof x.touched !== 'number' || turnIndex - x.touched < lim) return false;
    const at = a[x.id];
    if (typeof at !== 'number' || at < x.touched) return true;
    const was = at - x.touched;
    return turnIndex - x.touched >= Math.max(2 * was, was + NUDGE_EVERY);
  }).map((x) => ({ ...x, idle: turnIndex - x.touched }));
}

/** 点名的那一句；没有该点的是 null。 */
export function idleText(due, lang = 'zh') {
  if (!due?.length) return null;
  const T = (zh, en) => pick(lang, zh, en);
  const one = (x) => T(`${x.id} ${brief(x.text, lang)}（${label(x, lang)}，${x.idle} 轮）`,
    `${x.id} ${brief(x.text, lang)} (${label(x, lang)}, ${x.idle} turns)`);
  const ids = due.slice(0, NUDGE_SHOW).map(one).join(T('、', ', '))
    + (due.length > NUDGE_SHOW ? T(` 等 ${due.length} 项`, ` and ${due.length - NUDGE_SHOW} more`) : '');
  return T(`这几项挂了很久没动，逐条核一次：${ids}。没在做的改成以后或「等 X」，前提变了的改题或撤掉，做完的写做完；`
    + '仍然成立的不用写，挂得越久问得越稀。',
  `These have not moved for a long time; check each once: ${ids}. Move what is not being done to later or "waiting on X", `
    + 'retitle or drop what changed, mark done what is done; nothing to write for what still holds (the longer it waits, the less often it is asked).');
}

/** 「问过」的记录只留还开着的项。 */
export function openAsked(asked, items) {
  const open = new Set((items ?? []).filter((x) => !CLOSED.has(x.status) && x.status !== '以后').map((x) => x.id));
  return Object.fromEntries(Object.entries(asked ?? {}).filter(([id]) => open.has(id)));
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

/** 开着的项里写了「挡着」的，按挡着的开着的项与外部事件的多少排，取前三（spec D2 的候选，只给数不替模型选）。 */
export function blockCandidates(items) {
  const open = new Set(items.filter((x) => !CLOSED.has(x.status)).map((x) => x.id));
  return items.filter((x) => open.has(x.id) && x.blocks?.length)
    .map((x) => ({ id: x.id, n: x.blocks.filter((t) => !/^L\d+$/.test(t) || open.has(t)).length }))
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n || Number(a.id.slice(1)) - Number(b.id.slice(1)))
    .slice(0, 3);
}

/**
 * 回复最后一行「下一步」有没有点到清单上开着的项（spec D2）。清单上没有开着的项、或这一轮没写「下一步」时不管。
 * 返回要在下一轮说出来的问题，没有问题是 null。
 */
export function nextProblem(next, items, lang = 'zh') {
  const T = (zh, en) => pick(lang, zh, en);
  if (typeof next !== 'string' || !next.trim() || !Array.isArray(items)) return null;
  if (!items.some((x) => !CLOSED.has(x.status))) return null;
  const ids = [...next.matchAll(/(?<![A-Za-z0-9])L(\d+)(?!\d)/g)].map((m) => `L${m[1]}`);
  if (!ids.length) return T('上一轮的「下一步」没点清单上的编号', 'Last turn\'s "Next:" named no list ID');
  const openIds = ids.filter((id) => items.some((x) => x.id === id && !CLOSED.has(x.status)));
  if (!openIds.length) return T(`上一轮的「下一步」点的 ${ids.join('、')} 不是开着的项`, `Last turn's "Next:" named ${ids.join(', ')}, which is not open`);
  return null;
}

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
        + (x.blocks?.length ? ` (blocks ${x.blocks.join(', ')})` : '')
        + (x.basis && x.basis !== '预测' ? ` (basis: ${x.basis})` : '')
        + (x.approvedTurn ? ' (approved)' : '')
        + (idle >= staleAt(x) ? ` (untouched for ${idle} turns)` : '');
    }
    return `${x.id} ${label(x)}：${x.text}`
      + (x.blocks?.length ? `（挡着 ${x.blocks.join('、')}）` : '')
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
  const cands = blockCandidates(cur.items);
  if (cands.length) {
    tail.push(T(`按挡着的多少：${cands.map((c) => `${c.id}（挡着 ${c.n} 件）`).join('、')}`,
      `By what they block: ${cands.map((c) => `${c.id} (blocks ${c.n})`).join(', ')}`));
  }
  // 每条回复都带：短确认、系统信封开始的一轮也一样。
  tail.push(T(`回复末尾照写这一行（本轮有变化就先改好）：\n${inlineLine(open)}`, `End your reply with this line (update it first if the list changed this turn):\n${inlineLine(open, lang)}`));
  return { text: [head, ...lines, ...tail].join('\n'), shown: full ? { snap, turn: turnIndex } : lastShown, items: cur.items };
}
