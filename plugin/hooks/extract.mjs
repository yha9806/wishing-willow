#!/usr/bin/env node
// Stop — pull the model's decode line out of the turn it just finished.
//
// If the line isn't there, we leave `decode` null and say nothing. A missing
// declaration is not an error to be corrected here; it is the state the reader
// is supposed to show you.

import {
  SCHEMA, readStdin, parseInput, readState, writeState, appendTurnLog, pruneState, findDeclaration, findNext, quietExit,
} from './_willow.mjs';

try {
  const input = parseInput(readStdin());
  if (!input) quietExit();

  const sessionId = input.session_id;
  if (typeof sessionId !== 'string') quietExit();

  const prev = readState(sessionId);
  const found = findDeclaration(input, prev);
  const decode = found?.decode ?? null;
  const tag = found?.tag ?? null;
  const plan = found?.plan ?? null;
  const next = findNext(input, prev);

  // Only ever touch `decode` and the timestamp. `prompt` stays exactly as
  // capture.mjs wrote it — this hook has no business rewriting what you said.
  const endedAt = new Date().toISOString();

  if (prev) {
    writeState(sessionId, { ...prev, decode, tag, plan, next, turnEndedAt: endedAt, updatedAt: endedAt });
    // 只在 capture 跑过的时候记日志：没有 capture 就没有原话，也没有「问没问」，
    // 记一条三个字段都是 null 的东西只会让统计更难看懂。
    appendTurnLog(sessionId, {
      turnId: prev.turnId ?? null,
      at: prev.updatedAt ?? null,
      endedAt,
      interrupted: false,
      supersededAt: null,
      midTurn: prev.midTurn === true,
      reminded: prev.reminded ?? null,
      promptField: prev.promptField ?? null,
      origin: prev.origin ?? null,
      prompt: prev.prompt ?? null,
      decode,
      tag,
    });
  } else {
    // Stop without a preceding capture (plugin installed mid-turn, state wiped).
    // Record what we can rather than inventing a prompt.
    writeState(sessionId, {
      schema: SCHEMA,
      sessionId,
      pid: process.ppid,
      cwd: typeof input.cwd === 'string' ? input.cwd : null,
      turnId: typeof input.prompt_id === 'string' ? input.prompt_id : null,
      // 轮次只有 capture 知道，而这条路径正是「没有 capture」。
      // 写 0 是编一个看起来确定的数；不知道就写 null，读方显示「—」。
      turnIndex: null,
      updatedAt: new Date().toISOString(),
      prompt: null,
      decode,
      tag,
      plan,
      next,
      turnEndedAt: endedAt,
      midTurn: false,
      endedAt: null,
    });
  }
  pruneState(sessionId);
  process.exit(0);
} catch {
  quietExit();
}
