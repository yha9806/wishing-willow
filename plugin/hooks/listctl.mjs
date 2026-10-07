#!/usr/bin/env node
// 一轮中途改清单：node listctl.mjs --session <会话号> "<一行>" ["<一行>" …]
// （测试与脚本也可以不带参数，从 stdin 喂 {"session_id": …, "lines": […]}。）
//
// 一行的写法和回复末尾「清单变化：」里的一样（_list.mjs parseOps）。命令一跑就追加一份快照，
// 刘海不用等这一轮结束；快照记下 via = 'command' 和原样的行，同一轮回复末尾再写一遍时 extract 跳过。
// 只改已有会话的清单：会话号对不上就不写——写错一个号会凭空多出一张清单。
//
// node listctl.mjs --session <会话号> --hookup-preview [--inbox <目录>]：开对号之前，看这场对话现在会报出哪几行
// （spec「稿件待做挂上对话清单」D4）。只读，不管开关；--inbox 换一个留言目录（写作循环那边的改动还没装上时，用它生成的留言）。

import { readFileSync } from 'node:fs';
import { readState, writeState } from './_willow.mjs';
import { parseOps, applyOps, readList, appendSnapshot, inlineLine, hookupCheck } from './_list.mjs';
import { hookupNotes } from './_inbox.mjs';
import { sessionLang, pick } from './_lang.mjs';
import { retryInherit, inheritedLine } from './_inherit.mjs';
import { readChecks, startChecker } from './_check.mjs';

// 回话的语言：会话记下的；还没读到会话时按系统语言。
let lang = sessionLang(null);
const T = (zh, en) => pick(lang, zh, en);

function fail(msg, code = 2) {
  process.stderr.write(`listctl：${msg}\n`);
  process.exit(code);
}

let sessionId = null;
// --by author：作者在 lintel 面板里点的（app 代为调用，spec 清单实时 C）。快照记 via = 'author'，下一轮告诉模型。
let by = null;
let lines = [];
let preview = false;
let inboxDir = null;
const argv = process.argv.slice(2);
if (argv.length) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--session') { sessionId = argv[i + 1] ?? null; i += 1; } else if (argv[i] === '--by') { by = argv[i + 1] ?? null; i += 1; }
    else if (argv[i] === '--hookup-preview') preview = true;
    else if (argv[i] === '--inbox') { inboxDir = argv[i + 1] ?? null; i += 1; } else lines.push(argv[i]);
  }
} else {
  try {
    const o = JSON.parse(readFileSync(0, 'utf8'));
    sessionId = typeof o?.session_id === 'string' ? o.session_id : null;
    lines = Array.isArray(o?.lines) ? o.lines.filter((x) => typeof x === 'string') : [];
    by = typeof o?.by === 'string' ? o.by : null;
  } catch { fail(T('没有参数，stdin 也不是 {session_id, lines}', 'no arguments, and stdin is not {session_id, lines}')); }
}
lines = lines.flatMap((l) => l.split('\n')).map((l) => l.trim()).filter(Boolean);

if (by !== null && by !== 'author') fail(T('--by 只认 author', '--by only accepts author'));
if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) fail(T('要 --session <会话号>', 'needs --session <session id>'));
if (!preview && !lines.length) fail(T('没有要记的行', 'no lines to record'));
const prev = readState(sessionId);
if (!prev) fail(T(`没有这个会话：${sessionId}`, `no such session: ${sessionId}`));
lang = sessionLang(prev);

if (preview) {
  const ms = hookupNotes(sessionId, { dir: inboxDir ?? undefined, anySwitch: true });
  if (!ms.length) {
    process.stdout.write(T('这场对话没有带待做的稿件留言（要本会话是那篇稿子的改稿会话、留言里有 todo），开了也不会说什么。\n',
      'No manuscript note with to-do items for this conversation (it must be the manuscript\'s own conversation and the note must carry todo); turning it on would say nothing.\n'));
    process.exit(0);
  }
  const cur = readList(sessionId);
  if (cur?.error) fail(T(`清单文件读不出（${cur.error}）`, `the list file can't be read (${cur.error})`), 1);
  const said = hookupCheck(cur?.items ?? [], ms, cur?.unhooked, lang).lines(true);
  process.stdout.write((said.length ? said.join('\n') : T('开着的待做都挂上了，也没有对不上的：开了这一轮什么也不说。', 'Every open item is hooked up and nothing mismatches: turning it on would say nothing now.')) + '\n');
  process.exit(0);
}

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

// 续接时 capture 比抄旧消息还早、清单还没接上：先接上前身的清单，再记这次的改动——不然这一条命令就成了
// 本会话自己的清单，以后再也接不上（10-06 实见：一轮里先用命令记了清单，前身的清单整份没接上，模型只好凭记忆重建）。
// 命令的输出就是对模型说了；作者在面板里点的（--by author）模型没看见，记 told: false，留给下一轮开头说。
let inheritedFrom = null;
const li = retryInherit(sessionId, prev.listInherit ?? null, prev.transcriptPath, prev.turnIndex);
if (li) {
  writeState(sessionId, { ...prev, listInherit: li.from && by === 'author' ? { ...li, told: false } : li });
  inheritedFrom = li.from;
}

const cur = readList(sessionId);
if (cur?.error) fail(T(`清单文件读不出（${cur.error}），没写——拿空清单盖掉它比读不出更糟`, `the list file can't be read (${cur.error}); nothing written — overwriting it with an empty list would be worse`), 1);

const turn = { turnId: prev.turnId ?? null, turnIndex: prev.turnIndex ?? null };
// 开了对号的稿件：「属于」「不挂」写的编号对它们核（spec「稿件待做挂上对话清单」D2）。
const at = new Date().toISOString();
const r = applyOps(cur?.items, ops, turn, lang, { manuscripts: hookupNotes(sessionId), unhooked: cur?.unhooked, checks: readChecks(sessionId), now: at });
appendSnapshot(sessionId, {
  at, ...turn, ...r, rows: [], via: by === 'author' ? 'author' : 'command', lines: known.map((o) => o.raw),
});
const open = r.items.filter((x) => x.status !== '做完' && x.status !== '撤掉');
// 记了判据就起核查进程，结果在下一轮开头之前多半已经写好（_check.mjs）。
try { if (open.some((x) => x.check)) startChecker(sessionId, open); } catch { /* 不核 */ }
process.stdout.write([
  inheritedFrom ? inheritedLine(inheritedFrom, lang) : null,
  r.changes.length ? T(`记下了：${r.changes.join('、')}`, `Recorded: ${r.changes.join(', ')}`) : T('没有改动', 'No change'),
  r.problems.length ? T(`问题：${r.problems.join('；')}`, `Problems: ${r.problems.join('; ')}`) : null,
  inlineLine(open, lang),
].filter(Boolean).join('\n') + '\n');
process.exit(r.problems.length ? 1 : 0);
