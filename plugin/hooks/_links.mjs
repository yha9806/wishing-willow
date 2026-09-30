// 挂到别的对话的编号上（09-28：一项「等 AWT 会话」挂了 184 轮，那边早就带证据做完了，这边没有任何信号——
// 编号只在一场对话里算数，「等 X」只是一句话）。
//
// 一项等的是另一场对话里的一项时，写「等 <那场对话会话号的前 8 位> 的 L3：…」。每轮开头这里去读那场对话的清单：
// 那一项做完或撤掉了，就说一次（带证据或原因），说过的不再说；引用的会话在本机没有清单，也说一次。
// 那场对话续接成了新会话号（Claude Code 恢复对话会换号，清单由 _inherit.mjs 抄过去），顺着新清单第一份快照里的
// inheritedFrom 找过去，最多 MAX_HOPS 步。只读别的会话的文件，从不写。

import { readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './_willow.mjs';
import { readList } from './_list.mjs';
import { pick } from './_lang.mjs';

const MAX_HOPS = 5;
const CLOSED = new Set(['做完', '撤掉']);
// 「bbbbbbbb 的 L1」「bbbbbbbb-0000-… 的 L1」「bbbbbbbb's L1」
const LINK = /(?<![0-9a-f])([0-9a-f]{8})(?:-[0-9a-f-]{4,})?(?:\s*的|'s)?\s*(L\d+)(?!\d)/i;

/** 这一项挂着的另一场对话的编号：{session: 会话号前 8 位, id}；不是「等别的对话的一项」就是 null。 */
export function parseLink(item) {
  if (item?.status !== '等' || typeof item.wait !== 'string') return null;
  const m = LINK.exec(item.wait);
  return m ? { session: m[1].toLowerCase(), id: m[2].toUpperCase() } : null;
}

function listSessions() {
  try {
    return readdirSync(stateDir()).filter((f) => f.endsWith('.list.jsonl')).map((f) => f.slice(0, -'.list.jsonl'.length));
  } catch { return []; }
}

function mtime(sid) {
  try { return statSync(join(stateDir(), `${sid}.list.jsonl`)).mtimeMs; } catch { return 0; }
}

/** 一份清单的第一份快照（只读开头）：续接来的清单在这里写着 inheritedFrom。 */
function firstSnapshot(sid) {
  let fd;
  try {
    fd = openSync(join(stateDir(), `${sid}.list.jsonl`), 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    return JSON.parse(text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length));
  } catch { return null; } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* nothing to do */ } }
  }
}

/** 会话号前 8 位 → 现在管那份清单的会话（续接过就是最新的那一个）；本机没有是 null。 */
export function resolveSession(prefix, selfId) {
  const all = listSessions().filter((s) => s !== selfId);
  const latest = (xs) => xs.sort((a, b) => mtime(b) - mtime(a))[0] ?? null;
  let cur = latest(all.filter((s) => s.toLowerCase().startsWith(prefix)));
  for (let hop = 0; cur && hop < MAX_HOPS; hop++) {
    const next = latest(all.filter((s) => s !== cur && firstSnapshot(s)?.inheritedFrom?.sessionId === cur));
    if (!next) break;
    cur = next;
  }
  return cur;
}

/**
 * 这一轮要说的：挂着的那一项做完或撤掉了、或者引用的会话找不到。said 是 {本地编号: 上次说的结论}，同一结论只说一次；
 * 结论只记引用本身（会话号前 8 位与编号），不记续接后找到的会话号：那场对话换了号，同一件事不重说。
 * 返回 {lines, said}；said 只留还挂着的项。
 */
export function linkNews(items, selfId, said, lang = 'zh') {
  const T = (zh, en) => pick(lang, zh, en);
  const before = said && typeof said === 'object' ? said : {};
  const after = {};
  const lines = [];
  for (const it of items ?? []) {
    if (CLOSED.has(it.status)) continue;
    const link = parseLink(it);
    if (!link) continue;
    const sid = resolveSession(link.session, selfId);
    let key = null;
    let line = null;
    if (!sid) {
      key = `missing:${link.session}`;
      line = T(`${it.id} 等的会话 ${link.session} 在本机没有清单，挂不上：写对那场对话会话号的前 8 位，或改成普通的「等 X」`,
        `${it.id} waits on session ${link.session}, which has no list on this Mac: write the first 8 characters of that session's id, or make it a plain "waiting on X"`);
    } else {
      const cur = readList(sid);
      const target = cur && !cur.error ? (cur.items ?? []).find((x) => x.id === link.id) : null;
      if (cur && !cur.error && !target) {
        key = `absent:${link.session}:${link.id}`;
        line = T(`${it.id} 等的 ${link.session} 的 ${link.id} 在那边的清单上没有`,
          `${it.id} waits on ${link.session}'s ${link.id}, which is not on that list`);
      } else if (target?.status === '做完') {
        key = `done:${link.session}:${link.id}`;
        line = T(`${it.id} 等的 ${link.session} 的 ${link.id} 已做完（证据：${target.evidence || '没写'}）：这一项该做完、改状态或撤掉了`,
          `${link.session}'s ${link.id}, which ${it.id} waits on, is done (evidence: ${target.evidence || 'none given'}): finish, move or drop ${it.id}`);
      } else if (target?.status === '撤掉') {
        key = `dropped:${link.session}:${link.id}`;
        line = T(`${it.id} 等的 ${link.session} 的 ${link.id} 已撤掉（原因：${target.reason || '没写'}）：这一项还等不等，改状态或撤掉`,
          `${link.session}'s ${link.id}, which ${it.id} waits on, was dropped (reason: ${target.reason || 'none given'}): decide whether ${it.id} still waits`);
      }
    }
    if (key) {
      after[it.id] = key;
      if (before[it.id] !== key) lines.push(line);
    }
  }
  return { lines, said: after };
}

/** 提醒里那一句：这场对话的会话号，和怎样挂到别的对话的一项上。 */
export function selfLine(sessionId, lang = 'zh') {
  const short = String(sessionId).slice(0, 8);
  return pick(lang,
    `这场对话的会话号是 ${short}（前 8 位）。别的对话等你这边的一项：把会话号和编号告诉它；你等别的对话的一项：写「等 <它的会话号前 8 位> 的 L3：…」，那边做完或撤掉会在这里说。`,
    `This conversation's session id starts ${short}. Another conversation waiting on your item: give it this id and the number; you waiting on another's item: write "waiting on <its first 8 characters>'s L3: …" and you are told here when it is done or dropped.`);
}
