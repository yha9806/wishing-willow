// 续接会话的清单继承（L35）。
//
// Claude Code 续接一场对话时会开一份新的聊天记录：旧消息原样抄过去，每一行的 sessionId 都改成新会话号，
// 消息的 uuid 不变（2026-09-27 实测：新记录前 1445 条消息的 uuid 全在旧记录里）。清单按会话号存，
// 于是新会话读到「没有清单」，刘海上开着的事也跟着消失。
//
// 这里只做一件事：新会话还没有自己的清单时，拿它聊天记录里第一条消息的 uuid，到同一个项目目录里
// 有清单的旧会话记录中去找；找到了，就把那份清单最后一份快照抄过来，写明继承自哪里，编号接着用。
// 每个会话查到有定论为止（结果记在状态里），自己已有清单时从不覆盖。
//
// 什么时候查：capture 每轮开头一次；还没定论时，listctl 写清单之前、结束钩子记这一轮的变化之前、压缩后重交清单之前各补查一次。
// 续接时 capture 可能比 Claude Code 抄旧消息还早（09-28 早 0.2 秒，10-06 早 73 毫秒），那一次读不到记录；
// 一轮很长、模型在轮中用命令记了清单，下一轮开头再查已经是「已有清单」，前身那份就再也接不上了（10-06 实见）。
//
// capture 挡着用户的回车，所以查法要便宜：
// - 新会话在第一轮时聊天记录里没有更早的消息，只读文件开头就能判定，不去翻别的文件；
// - 候选只看状态目录里有清单的会话，而且记录得在同一个项目目录下；
// - 抄来的消息落在旧记录的末段，所以从尾往前按块找，总共最多读 SCAN_BUDGET 字节。

import { openSync, readSync, closeSync, fstatSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { stateDir } from './_willow.mjs';
import { readList, listPath, appendSnapshot, appliedRows } from './_list.mjs';
import { pick } from './_lang.mjs';

const HEAD_BUDGET = 8 * 1024 * 1024;     // 找第一条消息最多读这么多（抄过来的文件快照行可能很大）
const SCAN_BUDGET = 1024 * 1024 * 1024;  // 在旧记录里找 uuid，所有候选加起来最多读这么多
const CHUNK = 8 * 1024 * 1024;
// 判「抄来的历史」：第一条消息比聊天记录文件建出来的时刻早这么多以上。新会话的第一条消息和文件差不多同时写下，
// 续接时抄过来的旧消息在文件出现之前早就有了。这个判据什么时候查都一样准，所以判成新会话（why=new）就是定论。
const COPIED_BEFORE_BIRTH_MS = 60 * 1000;
// 拿不到文件建立时刻（有的文件系统不记）才退回旧判据：第一条消息比这一刻早这么多才算抄来的。
// 它只在一轮开头准——补查点挪到轮末以后，第一轮超过五分钟的新会话也会被当成续接——所以那时判成新会话不算定论（why=fresh），下次再查。
const COPIED_AFTER_MS = 5 * 60 * 1000;
const MESSAGE_TYPES = new Set(['user', 'assistant', 'system']);

/** 聊天记录里第一条消息：{uuid, at}；没有就是 null。 */
function firstMessage(path) {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(Math.min(HEAD_BUDGET, fstatSync(fd).size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    let from = 0;
    while (from < text.length) {
      const end = text.indexOf('\n', from);
      if (end < 0) break;                       // 最后一行可能没写完，不认
      const line = text.slice(from, end);
      from = end + 1;
      if (!line.includes('"uuid"')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row?.uuid === 'string' && MESSAGE_TYPES.has(row.type)) {
        return { uuid: row.uuid, at: Date.parse(row.timestamp ?? '') };
      }
    }
    return null;
  } finally { closeSync(fd); }
}

/** 聊天记录文件建出来的时刻（毫秒）；拿不到是 null。 */
function bornAt(path) {
  try {
    const ms = statSync(path).birthtimeMs;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch { return null; }
}

/** 还没有定论：上次查的时候读不到记录，或拿不到建立时刻又还没满五分钟。这两种到下一个补查点再查。 */
export function inheritPending(li) {
  return !li || li.why === 'fresh' || li.why === 'no-transcript';
}

/** 继承后对模型说的那一句。 */
export function inheritedLine(from, lang) {
  return pick(lang, `这场对话是续接的：清单继承自会话 ${from}，编号接着用。`,
    `This conversation was resumed: the list is carried over from session ${from}, and the IDs continue.`);
}

/**
 * 补查点（listctl、结束钩子、压缩后）用：还没定论、自己也还没有清单时再查一次，返回新的结果；不用查就返回 null。
 * 出错也记成结果（why=error），不往外抛：清单出错不许拖垮调用它的那件事。
 */
export function retryInherit(sessionId, li, transcriptPath, turnIndex) {
  if (!inheritPending(li) || existsSync(listPath(sessionId))) return null;
  try { return inheritList(sessionId, transcriptPath, typeof turnIndex === 'number' ? turnIndex : null); } catch (e) {
    return { from: null, at: new Date().toISOString(), why: 'error', error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** 从尾往前按块找 needle；返回 {found, read}。块之间重叠 needle 的长度，跨块的也找得到。 */
function tailContains(path, needle, budget) {
  const pat = Buffer.from(needle);
  let fd;
  try { fd = openSync(path, 'r'); } catch { return { found: false, read: 0 }; }
  try {
    let end = fstatSync(fd).size;
    let read = 0;
    const buf = Buffer.alloc(CHUNK + pat.length);
    while (end > 0 && read < budget) {
      const start = Math.max(0, end - CHUNK);
      const len = Math.min(end + pat.length, fstatSync(fd).size) - start;
      const n = readSync(fd, buf, 0, len, start);
      read += n;
      if (buf.subarray(0, n).indexOf(pat) >= 0) return { found: true, read };
      end = start;
    }
    return { found: false, read };
  } finally { closeSync(fd); }
}

/**
 * 需要时继承前身的清单。返回记进状态的结果：{from, at, why}——from 是前身会话号，没继承就是 null。
 * turnIndex 是这一轮的轮次：旧清单里每项「几轮没动」按旧会话的轮次算，抄过来时整体平移到新会话的轮次上。
 */
export function inheritList(sessionId, transcriptPath, turnIndex, nowMs = Date.now()) {
  const at = new Date(nowMs).toISOString();
  if (existsSync(listPath(sessionId))) return { from: null, at, why: 'own-list' };
  if (typeof transcriptPath !== 'string' || !transcriptPath) return { from: null, at, why: 'no-transcript' };
  const first = firstMessage(transcriptPath);
  if (!first || !Number.isFinite(first.at)) return { from: null, at, why: 'fresh' };
  const born = bornAt(transcriptPath);
  if (born !== null) {
    if (!(first.at < born - COPIED_BEFORE_BIRTH_MS)) return { from: null, at, why: 'new' };
  } else if (!(first.at < nowMs - COPIED_AFTER_MS)) return { from: null, at, why: 'fresh' };

  const dir = stateDir();
  const projectDir = dirname(transcriptPath);
  const self = basename(transcriptPath);
  let names = [];
  try { names = readdirSync(dir); } catch { return { from: null, at, why: 'no-state-dir' }; }
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith('.list.jsonl')) continue;
    const sid = name.slice(0, -'.list.jsonl'.length);
    if (sid === sessionId) continue;
    const transcript = join(projectDir, `${sid}.jsonl`);
    if (`${sid}.jsonl` === self || !existsSync(transcript)) continue;
    let mtime = 0;
    try { mtime = statSync(join(dir, name)).mtimeMs; } catch { continue; }
    candidates.push({ sid, transcript, mtime });
  }
  // 连续续接过几次（甲→乙→丙）时，丙的第一条消息甲乙两份里都有；清单最近动过的那个是直接前身。
  candidates.sort((a, b) => b.mtime - a.mtime);

  let budget = SCAN_BUDGET;
  for (const c of candidates) {
    if (budget <= 0) return { from: null, at, why: 'budget' };
    const r = tailContains(c.transcript, `"uuid":"${first.uuid}"`, budget);
    budget -= r.read;
    if (!r.found) continue;
    const old = readList(c.sid);
    if (!old || old.error) return { from: null, at, why: 'predecessor-list-unreadable', predecessor: c.sid };
    const shift = typeof old.turnIndex === 'number' && typeof turnIndex === 'number' ? turnIndex - old.turnIndex : 0;
    const move = (v) => (typeof v === 'number' ? v + shift : v);
    const items = old.items.map((x) => ({ ...x, since: move(x.since), touched: move(x.touched) }));
    appendSnapshot(sessionId, {
      at,
      turnId: null,
      turnIndex,
      items,
      ...(old.unhooked ? { unhooked: old.unhooked } : {}),   // 写过「不挂」的稿件待做一起带过来
      changes: [],
      problems: [],
      // 旧会话执行过的消息照样不再执行：抄过来的消息 uuid 不变。
      rows: [...appliedRows(c.sid)],
      inheritedFrom: { sessionId: c.sid, turnIndex: old.turnIndex ?? null, at: old.at ?? null },
    });
    return { from: c.sid, at, why: 'inherited' };
  }
  return { from: null, at, why: 'no-predecessor' };
}
