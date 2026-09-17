#!/usr/bin/env node
// Runtime runner — 第三关。
//
// 前两关的共同盲区：fixture 是照官方文档手写的，代码也是照官方文档写的。
// 文档写 `user_prompt`，而 2.1.252 的二进制里发的是 `prompt` ——
// 两边错得一模一样，于是测试永远绿，插件永远收不到 prompt。
//
// 这一关不信文档，也不信 fixture：**从本机装着的 claude 可执行文件里，
// 把 UserPromptSubmit 载荷的字段名抠出来**，用那个名字构造输入，
// 再照 hooks.json 写的命令跑一次，看 prompt 有没有被逐字存下。
//
// 找不到 claude 时输出 SKIP 并单独计数——绝不混进通过数里。
// （"没有输出"在验证语境里天然被读作"没问题"，那是最危险的失败模式。）

import { readFileSync, existsSync, realpathSync, mkdtempSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const PLUGIN_ROOT = join(REPO, 'plugin');
const HOOKS_JSON = join(PLUGIN_ROOT, 'hooks', 'hooks.json');

const failures = [];
let skipped = 0;

function check(label, ok, detail) {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`    ${ok ? '·' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
  return ok;
}
function skip(label, why) {
  skipped += 1;
  console.log(`    ⊘ SKIP ${label}  (${why})`);
}

console.log('\n  runtime · 字段名对齐实际运行时\n');

/** 本机装着的 claude 可执行文件；找不到返回 null。 */
function findClaude() {
  const w = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
  if (w.status !== 0) return null;
  let p = w.stdout.trim();
  if (!p) return null;
  try { p = realpathSync(p); } catch { /* 不是链接就用原路径 */ }
  return existsSync(p) ? p : null;
}

/**
 * 从二进制里抠出 UserPromptSubmit 载荷在 hook_event_name 之后带的键名。
 * 打包后的代码形如 `hook_event_name:"UserPromptSubmit",prompt:r,...`。
 */
function payloadKeys(bin, event) {
  const r = spawnSync(
    'grep',
    ['-a', '-o', '-E', `hook_event_name:"${event}",.{0,160}`, bin],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }
  );
  if (r.status !== 0 || !r.stdout) return [];
  const keys = new Set();
  for (const m of r.stdout.split('\n')) {
    const tail = m.slice(m.indexOf('",') + 2);
    for (const k of tail.matchAll(/(?:^|[,{])([a-z][a-z0-9_]*):/g)) keys.add(k[1]);
  }
  return [...keys];
}

/** 每个 hook 载荷都带的公共字段，同样从二进制里取。 */
function baseKeys(bin) {
  const r = spawnSync(
    'grep', ['-a', '-o', '-E', 'return\\{session_id:e\\.id,.{0,200}', bin],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }
  );
  if (r.status !== 0 || !r.stdout) return [];
  const keys = new Set();
  for (const m of r.stdout.split('\n')) {
    for (const k of m.matchAll(/(?:^return\{|[,{])([a-z][a-z0-9_]*):/g)) keys.add(k[1]);
  }
  return [...keys];
}

const bin = findClaude();
if (!bin) {
  skip('从 claude 二进制取真实字段名', '本机找不到 claude');
  skip('照 hooks.json 用真实字段名跑一次', '本机找不到 claude');
} else {
  console.log(`    claude: ${bin}\n`);
  const keys = payloadKeys(bin, 'UserPromptSubmit');

  // 候选名。二进制里出现哪一个，就用哪一个 —— 不由这个文件决定谁是对的。
  const CANDIDATES = ['prompt', 'user_prompt', 'user_prompt_raw', 'user_message', 'message'];
  const found = CANDIDATES.filter((c) => keys.includes(c));

  check(
    'UserPromptSubmit 载荷里找得到承载用户原话的字段',
    found.length > 0,
    keys.length ? `载荷键：${keys.join(', ')}` : '二进制里没匹配到载荷构造（打包格式可能变了）'
  );

  if (found.length > 0) {
    const field = found[0];
    console.log(`    实际字段名：${field}\n`);

    const cfg = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
    const entry = (cfg.hooks?.UserPromptSubmit ?? []).flatMap((m) => m.hooks ?? [])[0];

    if (!entry?.command) {
      check('hooks.json 里有 UserPromptSubmit 的 command', false);
    } else {
      const stateDir = mkdtempSync(join(tmpdir(), 'willow-runtime-'));
      const PROMPT = '用运行时真实的字段名喂一次，确认 prompt 被逐字存下来了。';
      const input = JSON.stringify({
        session_id: 'runtime-probe',
        hook_event_name: 'UserPromptSubmit',
        [field]: PROMPT,
        cwd: REPO,
        prompt_id: '00000000-0000-4000-8000-0000000000ff',
        permission_mode: 'default',
      });

      const resolved = entry.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT);
      const r = spawnSync(resolved, {
        shell: true,
        input,
        env: { ...process.env, WILLOW_STATE_DIR: stateDir, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
        encoding: 'utf8',
        timeout: 10_000,
      });

      check(`用 ${field} 喂入后 exit 0`, r.status === 0, `exit=${r.status}`);

      const files = existsSync(stateDir) ? readdirSync(stateDir).filter((f) => f.endsWith('.json')) : [];
      const st = files.length === 1 ? JSON.parse(readFileSync(join(stateDir, files[0]), 'utf8')) : null;

      check('状态文件被写出来了', files.length === 1, `实际 ${files.length} 个`);
      check(
        `prompt 逐字保存（字段 ${field}）`,
        st?.prompt === PROMPT,
        st ? `实际 ${JSON.stringify(st.prompt)}` : '没有状态文件'
      );
    }
  }
}

// Stop 侧同样求一次真值：extract.mjs 读的是 last_assistant_message。
if (bin) {
  const stopKeys = payloadKeys(bin, 'Stop');
  check(
    'Stop 载荷里有 last_assistant_message',
    stopKeys.includes('last_assistant_message'),
    stopKeys.length ? `载荷键：${stopKeys.join(', ')}` : '二进制里没匹配到 Stop 载荷构造'
  );
}

// SessionEnd 同样求一次真值：end.mjs 依赖它在会话结束时真的会发。
if (bin) {
  const endKeys = payloadKeys(bin, 'SessionEnd');
  check(
    '运行时会发 SessionEnd（载荷带 reason）',
    endKeys.includes('reason'),
    endKeys.length ? `载荷键：${endKeys.join(', ')}` : '二进制里没匹配到 SessionEnd 载荷构造'
  );
}

// ── fixture 不得比运行时更丰富 ────────────────────────────────────
// 文档列了 scratchpad_dir / prompt_start_time / turn_index，二进制里一个都没有。
// 照文档手写的 fixture 会带上这些字段，于是测试在一个现实中不存在的载荷上通过。
// 注意本关只看得见直接写在载荷字面量里的键；用 `...` 展开进去的
// （Stop 的 background_tasks / session_crons）看不见，真要用就走逐例豁免。
if (bin) {
  const base = new Set([...baseKeys(bin), 'hook_event_name']);
  const perEvent = {
    'user-prompt-submit.json': new Set([...base, ...payloadKeys(bin, 'UserPromptSubmit')]),
    'stop.json': new Set([...base, ...payloadKeys(bin, 'Stop')]),
    'session-end.json': new Set([...base, ...payloadKeys(bin, 'SessionEnd')]),
  };
  // 别名：本插件刻意同时认文档名，fixture 用它是合法的。
  perEvent['user-prompt-submit.json'].add('user_prompt');

  const CASES = join(REPO, 'tests', 'replay', 'cases');
  const invented = [];
  let scanned = 0;
  for (const c of readdirSync(CASES).filter((d) => !d.startsWith('.')).sort()) {
    for (const [file, allowed] of Object.entries(perEvent)) {
      const fp = join(CASES, c, file);
      if (!existsSync(fp)) continue;
      let obj;
      try { obj = JSON.parse(readFileSync(fp, 'utf8')); } catch { continue; }  // 畸形用例本来就该畸形
      scanned += 1;
      // 有的用例存在的意义就是喂一个运行时不发的字段（07）。豁免写在它自己的
      // expect.json 里，理由跟着用例走，不堆在这个文件的白名单里。
      let exempt = [];
      try {
        exempt = JSON.parse(readFileSync(join(CASES, c, 'expect.json'), 'utf8')).runtime_fields_exempt ?? [];
      } catch { /* 没有 expect.json 就没有豁免 */ }
      for (const k of Object.keys(obj)) {
        if (!allowed.has(k) && !exempt.includes(k)) invented.push(`${c}/${file}:${k}`);
      }
    }
  }
  check(
    `fixture 用的字段运行时都真的会发（扫了 ${scanned} 个）`,
    invented.length === 0,
    invented.length ? `运行时不存在：${invented.join('、')}` : ''
  );
}

console.log('');
if (failures.length) {
  console.log(`  ✗ ${failures.length} 项失败${skipped ? `，${skipped} 项跳过` : ''}\n`);
  for (const f of failures) console.log(`    ${f}`);
  console.log('');
  process.exit(1);
}
if (skipped) {
  console.log(`  ⊘ ${skipped} 项跳过（未验证，不等于通过）\n`);
  process.exit(0);
}
console.log('  ✓ 字段名与运行时一致\n');
