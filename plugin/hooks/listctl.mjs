#!/usr/bin/env node
// 一轮中途改清单：node listctl.mjs --session <会话号> "<一行>" ["<一行>" …]
// （测试与脚本也可以不带参数，从 stdin 喂 {"session_id": …, "lines": […]}。）
//
// 一行的写法和回复末尾「清单变化：」里的一样（_list.mjs parseOps）。命令一跑就追加一份快照，
// 刘海不用等这一轮结束；快照记下 via = 'command' 和原样的行，同一轮回复末尾再写一遍时 extract 跳过。
// 只改已有会话的清单：会话号对不上就不写——写错一个号会凭空多出一张清单。

import { readFileSync } from 'node:fs';
import { readState } from './_willow.mjs';
import { parseOps, applyOps, readList, appendSnapshot, inlineLine } from './_list.mjs';
import { sessionLang, pick } from './_lang.mjs';

// 回话的语言：会话记下的；还没读到会话时按系统语言。
let lang = sessionLang(null);
const T = (zh, en) => pick(lang, zh, en);

function fail(msg, code = 2) {
  process.stderr.write(`listctl：${msg}\n`);
  process.exit(code);
}

let sessionId = null;
let lines = [];
const argv = process.argv.slice(2);
if (argv.length) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--session') { sessionId = argv[i + 1] ?? null; i += 1; } else lines.push(argv[i]);
  }
} else {
  try {
    const o = JSON.parse(readFileSync(0, 'utf8'));
    sessionId = typeof o?.session_id === 'string' ? o.session_id : null;
    lines = Array.isArray(o?.lines) ? o.lines.filter((x) => typeof x === 'string') : [];
  } catch { fail(T('没有参数，stdin 也不是 {session_id, lines}', 'no arguments, and stdin is not {session_id, lines}')); }
}
lines = lines.flatMap((l) => l.split('\n')).map((l) => l.trim()).filter(Boolean);

if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) fail(T('要 --session <会话号>', 'needs --session <session id>'));
if (!lines.length) fail(T('没有要记的行', 'no lines to record'));
const prev = readState(sessionId);
if (!prev) fail(T(`没有这个会话：${sessionId}`, `no such session: ${sessionId}`));
lang = sessionLang(prev);

// 一行一块地读：parseOps 在认不出的行处结束一个块，多行拼成一块时一行写错会连带丢掉后面的。
const ops = parseOps(lines.map((l) => `清单变化：\n${l}`));   // 块头两种语言都认，这里用哪个都一样
const known = ops.filter((o) => o.op !== 'bad');
if (ops.length < lines.length) {
  // 把没读到的那几行照实说出来，别让模型以为记上了。
  const seen = new Set(ops.map((o) => o.raw));
  const missed = lines.filter((l) => !seen.has(l.replace(/^[-*]\s+/, '')));
  if (missed.length) process.stderr.write(T(`listctl：这几行不是清单变化，没记：${missed.join(' ｜ ')}\n`, `listctl: not list changes, not recorded: ${missed.join(' | ')}\n`));
}
if (!ops.length) fail(T('没有认得的清单变化', 'no list changes it could read'));

const cur = readList(sessionId);
if (cur?.error) fail(T(`清单文件读不出（${cur.error}），没写——拿空清单盖掉它比读不出更糟`, `the list file can't be read (${cur.error}); nothing written — overwriting it with an empty list would be worse`), 1);

const turn = { turnId: prev.turnId ?? null, turnIndex: prev.turnIndex ?? null };
const r = applyOps(cur?.items, ops, turn, lang);
appendSnapshot(sessionId, {
  at: new Date().toISOString(), ...turn, ...r, rows: [], via: 'command', lines: known.map((o) => o.raw),
});
const open = r.items.filter((x) => x.status !== '做完' && x.status !== '撤掉');
process.stdout.write([
  r.changes.length ? T(`记下了：${r.changes.join('、')}`, `Recorded: ${r.changes.join(', ')}`) : T('没有改动', 'No change'),
  r.problems.length ? T(`问题：${r.problems.join('；')}`, `Problems: ${r.problems.join('; ')}`) : null,
  inlineLine(open, lang),
].filter(Boolean).join('\n') + '\n');
process.exit(r.problems.length ? 1 : 0);
