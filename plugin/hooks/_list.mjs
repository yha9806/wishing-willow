// 整场对话的长清单。
//
// 以前只有这一轮的「计划：」和一行「下一步：」，每轮重写，事项会不声不响地掉。现在清单跨轮留着：
// 模型只在清单有变化时，在回复末尾写一个「清单变化：」块，一行一条——
//   + 在做：… / + 等你：… / + 等 <什么>：… / + 以后：…（末尾可带「（依据：…）」，不带就是预测）
//   L3 做完：<证据>   L3 → <状态>[：说明]   L3 撤掉：<原因>   L3 挪到以后：<条件>   L3 认可
// 编号由这里分配。一项只能靠明写的一行离开清单；没提到的原样留着，所以「悄悄消失」在写法上就不会发生。
// 撤掉没写原因的不撤，做完没附证据的照记，引用了不存在的编号——都记为问题，下一轮说出来。
//
// 每轮有变化就往 <状态目录>/<会话>.list.jsonl 追加一行快照（{at, turnId, turnIndex, items, changes, problems}）。
// 不用 .json 结尾：app 把状态目录顶层的每个 .json 都当成一个会话。

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './_willow.mjs';

export const STALE_TURNS = 5;
const CLOSED = new Set(['做完', '撤掉']);
const STATUS = '(在做|等你|以后|等\\s*[^：:]+?)';
const ADD = new RegExp(`^\\+\\s*${STATUS}\\s*[：:]\\s*(.+)$`);
const DONE = /^(L\d+)\s*做完\s*(?:[：:]\s*(.*))?$/;
const MOVE = new RegExp(`^(L\\d+)\\s*(?:→|->)\\s*${STATUS}\\s*(?:[：:]\\s*(.*))?$`);
const DROP = /^(L\d+)\s*撤掉\s*(?:[：:]\s*(.*))?$/;
const LATER = /^(L\d+)\s*挪到以后\s*(?:[：:]\s*(.*))?$/;
const APPROVE = /^(L\d+)\s*认可\s*$/;
const HEAD = /^清单变化\s*[：:]\s*$/;
const BASIS = /[（(]\s*依据\s*[：:]\s*([^）)]+)[）)]\s*$/;

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

function status(s) {
  const t = s.trim();
  if (t === '在做' || t === '等你' || t === '以后') return { status: t, wait: null };
  return { status: '等', wait: t.replace(/^等\s*/, '') };
}

/** 从这一轮的文字里取出所有「清单变化：」块里的行，按出现顺序。块在空行、「下一步：」或一行不认识的字处结束。 */
export function parseOps(texts) {
  const ops = [];
  for (const text of texts ?? []) {
    if (typeof text !== 'string') continue;
    let inBlock = false;
    for (const raw of text.split('\n')) {
      const line = raw.trim().replace(/^[-*]\s+/, '');
      if (HEAD.test(line)) { inBlock = true; continue; }
      if (!inBlock) continue;
      let m;
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
    }
  }
  return ops;
}

/** 把一轮的操作应用到上一份快照上。turn = {turnId, turnIndex}。 */
export function applyOps(prevItems, ops, turn) {
  const items = (prevItems ?? []).map((x) => ({ ...x }));
  const changes = [];
  const problems = [];
  let next = items.reduce((n, x) => Math.max(n, Number(String(x.id).slice(1)) || 0), 0) + 1;
  const find = (id) => items.find((x) => x.id === id);
  for (const o of ops) {
    if (o.op === 'bad') { problems.push(`看不懂这一行：${o.line}`); continue; }
    if (o.op === 'add') {
      const id = `L${next++}`;
      items.push({ id, text: o.text, status: o.status, wait: o.wait, basis: o.basis,
        sourceTurn: turn.turnId ?? null, since: turn.turnIndex ?? null, touched: turn.turnIndex ?? null });
      changes.push(`新增 ${id}`);
      continue;
    }
    const it = find(o.id);
    if (!it) { problems.push(`${o.id} 不存在`); continue; }
    if (o.op === 'approve') { it.approvedTurn = turn.turnId ?? null; changes.push(`${o.id} 认可`); continue; }
    if (o.op === 'drop' && !o.note) { problems.push(`${o.id} 撤掉没写原因，没撤`); continue; }
    if (o.op === 'done' && !o.note) problems.push(`${o.id} 做完没附证据`);
    if (o.op === 'done') { it.status = '做完'; it.wait = null; it.evidence = o.note || null; }
    else if (o.op === 'drop') { it.status = '撤掉'; it.wait = null; it.reason = o.note; }
    else { it.status = o.status; it.wait = o.wait; if (o.note) it.note = o.note; }
    it.touched = turn.turnIndex ?? it.touched;
    changes.push(`${o.id} ${it.status === '等' ? `等 ${it.wait}` : it.status}`);
  }
  return { items, changes, problems };
}

export function appendSnapshot(sessionId, snap) {
  appendFileSync(listPath(sessionId), JSON.stringify(snap) + '\n');
}

function label(x) {
  return x.status === '等' ? `等 ${x.wait}` : x.status;
}

const brief = (t, n = 12) => (t.length > n ? t.slice(0, n) + '…' : t);

/**
 * 回复里的那一行清单（作者 09-24：「每次回复应该有一个 inline 的 todolist」）。钩子写好，模型照抄——
 * 让模型从十几项里自己摘，摘法每轮会不一样；照抄一行，本轮有变化再改。
 */
export function inlineLine(open) {
  const by = (st) => open.filter((x) => x.status === st);
  const parts = [];
  const doing = by('在做');
  if (doing.length) {
    parts.push('◧ 在做 ' + doing.slice(0, 2).map((x) => `${x.id} ${brief(x.text)}`).join('、')
      + (doing.length > 2 ? ` 等 ${doing.length} 项` : ''));
  }
  const you = by('等你');
  if (you.length) {
    parts.push(`□ 等你 ${you.length}：` + you.slice(0, 2).map((x) => `${x.id} ${brief(x.text)}`).join('、') + (you.length > 2 ? '…' : ''));
  }
  const other = by('等');
  if (other.length) parts.push(`⬚ 等别的 ${other.length}`);
  const later = by('以后');
  if (later.length) parts.push(`▫ 以后 ${later.length}`);
  return parts.length ? '清单：' + parts.join(' ｜ ') : '清单：没有开着的事';
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
export function listBlock(sessionId, mode, turnIndex, lastShown = null) {
  const cur = readList(sessionId);
  if (cur === null) return { text: null, shown: lastShown };
  if (cur.error) return { text: `【Wishing-Willow · 清单】清单文件读不出（${cur.error}），不能当作没有开着的事。`, shown: lastShown };
  const snap = `${cur.turnIndex ?? ''}@${cur.at ?? ''}`;
  const full = mode === 'full' && (!lastShown || lastShown.snap !== snap
    || typeof lastShown.turn !== 'number' || typeof turnIndex !== 'number' || turnIndex - lastShown.turn >= REFRESH_TURNS);
  const open = cur.items.filter((x) => !CLOSED.has(x.status));
  const idleOf = (x) => (x.status === '在做' && typeof turnIndex === 'number' && typeof x.touched === 'number'
    ? turnIndex - x.touched : 0);
  const shownItems = full ? open : open.filter((x) => x.status === '等你' || (mode === 'full' && idleOf(x) >= STALE_TURNS));
  const lines = shownItems.map((x) => {
    const idle = idleOf(x);
    return `${x.id} ${label(x)}：${x.text}`
      + (x.basis && x.basis !== '预测' ? `（依据：${x.basis}）` : '')
      + (x.approvedTurn ? '（已认可）' : '')
      + (idle >= STALE_TURNS ? `（${idle} 轮没动）` : '');
  });
  const problems = Array.isArray(cur.problems) ? cur.problems : [];
  const rest = open.length - shownItems.length;
  const count = (st) => open.filter((x) => x.status === st).length;
  const head = `【Wishing-Willow · 清单】开着 ${open.length} 项（等你 ${count('等你')}、在做 ${count('在做')}、`
    + `等别的 ${count('等')}、以后 ${count('以后')}）。编号给「清单变化：」用；清单只在本机，别抄进公开仓。`;
  const tail = [];
  if (!full && mode === 'full' && rest > 0) tail.push(`其余 ${rest} 项和第 ${lastShown.turn} 轮列出的一样。`);
  if (problems.length) tail.push(`上一次清单变化的问题：${problems.join('；')}`);
  // 每条回复都带：短确认、系统信封开始的一轮也一样。
  tail.push(`回复末尾照写这一行（本轮有变化就先改好）：\n${inlineLine(open)}`);
  return { text: [head, ...lines, ...tail].join('\n'), shown: full ? { snap, turn: turnIndex } : lastShown };
}
