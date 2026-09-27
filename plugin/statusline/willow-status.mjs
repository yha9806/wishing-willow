#!/usr/bin/env node
// statusLine — two rows: what you said, and how the model read it.
//
// Claude Code blanks the status line if this exits non-zero or prints nothing,
// so every failure path still prints something harmless.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sessionLang, pick } from '../hooks/_lang.mjs';

const DIM = '\x1b[2m';
const WARN = '\x1b[33m';
const RESET = '\x1b[0m';

/** Display width: CJK and fullwidth punctuation occupy two columns. */
function width(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd)
        ? 2
        : 1;
  }
  return w;
}

function truncate(s, max) {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (width(flat) <= max) return flat;
  let out = '';
  let w = 0;
  for (const ch of flat) {
    const cw = width(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) ?? {};
  } catch {
    /* fall through to the idle line */
  }

  const dir = process.env.WILLOW_STATE_DIR || join(homedir(), '.claude', 'willow');
  const id = input.session_id;
  const path = typeof id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(id)
    ? join(dir, `${id}.json`)
    : null;

  if (!path || !existsSync(path)) {
    process.stdout.write(`${DIM}🌿 willow · ${pick(sessionLang(null), '待首轮', 'waiting for the first turn')}${RESET}`);
    return;
  }

  let state;
  try {
    state = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    process.stdout.write(`${DIM}🌿 willow · ${pick(sessionLang(null), '状态不可读', 'state unreadable')}${RESET}`);
    return;
  }

  const T = (zh, en) => pick(sessionLang(state), zh, en);

  // The status line lives in a narrow strip; leave room for the label and padding.
  const cols = Number(process.env.COLUMNS) || 100;
  const room = Math.max(20, cols - 14);

  // `prompt` and `promptField` both null means capture ran and could not read
  // this turn's input — the plugin is broken, not the model quiet. Say so
  // instead of rendering a blank row that looks like an ordinary turn.
  if (typeof state.prompt !== 'string' && state.promptField === null) {
    process.stdout.write(`${WARN}⚠ ${T('willow 读不到本轮输入 · hook 字段名与此版本不符', 'willow can\'t read this turn\'s input · hook field names don\'t match this version')}${RESET}`);
    return;
  }

  const asked = typeof state.prompt === 'string' && state.prompt.trim()
    ? truncate(state.prompt, room)
    : '—';

  // Absence of `decode` is the signal. Never inferred, never scored — the two
  // rows sit side by side and the reader decides whether they agree.
  const decode = typeof state.decode === 'string' && state.decode.trim()
    ? state.decode.trim()
    : null;

  // ⚠ 开头 = 模型自己说两栏不一致。我们不重算，只把它的判断原样转发。
  // 这里用颜色区分的是「谁说的」，不是「对不对」—— 判定一致性的活儿，
  // 这个插件从头到尾不做。
  const flagged = decode !== null && decode.startsWith('⚠');
  const tag = typeof state.tag === 'string' && state.tag.trim() ? state.tag.trim() : null;

  const line1 = `${DIM}${T('你批准的', 'You approved')}${RESET} ${asked}`;
  const line2 = decode
    ? `${DIM}${T('我读成了', 'How I read it')}${RESET} ${flagged ? WARN : ''}${truncate(decode, room - (tag ? width(tag) + 3 : 0))}${flagged ? RESET : ''}${tag ? ` ${DIM}[${tag}]${RESET}` : ''}`
    : `${WARN}⚠ ${T('本轮未声明', 'no reading this turn')}${RESET}`;

  process.stdout.write(`${line1}\n${line2}`);
}

try {
  main();
} catch {
  process.stdout.write(`${DIM}🌿 willow${RESET}`);
}
