#!/usr/bin/env node
// Contract runner — 第二关。
//
// replay/run.mjs 测的是脚本的行为：它直接 spawn `node hooks/capture.mjs`。
// 那一关全绿过，而插件在真实 Claude Code 里一次都没跑起来——因为它绕过了
// hooks.json，而错的恰好是 hooks.json：它写成 command:"node" + args:[...]，
// 而 args 不是 hook schema 的字段，于是实际执行的是无参数的 node，
// 把 stdin 的 JSON 当脚本求值，SyntaxError 退出。
//
// 这一关只测一件事：**按 hooks.json 里写的那条命令去执行，行为是否正确。**
// 它不碰脚本逻辑，那是上一关的事。

import { readFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const PLUGIN_ROOT = join(REPO, 'plugin');
const HOOKS_JSON = join(PLUGIN_ROOT, 'hooks', 'hooks.json');

const failures = [];
function check(label, ok, detail) {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`    ${ok ? '·' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
  return ok;
}

console.log('\n  contract · hooks.json 注册契约\n');

// ── 1. 字段白名单 ────────────────────────────────────────────────
// 廉价护栏：schema 只认 type/command/timeout。多写的字段会被静默忽略，
// 而"静默忽略"正是这次 bug 的传播方式。
const ALLOWED = new Set(['type', 'command', 'timeout']);
const cfg = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
const entries = [];
for (const [event, matchers] of Object.entries(cfg.hooks ?? {})) {
  for (const m of matchers) {
    for (const h of m.hooks ?? []) entries.push({ event, h });
  }
}

check('hooks.json 至少注册了一个 hook', entries.length > 0, `实际 ${entries.length}`);

for (const { event, h } of entries) {
  const extra = Object.keys(h).filter((k) => !ALLOWED.has(k));
  check(
    `${event} 只用 schema 认得的字段`,
    extra.length === 0,
    extra.length ? `多出 ${extra.join(', ')}（会被静默忽略）` : ''
  );
  check(`${event} 的 command 自带脚本路径`, typeof h.command === 'string' && h.command.includes('${CLAUDE_PLUGIN_ROOT}'),
    typeof h.command === 'string' ? `command="${h.command}"` : 'command 不是字符串');
}

// ── 函数钩子模块（Claude Code 新插件接口）：输入框灰字 ─────────────────────
// hooks.json 的 modules 里列的文件要在；模块跑在没有 Node 的环境里，它和它 import 的文件都不能用 node: 模块；
// 建议回复的取法（_reply.mjs）照几种回复结尾各试一次。
{
  const mods = cfg.modules ?? [];
  check('hooks.json 列了输入框灰字模块', mods.includes('./next-reply.ts'), `modules=${JSON.stringify(mods)}`);
  for (const m of mods) {
    const path = join(PLUGIN_ROOT, 'hooks', m);
    check(`模块 ${m} 在`, existsSync(path));
    if (!existsSync(path)) continue;
    const src = readFileSync(path, 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((x) => x[1]);
    for (const imp of imports.filter((x) => x.startsWith('.'))) {
      const dep = readFileSync(join(PLUGIN_ROOT, 'hooks', imp), 'utf8');
      check(`${m} 引的 ${imp} 不用 Node`, !/from\s+['"]node:|require\(/.test(dep));
    }
    check(`${m} 不用 Node`, !imports.some((x) => x.startsWith('node:')));
  }
  const { suggestedReplyOf } = await import(join(PLUGIN_ROOT, 'hooks', '_reply.mjs'));
  const cases = [
    ['正文\n\n清单：▫ 以后 5\n\n下一步：L1 写插件——接口已确认；回「写插件」', '写插件'],
    ['下一步：L1 推分支——它挡着合并；回「K1 认可」', 'K1 认可'],
    ['正文里提到 回「别取这个」\n\n下一步：L2 等 CI——没有建议', null],
    ['Next: L3 merge — it blocks the install; reply "merge it"', 'merge it'],
    ['没有下一步这一行', null],
  ];
  for (const [answer, want] of cases) {
    const got = suggestedReplyOf(answer);
    check(`建议回复取作 ${JSON.stringify(want)}`, got === want, `得到 ${JSON.stringify(got)}`);
  }
}

// ── 2. 真正的证据：照 command 写的那样执行一次 ──────────────────
// 用 shell 执行，和 Claude Code 一样——引号、路径、可执行位都在这一步暴露。
function runAsWritten(command, stdin, stateDir) {
  const resolved = command.replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT);
  const r = spawnSync(resolved, {
    shell: true,
    input: stdin,
    env: { ...process.env, WILLOW_STATE_DIR: stateDir, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const submit = entries.find((e) => e.event === 'UserPromptSubmit');
if (!submit) {
  check('找得到 UserPromptSubmit 的 hook', false);
} else {
  const stateDir = mkdtempSync(join(tmpdir(), 'willow-contract-'));
  const SID = 'contract-probe';
  const PROMPT = '按 hooks.json 写的那条命令跑一次，确认状态文件真的被写出来了。';
  const input = JSON.stringify({
    session_id: SID,
    hook_event_name: 'UserPromptSubmit',
    prompt: PROMPT,
    cwd: REPO,
  });

  const r = runAsWritten(submit.h.command, input, stateDir);

  check('照 command 执行后 exit 0', r.code === 0, `exit=${r.code}${r.stderr ? ` stderr=${r.stderr.split('\n')[0]}` : ''}`);

  const files = existsSync(stateDir) ? readdirSync(stateDir).filter((f) => f.endsWith('.json')) : [];
  check('状态文件被写出来了', files.length === 1, `实际 ${files.length} 个`);

  if (files.length === 1) {
    const st = JSON.parse(readFileSync(join(stateDir, files[0]), 'utf8'));
    check('prompt 逐字保存', st.prompt === PROMPT, `实际 ${JSON.stringify(st.prompt)}`);
  }

  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* 下一条会报 */ }
  check('stdout 是合法 JSON', out !== null, r.stdout ? `实际 ${r.stdout.slice(0, 60)}` : '空');
  check(
    'additionalContext 被注入',
    !!out?.hookSpecificOutput?.additionalContext,
    out ? `实际 ${JSON.stringify(out).slice(0, 80)}` : ''
  );

  // 会话结束：同一个会话，照 hooks.json 里 SessionEnd 那条命令跑一次，endedAt 必须落盘。
  // 没有这一位，app 只能拿进程号猜「关了没有」。
  const end = entries.find((e) => e.event === 'SessionEnd');
  if (check('找得到 SessionEnd 的 hook', !!end) && files.length === 1) {
    const e = runAsWritten(end.h.command, JSON.stringify({
      session_id: SID,
      hook_event_name: 'SessionEnd',
      reason: 'prompt_input_exit',
      cwd: REPO,
    }), stateDir);
    check('SessionEnd 照 command 执行后 exit 0', e.code === 0, `exit=${e.code}${e.stderr ? ` stderr=${e.stderr.split('\n')[0]}` : ''}`);
    const st = JSON.parse(readFileSync(join(stateDir, files[0]), 'utf8'));
    check('SessionEnd 写下了 endedAt', typeof st.endedAt === 'string', `实际 ${JSON.stringify(st.endedAt)}`);
    check('SessionEnd 没动原话', st.prompt === PROMPT, `实际 ${JSON.stringify(st.prompt)}`);
  }

  // 压缩之后：照 hooks.json 里 SessionStart 那条命令跑一次（匹配值 compact），要交回一段话给模型。
  const start = entries.find((e) => e.event === 'SessionStart');
  const matcher = (cfg.hooks?.SessionStart ?? []).find((m) => (m.hooks ?? []).includes(start?.h))?.matcher;
  if (check('找得到 SessionStart 的 hook', !!start) && check('SessionStart 只在压缩后跑', matcher === 'compact', `matcher=${JSON.stringify(matcher)}`)) {
    const s = runAsWritten(start.h.command, JSON.stringify({
      session_id: SID,
      hook_event_name: 'SessionStart',
      source: 'compact',
      cwd: REPO,
    }), stateDir);
    check('SessionStart 照 command 执行后 exit 0', s.code === 0, `exit=${s.code}${s.stderr ? ` stderr=${s.stderr.split('\n')[0]}` : ''}`);
    let o = null;
    try { o = JSON.parse(s.stdout); } catch { /* 下面报 */ }
    check('SessionStart 交回的是 SessionStart 的 additionalContext',
      o?.hookSpecificOutput?.hookEventName === 'SessionStart' && !!o?.hookSpecificOutput?.additionalContext,
      o ? `实际 ${JSON.stringify(o).slice(0, 80)}` : `stdout=${s.stdout.slice(0, 60)}`);
  }
}

console.log('');
if (failures.length) {
  console.log(`  ✗ ${failures.length} 项失败\n`);
  for (const f of failures) console.log(`    ${f}`);
  console.log('');
  process.exit(1);
}
console.log('  ✓ 契约通过\n');
