#!/usr/bin/env node
// 做完判据（ops-private spec 2026-10-07「清单项的做完判据」D1–D8）：写法怎么读、四种判据怎么核、
// 核查进程写什么、下一轮点名几次。
//
// 仓库名、路径、事项全是虚构的；联网的两种用假 gh（WILLOW_GH 指向这里现写的脚本），不碰真的 GitHub。
// 纪律同 replay：先在没有 _check.mjs 的旧代码上跑。kind 为 new 的断言新行为，旧代码上必须变红；
// guard 只防回归，旧代码上本来就绿，不能拿它们证明什么。

import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, utimesSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(HERE, '..', '..', 'plugin', 'hooks');
const STATE = mkdtempSync(join(tmpdir(), 'willow-check-'));
process.env.WILLOW_STATE_DIR = STATE;   // 在读进模块之前：stateDir() 每次现读环境变量，这里先设好

let mod = {};
try { mod = await import(pathToFileURL(join(HOOKS, '_check.mjs')).href); } catch (e) { console.log(`  （_check.mjs 读不进来：${e?.code ?? e?.message ?? e}）`); }
const list = await import(pathToFileURL(join(HOOKS, '_list.mjs')).href);
const missing = (name) => () => { throw new Error(`没有 ${name}`); };
const parseCheck = mod.parseCheck ?? missing('parseCheck');
const itemCheck = mod.itemCheck ?? missing('itemCheck');
const dueAtoms = mod.dueAtoms ?? missing('dueAtoms');
const runAtom = mod.runAtom ?? missing('runAtom');
const checkNews = mod.checkNews ?? missing('checkNews');
const startChecker = mod.startChecker ?? missing('startChecker');
const checksPath = mod.checksPath ?? ((sid) => join(STATE, `${sid}.checks`));

const failures = [];
function test(name, kind, fn) {
  let bad;
  try { bad = fn(); } catch (e) { bad = `抛错：${e?.message ?? e}`; }
  console.log(`  ${bad ? '✗' : '✓'} [${kind}] ${name}`);
  if (bad) failures.push(`${name} · ${bad}`);
}
async function testAsync(name, kind, fn) {
  let bad;
  try { bad = await fn(); } catch (e) { bad = `抛错：${e?.message ?? e}`; }
  console.log(`  ${bad ? '✗' : '✓'} [${kind}] ${name}`);
  if (bad) failures.push(`${name} · ${bad}`);
}
const eq = (got, want, what) => (JSON.stringify(got) === JSON.stringify(want) ? null : `${what}：要 ${JSON.stringify(want)}，得到 ${JSON.stringify(got)}`);

// ── 假 gh：按参数查表回话，每次调用记一行 ──
const GH_DIR = join(STATE, 'fake-gh');
mkdirSync(GH_DIR);
const GH = join(GH_DIR, 'gh');
writeFileSync(GH, `#!${process.execPath}
const fs = require('fs');
const dir = ${JSON.stringify(GH_DIR)};
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(dir + '/calls.log', args + '\\n');
const table = JSON.parse(fs.readFileSync(dir + '/responses.json', 'utf8'));
const r = table[args] || { code: 1, stderr: 'fake gh: no response for ' + args };
if (r.sleep) { const end = Date.now() + r.sleep; while (Date.now() < end) {} }
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.code || 0);
`);
chmodSync(GH, 0o755);
const pr = (n) => `pr view ${n} --repo synth/repo --json state,mergedAt`;
const cmp = (branch, sha) => `api repos/synth/repo/compare/${branch}...${sha} --jq .status`;
writeFileSync(join(GH_DIR, 'responses.json'), JSON.stringify({
  [pr(12)]: { stdout: '{"mergedAt":"2026-10-07T15:53:14Z","state":"MERGED"}\n' },
  [pr(13)]: { stdout: '{"mergedAt":null,"state":"OPEN"}\n' },
  [pr(14)]: { stdout: '{"mergedAt":null,"state":"CLOSED"}\n' },
  [pr(99)]: { code: 1, stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 99. (repository.pullRequest)\n' },
  [pr(77)]: { sleep: 3000, stdout: '{"mergedAt":"2026-10-07T00:00:00Z","state":"MERGED"}\n' },
  [cmp('main', 'abc1234')]: { stdout: 'behind\n' },
  [cmp('main', 'abc1235')]: { stdout: 'identical\n' },
  [cmp('main', 'abc1236')]: { stdout: 'diverged\n' },
  [cmp('feat/x', 'abc1237')]: { stdout: 'ahead\n' },
  [cmp('main', 'abc1238')]: { code: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: Not Found (HTTP 404)\n' },
}));
const calls = () => (existsSync(join(GH_DIR, 'calls.log')) ? readFileSync(join(GH_DIR, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);

console.log('\n  check · 写法\n');

// D1：新增行末尾的「（判据：…）」和依据、挡着、属于并列，先后不论。
test('add-tail', 'new', () => {
  const [o] = list.parseOps(['清单变化：\n+ 在做：合成事项甲（判据：合并 synth/repo#12）']);
  return eq([o?.op, o?.text, o?.check], ['add', '合成事项甲', '合并 synth/repo#12'], '新增');
});
test('add-tail-with-basis', 'new', () => {
  const [o] = list.parseOps(['清单变化：\n+ 等你：合成事项乙（判据：文件 ~/synth/a.md）（依据：合成提交）']);
  return eq([o?.text, o?.check, o?.basis], ['合成事项乙', '文件 ~/synth/a.md', '合成提交'], '新增');
});
test('add-without-check', 'guard', () => {
  const [o] = list.parseOps(['清单变化：\n+ 以后：合成事项丙（依据：合成说明）']);
  return eq([o?.text, o?.check ?? null, o?.basis], ['合成事项丙', null, '合成说明'], '新增');
});
test('op-set', 'new', () => {
  const [o] = list.parseOps(['清单变化：\nL3 判据：推到 synth/repo main abc1234']);
  return eq([o?.op, o?.id, o?.check], ['check', 'L3', '推到 synth/repo main abc1234'], '操作');
});
test('op-clear', 'new', () => {
  const [o] = list.parseOps(['清单变化：\nL3 判据：无']);
  return eq([o?.op, o?.id, o?.check], ['check', 'L3', null], '操作');
});
test('english', 'new', () => {
  const ops = list.parseOps(['List changes:\n+ Doing: synthetic item (check: merged synth/repo#3)\nL2 check: exited 4242']);
  return eq(ops.map((o) => [o.op, o.check]), [['add', 'merged synth/repo#3'], ['check', 'exited 4242']], '操作');
});

// D2：四种，参数按白名单校验；认不出的进 bad。
test('parse-kinds', 'new', () => {
  const r = parseCheck('`合并 Synth/Repo#12`；推到 synth/repo feat/x ABC1234；文件 /synth/a b.md; exited 4242');
  return eq([r.atoms.map((a) => a.key), r.bad], [[
    'merged:synth/repo#12', 'pushed:synth/repo@feat/x:abc1234', 'file:/synth/a b.md', 'exited:4242',
  ], []], '解析');
});
test('parse-tilde', 'new', () => {
  const r = parseCheck('file ~/synth/b.md');
  return r.atoms[0]?.path?.endsWith('/synth/b.md') && !r.atoms[0].path.startsWith('~') ? null : `~ 没展开：${JSON.stringify(r)}`;
});
test('parse-rejects', 'new', () => {
  const bad = ['跑 npm test', '合并 synth/repo#12 && rm -rf x', '推到 synth/repo ../x abc1234', '推到 synth/repo -x abc1234',
    '文件 relative/path', '进程退出 abc', '推到 synth/repo main zzzzzzz'];
  const got = bad.filter((t) => parseCheck(t).atoms.length !== 0 || parseCheck(t).bad.length !== 1);
  return got.length ? `这些不该认：${got.join(' ｜ ')}` : null;
});

console.log('\n  check · 应用到清单\n');

const turn = { turnId: 't1', turnIndex: 3 };
test('apply-stores-check', 'new', () => {
  const r = list.applyOps([], list.parseOps(['清单变化：\n+ 在做：合成事项甲（判据：合并 synth/repo#12）']), turn);
  return eq([r.items[0]?.text, r.items[0]?.check, r.problems], ['合成事项甲', '合并 synth/repo#12', []], '应用');
});
test('apply-unreadable-check', 'new', () => {
  const r = list.applyOps([], list.parseOps(['清单变化：\n+ 在做：合成事项甲（判据：作者看过）']), turn);
  return r.items[0]?.check === '作者看过' && r.problems.some((p) => p.includes('L1') && p.includes('机器核不了'))
    ? null : `应照记并报问题：${JSON.stringify(r)}`;
});
test('apply-set-and-clear', 'new', () => {
  const a = list.applyOps([{ id: 'L1', text: '合成', status: '在做', wait: null, touched: 1 }],
    list.parseOps(['清单变化：\nL1 判据：文件 /synth/a.md']), turn);
  const b = list.applyOps(a.items, list.parseOps(['清单变化：\nL1 判据：无']), turn);
  return eq([a.items[0].check, a.items[0].touched, 'check' in b.items[0]], ['文件 /synth/a.md', 3, false], '设与清');
});
// D6：带判据的项写做完，记现实里成立的时间、第一次核到的时间、写做完的时间。
const metCache = { v: 1, entries: { 'merged:synth/repo#12': { state: 'met', checkedAt: '2026-10-07T16:00:00.000Z', metAt: '2026-10-07T15:53:14Z', seenAt: '2026-10-07T16:00:00.000Z', detail: 'MERGED' } } };
const unmetCache = { v: 1, entries: { 'merged:synth/repo#12': { state: 'unmet', checkedAt: '2026-10-07T16:00:00.000Z', metAt: null, seenAt: null, detail: '还开着' } } };
const item = () => ({ id: 'L1', text: '合成', status: '在做', wait: null, touched: 1, check: '合并 synth/repo#12' });
test('done-stamps-times', 'new', () => {
  const r = list.applyOps([item()], list.parseOps(['清单变化：\nL1 做完：合成证据']), turn, 'zh', { checks: metCache, now: '2026-10-07T17:00:00.000Z' });
  const x = r.items[0];
  return eq([x.checkMetAt, x.checkSeenAt, x.doneAt, r.problems], ['2026-10-07T15:53:14Z', '2026-10-07T16:00:00.000Z', '2026-10-07T17:00:00.000Z', []], '做完');
});
// D8：写了做完、判据核到未满足：照记做完，报问题。缓存里的「未满足」是写做完之前核的，先当场再核一次（L11）。
const recheckForDone = mod.recheckForDone ?? missing('recheckForDone');
const unmetCache13 = { v: 1, entries: { 'merged:synth/repo#13': { state: 'unmet', checkedAt: '2026-10-07T16:00:00.000Z', metAt: null, seenAt: null, detail: 'open' } } };
const item13 = () => ({ ...item(), check: '合并 synth/repo#13' });
test('done-while-unmet', 'guard', () => {
  const r = list.applyOps([item13()], list.parseOps(['清单变化：\nL1 做完：合成证据']), turn, 'zh',
    { checks: unmetCache13, now: '2026-10-07T17:00:00.000Z', recheck: (it) => recheckForDone(it, unmetCache13, { gh: GH, net: true }) });
  return r.items[0].status === '做完' && r.problems.some((p) => p.includes('L1') && p.includes('未满足')) ? null : `应照记并报问题：${JSON.stringify(r)}`;
});
// 10-08 实见：推完、合完紧接着写做完，缓存还是推送前核的「未满足」，两次误报。重核后满足，不报，照 D6 记时间。
test('done-stale-unmet-rechecked', 'new', () => {
  const r = list.applyOps([item()], list.parseOps(['清单变化：\nL1 做完：合成证据']), turn, 'zh',
    { checks: unmetCache, now: '2026-10-07T17:00:00.000Z', recheck: (it) => recheckForDone(it, unmetCache, { gh: GH, net: true }) });
  return eq([r.problems, r.items[0].checkMetAt], [[], '2026-10-07T15:53:14Z'], '重核后满足');
});
// 一轮结束的钩子不同步调 gh：联网的那几条确认不了，不报，也不调 gh。
test('done-stale-unmet-hook-no-net', 'new', () => {
  const before = calls().length;
  const r = list.applyOps([item()], list.parseOps(['清单变化：\nL1 做完：合成证据']), turn, 'zh',
    { checks: unmetCache, now: '2026-10-07T17:00:00.000Z', recheck: (it) => recheckForDone(it, unmetCache, { gh: GH, net: false }) });
  return eq([r.problems, calls().length - before], [[], 0], '钩子里');
});
// 本机的判据便宜，钩子里也当场再核：文件写做完前刚出现，不报。
test('done-stale-unmet-file', 'new', () => {
  const f = join(STATE, 'synth-late.md');
  writeFileSync(f, '合成');
  const c = { v: 1, entries: { [`file:${f}`]: { state: 'unmet', checkedAt: '2026-10-07T16:00:00.000Z', metAt: null, seenAt: null, detail: 'missing' } } };
  const r = list.applyOps([{ ...item(), check: `文件 ${f}` }], list.parseOps(['清单变化：\nL1 做完：合成证据']), turn, 'zh',
    { checks: c, now: '2026-10-07T17:00:00.000Z', recheck: (it) => recheckForDone(it, c, { net: false }) });
  return eq(r.problems, [], '文件已出现');
});
test('done-without-check', 'guard', () => {
  const r = list.applyOps([{ id: 'L1', text: '合成', status: '在做', wait: null, touched: 1 }], list.parseOps(['清单变化：\nL1 做完：合成证据']), turn, 'zh', { checks: unmetCache });
  return eq([r.items[0].status, 'doneAt' in r.items[0], r.problems], ['做完', false, []], '做完');
});

console.log('\n  check · 状态与点名\n');

test('item-states', 'new', () => {
  const c = { v: 1, entries: {
    'merged:synth/repo#12': { state: 'met', metAt: '2026-10-07T15:53:14Z', seenAt: '2026-10-07T16:00:00.000Z' },
    'exited:4242': { state: 'unmet', detail: '还在跑' },
    'file:/synth/e': { state: 'error', detail: '合成错' },
  } };
  const s = (check) => itemCheck({ check }, c).state;
  return eq([s('合并 synth/repo#12'), s('合并 synth/repo#12；进程退出 4242'), s('合并 synth/repo#12；文件 /synth/e'),
    s('合并 synth/repo#12；文件 /synth/new'), s('作者看过'), s('合并 synth/repo#12；作者看过')],
  ['met', 'unmet', 'error', 'pending', 'manual', 'manual'], '状态');
});
test('nudge-once', 'new', () => {
  const items = [item()];
  const a = checkNews(items, metCache, null, 'zh');
  const b = checkNews(items, metCache, a.said, 'zh');
  const changed = checkNews([{ ...item(), check: '合并 synth/repo#12；文件 /synth/x' }], { v: 1, entries: { ...metCache.entries, 'file:/synth/x': { state: 'met' } } }, a.said, 'zh');
  return a.lines.length === 1 && a.lines[0].startsWith('L1 的判据已经满足') && a.lines[0].includes('L1 做完')
    && b.lines.length === 0 && changed.lines.length === 1 ? null : `${JSON.stringify([a, b, changed])}`;
});
test('nudge-skips-closed-and-unmet', 'new', () => {
  const a = checkNews([{ ...item(), status: '做完' }], metCache, null, 'zh');
  const b = checkNews([item()], unmetCache, null, 'zh');
  return a.lines.length === 0 && b.lines.length === 0 && eq(a.said, {}, 'said') === null ? null : JSON.stringify([a, b]);
});
test('nudge-english', 'new', () => {
  const a = checkNews([{ ...item(), check: 'merged synth/repo#12' }], metCache, null, 'en');
  return a.lines[0]?.startsWith("L1's check holds") ? null : JSON.stringify(a);
});

// D4：满足了不再核；没满足的联网 10 分钟、本机 1 分钟内不重核。
test('due-ttl', 'new', () => {
  const now = Date.parse('2026-10-07T16:20:00.000Z');
  const at = (min) => new Date(now - min * 60000).toISOString();
  const c = { v: 1, entries: {
    'merged:synth/repo#12': { state: 'met', checkedAt: at(60) },
    'merged:synth/repo#13': { state: 'unmet', checkedAt: at(5) },
    'merged:synth/repo#14': { state: 'unmet', checkedAt: at(11) },
    'file:/synth/a': { state: 'unmet', checkedAt: at(2) },
    'exited:4242': { state: 'unmet', checkedAt: at(0.5) },
  } };
  const items = [
    { id: 'L1', status: '在做', check: '合并 synth/repo#12；合并 synth/repo#13' },
    { id: 'L2', status: '等你', check: '合并 synth/repo#14；文件 /synth/a；进程退出 4242；推到 synth/repo main abc1234' },
    { id: 'L3', status: '做完', check: '合并 synth/repo#99' },
    { id: 'L4', status: '以后', check: '作者看过' },
  ];
  return eq(dueAtoms(items, c, now).map((a) => a.key).sort(),
    ['file:/synth/a', 'merged:synth/repo#14', 'pushed:synth/repo@main:abc1234'], '该核的');
});

console.log('\n  check · 四种怎么核（假 gh）\n');

const run = (text, opts = {}) => runAtom(parseCheck(text).atoms[0], { gh: GH, now: '2026-10-07T16:00:00.000Z', ...opts });
test('merged-met', 'new', () => { const e = run('合并 synth/repo#12'); return eq([e.state, e.metAt], ['met', '2026-10-07T15:53:14Z'], '合并'); });
test('merged-open', 'new', () => eq(run('合并 synth/repo#13').state, 'unmet', '开着'));
test('merged-closed', 'new', () => eq(run('合并 synth/repo#14').state, 'unmet', '关了没合'));
test('merged-missing-pr', 'new', () => eq(run('合并 synth/repo#99').state, 'error', '没有这个 PR'));
test('merged-timeout', 'new', () => { const e = run('合并 synth/repo#77', { timeoutMs: 400 }); return e.state === 'error' && e.detail === 'timeout' ? null : JSON.stringify(e); });
test('pushed-behind', 'new', () => eq([run('推到 synth/repo main abc1234').state, run('推到 synth/repo main abc1234').metAt], ['met', null], '推到'));
test('pushed-identical', 'new', () => eq(run('推到 synth/repo main abc1235').state, 'met', '推到'));
test('pushed-diverged', 'new', () => eq(run('推到 synth/repo main abc1236').state, 'unmet', '推到'));
test('pushed-ahead', 'new', () => eq(run('推到 synth/repo feat/x abc1237').state, 'unmet', '推到'));
test('pushed-404', 'new', () => eq(run('推到 synth/repo main abc1238').state, 'unmet', '404'));
test('no-gh', 'new', () => eq(run('合并 synth/repo#12', { gh: join(GH_DIR, 'no-such-gh') }).state, 'error', '没有 gh'));
const aFile = join(STATE, 'synth-done.md');
writeFileSync(aFile, '合成');
utimesSync(aFile, new Date('2026-10-07T12:00:00Z'), new Date('2026-10-07T12:00:00Z'));
test('file-met', 'new', () => { const e = run(`文件 ${aFile}`); return e.state === 'met' && typeof e.metAt === 'string' ? null : JSON.stringify(e); });
test('file-missing', 'new', () => eq(run(`文件 ${join(STATE, 'none.md')}`).state, 'unmet', '没有文件'));
test('exited-alive', 'new', () => eq(run(`进程退出 ${process.pid}`).state, 'unmet', '活着'));
const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim();
test('exited-dead', 'new', () => eq(run(`进程退出 ${dead}`).state, 'met', '已退出'));

console.log('\n  check · 核查进程\n');

// 一个带判据的会话：状态文件（listctl、readState 要它）和一份清单快照。
const SID = 'test-sess-check';
writeFileSync(join(STATE, `${SID}.json`), JSON.stringify({ schema: 19, sessionId: SID, pid: process.pid, turnIndex: 3, turnId: 't3' }));
writeFileSync(join(STATE, `${SID}.list.jsonl`), JSON.stringify({ at: '2026-10-07T16:00:00.000Z', turnId: 't3', turnIndex: 3, items: [
  { id: 'L1', text: '合成事项甲', status: '在做', wait: null, touched: 3, check: '合并 synth/repo#12' },
  { id: 'L2', text: '合成事项乙', status: '等你', wait: null, touched: 3, check: '合并 synth/repo#13' },
], changes: [], problems: [], rows: [] }) + '\n');
const env = { ...process.env, WILLOW_STATE_DIR: STATE, WILLOW_GH: GH };
const checkJs = join(HOOKS, 'check.mjs');
test('checker-writes', 'new', () => {
  const r = spawnSync(process.execPath, [checkJs, '--session', SID], { env, encoding: 'utf8' });
  if (r.status !== 0) return `退出码 ${r.status}：${r.stderr}`;
  const c = JSON.parse(readFileSync(checksPath(SID), 'utf8'));
  return eq([c.entries['merged:synth/repo#12']?.state, c.entries['merged:synth/repo#13']?.state], ['met', 'unmet'], '写下的');
});
test('checker-skips-fresh', 'new', () => {
  // 要先确认核查进程真的跑了：脚本不存在时 gh 调用次数也是 0（旧代码上这条曾经空转变绿）。
  const before = calls().length;
  const r = spawnSync(process.execPath, [checkJs, '--session', SID], { env, encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(checksPath(SID))) return `核查进程没跑成：退出码 ${r.status}`;
  return eq(calls().length - before, 0, '满足的不再核、没满足的 10 分钟内不重核，gh 调用次数');
});
test('checker-respects-lock', 'new', () => {
  const c = JSON.parse(readFileSync(checksPath(SID), 'utf8'));
  c.entries['merged:synth/repo#13'].checkedAt = '2026-01-01T00:00:00.000Z';   // 让它该核
  writeFileSync(checksPath(SID), JSON.stringify(c));
  writeFileSync(`${checksPath(SID)}.lock`, String(process.pid));
  const before = calls().length;
  spawnSync(process.execPath, [checkJs, '--session', SID], { env, encoding: 'utf8' });
  const n = calls().length - before;
  spawnSync('rm', ['-f', `${checksPath(SID)}.lock`]);
  return eq(n, 0, '锁着时 gh 调用次数');
});
test('checker-prunes-closed', 'new', () => {
  writeFileSync(join(STATE, `${SID}.list.jsonl`), JSON.stringify({ at: '2026-10-07T16:30:00.000Z', turnId: 't4', turnIndex: 4, items: [
    { id: 'L1', text: '合成事项甲', status: '做完', wait: null, touched: 4, check: '合并 synth/repo#12' },
    { id: 'L2', text: '合成事项乙', status: '等你', wait: null, touched: 3, check: '合并 synth/repo#13' },
  ], changes: [], problems: [], rows: [] }) + '\n', { flag: 'a' });
  spawnSync(process.execPath, [checkJs, '--session', SID], { env, encoding: 'utf8' });
  const c = JSON.parse(readFileSync(checksPath(SID), 'utf8'));
  return eq(Object.keys(c.entries).sort(), ['merged:synth/repo#13'], '留下的条目');
});
test('spawn-off', 'new', () => {
  const was = process.env.WILLOW_CHECK_SPAWN;
  process.env.WILLOW_CHECK_SPAWN = '0';
  try { return eq(startChecker(SID, [{ id: 'L9', status: '在做', check: '合并 synth/repo#13' }]), false, '关掉时'); } finally {
    if (was === undefined) delete process.env.WILLOW_CHECK_SPAWN; else process.env.WILLOW_CHECK_SPAWN = was;
  }
});
await testAsync('spawn-detached', 'new', async () => {
  const sid = 'test-sess-spawn';
  writeFileSync(join(STATE, `${sid}.list.jsonl`), JSON.stringify({ at: '2026-10-07T16:00:00.000Z', turnIndex: 1, items: [
    { id: 'L1', text: '合成', status: '在做', wait: null, touched: 1, check: '合并 synth/repo#12' }], changes: [], problems: [], rows: [] }) + '\n');
  process.env.WILLOW_GH = GH;
  const started = startChecker(sid, [{ id: 'L1', status: '在做', check: '合并 synth/repo#12' }]);
  if (started !== true) return `没起：${started}`;
  for (let i = 0; i < 50 && !existsSync(checksPath(sid)); i++) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(checksPath(sid))) return '5 秒内没写出结果';
  const c = JSON.parse(readFileSync(checksPath(sid), 'utf8'));
  return eq(c.entries['merged:synth/repo#12']?.state, 'met', '脱离的核查进程写下的');
});

// listctl 端到端：缓存里是推送前核的「未满足」，PR 其实已合；写做完不该报（L11 原样复现）。
test('listctl-done-after-merge', 'new', () => {
  const sid = 'test-sess-done';
  writeFileSync(join(STATE, `${sid}.json`), JSON.stringify({ schema: 19, sessionId: sid, pid: process.pid, turnIndex: 3, turnId: 't3' }));
  writeFileSync(join(STATE, `${sid}.list.jsonl`), JSON.stringify({ at: '2026-10-07T16:00:00.000Z', turnId: 't3', turnIndex: 3, items: [
    { id: 'L1', text: '合成事项甲', status: '等你', wait: null, touched: 3, check: '合并 synth/repo#12' }], changes: [], problems: [], rows: [] }) + '\n');
  writeFileSync(checksPath(sid), JSON.stringify(unmetCache));
  const r = spawnSync(process.execPath, [join(HOOKS, 'listctl.mjs'), '--session', sid, 'L1 做完：合成证据'],
    { env: { ...env, WILLOW_CHECK_SPAWN: '0' }, encoding: 'utf8' });
  return r.status === 0 && !`${r.stdout}${r.stderr}`.includes('未满足') ? null : `退出码 ${r.status}：${r.stdout}${r.stderr}`;
});

console.log('\n  check · 列清单\n');

test('listing-label', 'new', () => {
  const sid = 'test-sess-label';
  writeFileSync(join(STATE, `${sid}.list.jsonl`), JSON.stringify({ at: '2026-10-07T16:00:00.000Z', turnIndex: 1, items: [
    { id: 'L1', text: '合成事项甲', status: '在做', wait: null, touched: 1, check: '合并 synth/repo#12' },
    { id: 'L2', text: '合成事项乙', status: '在做', wait: null, touched: 1, check: '作者看过' },
    { id: 'L3', text: '合成事项丙', status: '在做', wait: null, touched: 1 }], changes: [], problems: [], rows: [] }) + '\n');
  writeFileSync(checksPath(sid), JSON.stringify(metCache));
  const t = list.listBlock(sid, 'full', 2, null, 'zh', []).text ?? '';
  const want = ['L1 在做：合成事项甲（判据：合并 synth/repo#12，已满足）', 'L2 在做：合成事项乙（判据：作者看过，人工判）', 'L3 在做：合成事项丙\n'];
  const miss = want.filter((w) => !t.includes(w));
  return miss.length ? `没有「${miss.join('」「')}」：${t}` : null;
});

if (failures.length) {
  console.log(`\n  ${failures.length} 项失败：\n`);
  for (const f of failures) console.log(`    · ${f}`);
  process.exit(1);
}
console.log('\n  全部通过');
