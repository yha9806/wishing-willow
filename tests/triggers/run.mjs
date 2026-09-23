#!/usr/bin/env node
// 待触发清单的检查命令：node plugin/hooks/_triggers.mjs check <清单>
//
// 每轮的钩子只做格式层面的读取，挡着回车，不能去翻会话记录。检查命令是提交清单之前手动跑的那一道：
// 格式、触发条件、指向的对象、状态写法，以及「关闭」附的 uuid 是不是真在会话记录里、是不是作者发的。
// 纪律同 replay：先在没有这个命令的代码上跑出全红，再写实现。「通过」的用例也要看到通过那一行，
// 否则一个什么都不做、退出码为 0 的旧文件会让它们假装通过。

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'plugin', 'hooks', '_triggers.mjs');
const root = mkdtempSync(join(tmpdir(), 'willow-triggers-'));

// 合成的会话记录：一条作者消息、一条模型消息、一条插队进来的作者消息（queued_command）。
const U = '00000000-0000-4000-8000-0000000000a1';
const A = '00000000-0000-4000-8000-0000000000b2';
const Q = '00000000-0000-4000-8000-0000000000c3';
const E = '00000000-0000-4000-8000-0000000000d4';   // 后台通知：记录里 type 也是 user，但不是作者说的
const tdir = join(root, 'projects', 'p');
mkdirSync(tdir, { recursive: true });
writeFileSync(join(tdir, 's.jsonl'), [
  { type: 'user', uuid: U, message: { role: 'user', content: '可以，关掉它' } },
  { type: 'assistant', uuid: A, message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } },
  { type: 'attachment', uuid: Q, attachment: { type: 'queued_command', prompt: '这一条也关掉' } },
  { type: 'user', uuid: E, message: { role: 'user', content: '<task-notification>\n<status>completed</status>\n</task-notification>' } },
].map((r) => JSON.stringify(r)).join('\n') + '\n');
const ledger = join(root, 'risks.md');
writeFileSync(ledger, '## 风险 X1 合成台账条目\n来源：合成\n状态：未决\n');

const item = (id, o = {}) => [
  `## 待触发 ${id} 合成条目`,
  '来源：合成',
  o.ptr === null ? null : `指向：${o.ptr ?? 'example/repo#1'}`,
  '范围：全部',
  `什么时候出现：${o.when ?? '现在'}`,
  '消除它的证据：合成',
  `状态：${o.status ?? '未决'}`,
].filter((x) => x !== null).join('\n');

const cases = [
  ['good-list', [item('T1'), item('T2', { status: '进行中', ptr: `${ledger} X1` }), item('T3', { status: `已关闭 2026-09-20 — 作者 uuid ${U}` })], 0, ['清单检查：通过']],
  ['missing-pointer', [item('T1', { ptr: null })], 1, ['T1', '缺 指向']],
  ['unknown-trigger', [item('T1', { when: '等 某件事结束' })], 1, ['T1', '写法不认识']],
  ['closed-without-uuid', [item('T1', { status: '已关闭 2026-09-20' })], 1, ['T1', '作者 uuid']],
  ['closed-by-model', [item('T1', { status: `已关闭 2026-09-20 — 作者 uuid ${A}` })], 1, ['T1', '不是作者']],
  ['closed-by-queued-author', [item('T1', { status: `已关闭 2026-09-20 — 作者 uuid ${Q}` })], 0, ['清单检查：通过']],
  ['closed-by-envelope', [item('T1', { status: `已关闭 2026-09-20 — 作者 uuid ${E}` })], 1, ['T1', '不是作者']],
  ['closed-uuid-unknown', [item('T1', { status: '已关闭 2026-09-20 — 作者 uuid 00000000-0000-4000-8000-0000000000ff' })], 1, ['T1', '找不到']],
  ['ledger-pointer-missing-id', [item('T1', { ptr: `${ledger} X9` })], 1, ['T1', '指向', 'X9']],
  ['unknown-status', [item('T1', { status: '大概好了' })], 1, ['T1', '状态写法不认识']],
  ['bad-issue-pointer', [item('T1', { ptr: 'repo#x' })], 1, ['T1', '指向']],
];

const failures = [];
for (const [name, items, wantCode, wantText] of cases) {
  const file = join(root, `${name}.md`);
  writeFileSync(file, `# 合成清单\n\n${items.join('\n\n')}\n`);
  const r = spawnSync('node', [CLI, 'check', file], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, WILLOW_TRANSCRIPTS_DIR: join(root, 'projects') },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const bad = [];
  if (r.status !== wantCode) bad.push(`退出码期望 ${wantCode}，得到 ${r.status}`);
  for (const w of wantText) if (!out.includes(w)) bad.push(`输出里没有「${w}」`);
  console.log(`  ${bad.length ? '✗' : '✓'} ${name}`);
  for (const b of bad) failures.push(`${name} · ${b}${out.trim() ? `（输出：${out.trim().slice(0, 120)}）` : ''}`);
}
if (failures.length) {
  console.log(`\n  ${failures.length} 项失败：\n`);
  for (const f of failures) console.log(`    · ${f}`);
  process.exit(1);
}
console.log('\n  全部通过');
