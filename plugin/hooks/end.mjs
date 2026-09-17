#!/usr/bin/env node
// SessionEnd — record that the session is over.
//
// Without this, the reader could only guess from the pid: a process that is
// gone means the session is closed. That guess breaks when a pid is reused,
// and it was the only signal there was — on 2026-09-17 none of the 40 state
// files on this machine had `endedAt` set. Now it is a fact the plugin writes.
//
// Only `endedAt` changes. What you said, what the model declared, and when the
// turn ran stay exactly as capture and extract wrote them, and nothing goes
// into the turn log: a session ending is not a turn.

import { readStdin, parseInput, readState, writeState, quietExit } from './_willow.mjs';

try {
  const input = parseInput(readStdin());
  if (!input) quietExit();

  const sessionId = input.session_id;
  if (typeof sessionId !== 'string') quietExit();

  // 一句话都没说过的会话没有状态文件。不替它建一个：面板里会多出一个没有原话的空会话。
  const prev = readState(sessionId);
  if (!prev) quietExit();

  writeState(sessionId, { ...prev, endedAt: new Date().toISOString() });
  process.exit(0);
} catch {
  quietExit();
}
