#!/usr/bin/env node
// 核查进程：node check.mjs --session <会话号>
//
// 一轮结束的钩子和 listctl 起它（_check.mjs startChecker，脱离、不等它），也可以手跑。它读这个会话的清单，
// 把开着的项里该核的判据核一遍（_check.mjs dueAtoms、runAtom），结果写进 <会话>.checks，下一轮开头 capture 读。
//
// 同一会话同时只跑一个（锁文件，LOCK_STALE_MS 后算过期）。一次最多 RUN_BUDGET_MS，超出的下次再核。
// 不写日志：结果文件只留开着的项还用得到的条目（全局〈十五〉）。

import { openSync, closeSync, writeSync, unlinkSync, statSync } from 'node:fs';
import { readList } from './_list.mjs';
import { parseCheck, readChecks, writeChecks, dueAtoms, runAtom, checksPath, LOCK_STALE_MS, RUN_BUDGET_MS } from './_check.mjs';

const CLOSED = new Set(['做完', '撤掉']);

const argv = process.argv.slice(2);
const i = argv.indexOf('--session');
const sessionId = i >= 0 ? argv[i + 1] : null;
if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
  process.stderr.write('check：要 --session <会话号>\n');
  process.exit(2);
}

const lock = `${checksPath(sessionId)}.lock`;
function takeLock() {
  try {
    const fd = openSync(lock, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (e) {
    if (e?.code !== 'EEXIST') return false;
    try { if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return false; unlinkSync(lock); } catch { return false; }
    return takeLock();
  }
}

if (!takeLock()) process.exit(0);   // 另一个核查进程在跑
try {
  // 没有清单或读不出：不核，也不动旧结果。不在这里 process.exit：那样 finally 不跑，锁会留下。
  const cur = readList(sessionId);
  if (cur && !cur.error) run(cur);
} finally {
  try { unlinkSync(lock); } catch { /* 已经没了 */ }
}
process.exit(0);

function run(cur) {
  const open = (cur.items ?? []).filter((x) => !CLOSED.has(x.status));
  const cache = readChecks(sessionId);
  const started = Date.now();
  for (const atom of dueAtoms(open, cache, started)) {
    if (Date.now() - started > RUN_BUDGET_MS) break;
    const prev = cache.entries[atom.key];
    const e = runAtom(atom);
    // 第一次核到满足的时刻（D6 的 checkSeenAt）；满足的不再核，所以它就是这一次。
    cache.entries[atom.key] = { ...e, seenAt: e.state === 'met' ? (prev?.seenAt ?? e.checkedAt) : null };
  }
  // 只留开着的项还用得到的条目：项关了或判据改了，旧条目在这里删掉（D4）。
  const keep = new Set(open.flatMap((x) => parseCheck(x.check).atoms.map((a) => a.key)));
  for (const k of Object.keys(cache.entries)) if (!keep.has(k)) delete cache.entries[k];
  writeChecks(sessionId, { v: 1, at: new Date().toISOString(), entries: cache.entries });
}
