#!/usr/bin/env node
// Replay runner — 第一关。
//
// 它测的是 hook 的确定性行为，不是模型的行为：
// 给定一段没有声明的回复，extract 是否正确留下 decode=null；
// 给定有声明的，是否正确提取。
//
// 纪律（用户全局规则〈八〉〈九〉）：这个 runner 必须先在空实现上跑出全红，
// 才允许去写实现。没验证过能变红的测试是摆设。

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const HOOKS = join(REPO, 'plugin', 'hooks');
const CASES = join(HERE, 'cases');

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** 跑一个 hook，返回 {code, stdout, stderr}。stdin 以原始字节喂入（畸形输入也要能喂）。 */
function runHook(script, stdinPath, stateDir, extraEnv) {
  const entry = join(HOOKS, script);
  if (!existsSync(entry)) {
    return { code: null, stdout: '', stderr: `MISSING: ${entry}`, missing: true };
  }
  // 真实载荷里的 transcript_path 是绝对路径，用例里写不出来。
  // 用例写 <CASE_DIR>/…，喂进去之前换成这个用例目录的真实路径。
  let input = readFileSync(stdinPath);
  if (input.includes('<CASE_DIR>') || input.includes('<STATE_DIR>')) {
    input = Buffer.from(
      input.toString('utf8')
        .replaceAll('<CASE_DIR>', dirname(stdinPath))
        .replaceAll('<STATE_DIR>', stateDir),
      'utf8'
    );
  }
  const r = spawnSync('node', [entry], {
    input,
    env: { ...process.env, WILLOW_STATE_DIR: stateDir, ...(extraEnv ?? {}) },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 状态目录里唯一的那个 .json（hook 以 session id 命名）。 */
function readState(stateDir) {
  if (!existsSync(stateDir)) return null;
  const files = readdirSync(stateDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return null;
  return read(join(stateDir, files[0]));
}

const failures = [];
function check(caseName, label, ok, detail) {
  if (!ok) failures.push(`${caseName} · ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

const caseNames = readdirSync(CASES).filter((d) => !d.startsWith('.')).sort();
console.log(`\n  replay · ${caseNames.length} cases\n`);

for (const name of caseNames) {
  const dir = join(CASES, name);
  const expect = read(join(dir, 'expect.json'));

  // 顶层期望键也要白名单。写错一个键名、或者写了一条 runner 还不会查的期望，
  // 都必须报错而不是静默跳过 —— 2026-09-12 这一族已经吃了两次：
  // state_file 的未知键（14-tag-line 假绿）和这里的 log_* 。
  const TOP_KEYS = new Set([
    'note', 'env', 'transcript_two_phase', 'runtime_fields_exempt',
    'capture', 'extract', 'state_file', 'state_keys', 'log_lines', 'log_last', 'steps', 'session_id',
  ]);
  for (const k of Object.keys(expect)) {
    if (!TOP_KEYS.has(k)) check(name, 'expect.keys', false, `runner 不认识期望键 ${k}`);
  }
  const stateDir = mkdtempSync(join(tmpdir(), 'willow-test-'));
  const marks = [];
  // 待触发清单：用例目录里的 state-config.json 放到状态目录的 config/willow.json；
  // 里面的 <CASE_DIR> 换成用例目录的真实路径（清单文件写在用例目录里）。
  // 放进子目录而不是状态目录顶层：app 把顶层每个 .json 都当会话读，readState 也是。
  const cfgSrc = join(dir, 'state-config.json');
  if (existsSync(cfgSrc)) {
    mkdirSync(join(stateDir, 'config'), { recursive: true });
    writeFileSync(join(stateDir, 'config', 'willow.json'),
      readFileSync(cfgSrc, 'utf8').replaceAll('<CASE_DIR>', dir).replaceAll('<STATE_DIR>', stateDir));
  }
  // 别的来源（写作循环）留给模型的话：用例目录里的 state-inbox/ 原样放到状态目录的 inbox/。
  const inboxSrc = join(dir, 'state-inbox');
  if (existsSync(inboxSrc)) {
    mkdirSync(join(stateDir, 'inbox'), { recursive: true });
    for (const f of readdirSync(inboxSrc)) writeFileSync(join(stateDir, 'inbox', f), readFileSync(join(inboxSrc, f)));
  }

  try {
    // 两阶段 transcript：提交那一刻文件里只有历史，本轮的内容是之后才追加的。
    // 这个顺序本身就是被测的东西 —— capture 记下的偏移必须是「本轮之前」的长度。
    const twoPhase = expect.transcript_two_phase === true;
    const liveTranscript = join(stateDir, 'transcript.jsonl');
    if (twoPhase) {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(liveTranscript, readFileSync(join(dir, 'transcript.pre.jsonl')));
    }
    const env = expect.env ?? undefined;

    // 多步序列：真实会话里一轮之内不止「提交一次、结束一次」——进行中插进来的
    // 系统通知、被打断之后来的新消息（2026-09-12 两种都在真实日志里丢过整轮）。
    if (Array.isArray(expect.steps)) {
      const STEP_KEYS = new Set(['append', 'copy', 'to', 'hook', 'input', 'stdout', 'context_includes', 'context_excludes']);
      for (const [i, st] of expect.steps.entries()) {
        for (const k of Object.keys(st)) {
          if (!STEP_KEYS.has(k)) check(name, `steps[${i}].keys`, false, `runner 不认识步骤键 ${k}`);
        }
        if (st.append) {
          appendFileSync(join(stateDir, 'transcript.jsonl'), readFileSync(join(dir, st.append)));
          continue;
        }
        // 两轮之间换掉状态目录里的一份文件（待触发清单）：用例目录本身不许被测试改写。
        if (st.copy) {
          writeFileSync(join(stateDir, st.to ?? st.copy), readFileSync(join(dir, st.copy), 'utf8'));
          continue;
        }
        const script = { capture: 'capture.mjs', extract: 'extract.mjs', end: 'end.mjs', compacted: 'compacted.mjs' }[st.hook] ?? null;
        if (!script) { check(name, `steps[${i}]`, false, `未知步骤 ${JSON.stringify(st)}`); continue; }
        const r = runHook(script, join(dir, st.input), stateDir, env);
        let ok = check(name, `steps[${i}].${st.hook}.exit`, r.code === 0, `exit=${r.code} ${(r.stderr || '').slice(0, 80)}`);
        if (st.stdout) {
          const injected = r.stdout.trim().length > 0;
          ok = check(name, `steps[${i}].${st.hook}.stdout`, injected === (st.stdout === 'inject'),
            st.stdout === 'inject' ? '期望注入，却为空' : `期望不注入，却输出了 ${r.stdout.trim().length} 字符`) && ok;
        }
        if (st.context_includes || st.context_excludes) {
          let ctx = '';
          try { ctx = JSON.parse(r.stdout.trim() || '{}')?.hookSpecificOutput?.additionalContext ?? ''; } catch { ctx = ''; }
          for (const s of st.context_includes ?? []) {
            ok = check(name, `steps[${i}].context_includes`, ctx.includes(s), `注入内容里没有「${s}」`) && ok;
          }
          for (const s of st.context_excludes ?? []) {
            ok = check(name, `steps[${i}].context_excludes`, !ctx.includes(s), `注入内容里不该有「${s}」`) && ok;
          }
        }
        marks.push(`${st.hook}:${ok ? 'ok' : 'FAIL'}`);
      }
    }

    // ── capture (UserPromptSubmit) ────────────────────────────────────────
    const ups = join(dir, 'user-prompt-submit.json');
    if (existsSync(ups) && expect.capture) {
      const r = runHook('capture.mjs', ups, stateDir, env);
      if (r.missing) {
        check(name, 'capture', false, r.stderr);
        marks.push('capture:MISSING');
      } else {
        const codeOk = check(name, 'capture.exit_code', r.code === expect.capture.exit_code,
          `期望 ${expect.capture.exit_code}，得到 ${r.code}${r.stderr ? ` (stderr: ${r.stderr.trim().slice(0, 80)})` : ''}`);

        const out = r.stdout.trim();
        const injected = out.length > 0;
        const wantInject = expect.capture.stdout === 'inject';
        const injOk = check(name, 'capture.stdout', injected === wantInject,
          wantInject ? '期望注入，但输出为空' : `期望不注入，却输出了 ${out.length} 字符`);

        // 注入时必须是合法 JSON，且必须以 { 开头并以 } 结尾
        // —— 官方规则：以 { 开头但不以 } 结尾会被当纯文本
        let shapeOk = true;
        if (injected) {
          shapeOk = check(name, 'capture.stdout.shape',
            out.startsWith('{') && out.endsWith('}') && (() => { try { JSON.parse(out); return true; } catch { return false; } })(),
            '注入的 stdout 必须是完整合法 JSON');
        }
        // 注入的内容。只查「有没有注入」看不见注入了什么，而待触发条目进没进上下文，
        // 正是要测的东西。capture 的期望键也白名单：写错键名必须报错，不能静默跳过。
        const CAP_KEYS = new Set(['exit_code', 'stdout', 'context_includes', 'context_excludes']);
        let keysOk = true;
        for (const k of Object.keys(expect.capture)) {
          if (!CAP_KEYS.has(k)) keysOk = check(name, 'capture.keys', false, `runner 不认识 capture 期望键 ${k}`) && keysOk;
        }
        let ctx = '';
        if (injected) { try { ctx = JSON.parse(out)?.hookSpecificOutput?.additionalContext ?? ''; } catch { ctx = ''; } }
        let ctxOk = true;
        for (const s of expect.capture.context_includes ?? []) {
          ctxOk = check(name, 'capture.context_includes', ctx.includes(s), `注入内容里没有「${s}」`) && ctxOk;
        }
        for (const s of expect.capture.context_excludes ?? []) {
          ctxOk = check(name, 'capture.context_excludes', !ctx.includes(s), `注入内容里不该有「${s}」`) && ctxOk;
        }
        marks.push(`capture:${codeOk && injOk && shapeOk && ctxOk && keysOk ? 'ok' : 'FAIL'}`);
      }
    }

    // ── extract (Stop) ───────────────────────────────────────────────────
    if (twoPhase) {
      appendFileSync(liveTranscript, readFileSync(join(dir, 'transcript.turn.jsonl')));
    }
    const stop = join(dir, 'stop.json');
    if (existsSync(stop) && expect.extract) {
      const r = runHook('extract.mjs', stop, stateDir, env);
      if (r.missing) {
        check(name, 'extract', false, r.stderr);
        marks.push('extract:MISSING');
      } else {
        const ok = check(name, 'extract.exit_code', r.code === expect.extract.exit_code,
          `期望 ${expect.extract.exit_code}，得到 ${r.code}`);
        marks.push(`extract:${ok ? 'ok' : 'FAIL'}`);
      }
    }

    // ── 状态文件 ──────────────────────────────────────────────────────────
    const state = readState(stateDir);
    if (expect.state_file === null) {
      check(name, 'state_file', state === null, '期望不写状态文件，却写了');
      marks.push(`state:${state === null ? 'ok' : 'FAIL'}`);
    } else if (expect.state_file) {
      let ok = check(name, 'state_file', state !== null, '期望有状态文件，却没有');
      if (state) {
        // 键集钉死 —— 这条守的是产品最核心的一条设计线：状态文件里不得出现
        // 任何"两栏是否一致"的判定。那种字段一旦存在，就一定会在声明缺失时
        // 写错，于是重新制造这个插件要打破的沉默。
        if (expect.state_keys) {
          const got = Object.keys(state).sort();
          const want = [...expect.state_keys].sort();
          ok = check(name, 'state.keys', JSON.stringify(got) === JSON.stringify(want),
            `多出 ${got.filter((k) => !want.includes(k)).join(',') || '—'}；少了 ${want.filter((k) => !got.includes(k)).join(',') || '—'}`) && ok;
        }
        // 逐键比对。**不认识的键必须报错，不能静默跳过** —— 2026-09-12 第四次假绿：
        // 14-tag-line 期望 state.tag，而 runner 只认几个写死的键，于是这条期望被
        // 忽略、用例在功能根本没实现的情况下变绿。检查器看不见的期望等于没写。
        const SPECIAL = new Set(['prompt_startswith']);
        for (const [k, want] of Object.entries(expect.state_file)) {
          if (SPECIAL.has(k)) continue;
          const got = state[k] ?? null;
          // "<NONNULL>"：只断言「写了」，不断言写了什么（时间戳这类每次都不同的值）。
          // 数组与对象（计划块）按 JSON 逐字比，其余照旧用 ===。
          const hit = want === '<NONNULL>' ? got !== null
            : (want !== null && typeof want === 'object') ? JSON.stringify(got) === JSON.stringify(want)
            : got === want;
          ok = check(name, `state.${k}`, hit,
            `期望 ${JSON.stringify(want)}，得到 ${JSON.stringify(got)}`) && ok;
        }
        if (expect.state_file.prompt_startswith) {
          const p = state.prompt ?? '';
          ok = check(name, 'state.prompt.startswith', p.startsWith(expect.state_file.prompt_startswith),
            `prompt 应以「${expect.state_file.prompt_startswith}」开头，得到「${p.slice(0, 30)}…」`) && ok;
        }
        // prompt 必须逐字保存 —— A1 的核心，绝不允许被改写。
        // 原话从 fixture 实际用的那个键里取，不写死键名：写死键名正是
        // 2026-09-12 那个 bug 能躲过整套测试的原因。
        const rawPrompt = existsSync(ups) ? (() => {
          try {
            const raw = read(ups);
            for (const f of ['prompt', 'user_prompt']) {
              if (typeof raw[f] === 'string') return raw[f];
            }
          } catch { /* 畸形输入交给别的断言 */ }
          return null;
        })() : null;
        if (rawPrompt != null) {
          ok = check(name, 'state.prompt.verbatim', state.prompt === rawPrompt,
            'prompt 必须与输入的原话逐字一致') && ok;
        }
      }
      marks.push(`state:${ok ? 'ok' : 'FAIL'}`);
    }
    // ── 轮次日志 ─────────────────────────────────────────────────────────
    if (expect.log_lines !== undefined || expect.log_last !== undefined) {
      const sid = expect.session_id ?? (() => { try { return read(stop).session_id ?? read(ups).session_id; } catch { return null; } })();
      const logPath = sid ? join(stateDir, `${sid}.log.jsonl`) : null;
      const lines = logPath && existsSync(logPath)
        ? readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim())
        : [];
      let ok = true;
      if (expect.log_lines !== undefined) {
        ok = check(name, 'log.lines', lines.length === expect.log_lines,
          `期望 ${expect.log_lines} 行，得到 ${lines.length}`) && ok;
      }
      if (expect.log_last !== undefined) {
        let last = null;
        try { last = JSON.parse(lines[lines.length - 1]); } catch { /* 下面报 */ }
        ok = check(name, 'log.last', last !== null, '最后一行不是合法 JSON 或不存在') && ok;
        if (last) {
          for (const [k, want] of Object.entries(expect.log_last)) {
            const got = last[k] ?? null;
            ok = check(name, `log.last.${k}`, want === '<NONNULL>' ? got !== null : got === want,
              `期望 ${JSON.stringify(want)}，得到 ${JSON.stringify(got)}`) && ok;
          }
        }
      }
      marks.push(`log:${ok ? 'ok' : 'FAIL'}`);
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }

  const bad = marks.some((m) => m.includes('FAIL') || m.includes('MISSING'));
  console.log(`  ${bad ? '✗' : '✓'} ${name.padEnd(24)} ${marks.join('  ')}`);
}

console.log('');
if (failures.length) {
  console.log(`  ${failures.length} 项失败：\n`);
  for (const f of failures) console.log(`    · ${f}`);
  console.log('');
  process.exit(1);
}
console.log('  全部通过\n');
