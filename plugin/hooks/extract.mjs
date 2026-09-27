#!/usr/bin/env node
// Stop — pull the model's decode line out of the turn it just finished.
//
// If the line isn't there, we leave `decode` null and say nothing. A missing
// declaration is not an error to be corrected here; it is the state the reader
// is supposed to show you.

import {
  SCHEMA, readStdin, parseInput, readState, writeState, appendTurnLog, pruneState, findDeclaration, findNext, touchedPaths, mergeTouched, quietExit,
  turnAssistantRows,
} from './_willow.mjs';
import { parseOps, applyOps, readList, appendSnapshot, appliedRows, commandedLines } from './_list.mjs';
import { sessionLang } from './_lang.mjs';

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
  const touched = mergeTouched(prev?.touched, touchedPaths(input, prev));

  // Only ever touch `decode` and the timestamp. `prompt` stays exactly as
  // capture.mjs wrote it — this hook has no business rewriting what you said.
  const endedAt = new Date().toISOString();

  // 长清单：这一轮的「清单变化：」块应用到上一份快照上，追加一份新的。旧清单读不出就不写——
  // 拿空清单盖掉它比读不出更糟；capture 会照实说读不出。清单出错不许拖垮下面声明的记录。
  try {
    // 已经执行过的消息不再执行：压缩会把它们原样重写进这一轮后面（见 appliedRows、turnSlice）。
    const done = appliedRows(sessionId);
    const fresh = turnAssistantRows(input, prev).filter((r) => r.uuid === null || !done.has(r.uuid));
    // 这一轮已经用命令记过的行（listctl.mjs），回复末尾又写了一遍的，不再执行。
    const commanded = commandedLines(sessionId, prev?.turnId ?? null);
    const ops = parseOps(fresh.flatMap((r) => r.texts)).filter((o) => !(o.raw && commanded.has(o.raw)));
    if (ops.length) {
      const cur = readList(sessionId);
      if (!cur?.error) {
        const turn = { turnId: prev?.turnId ?? null, turnIndex: prev?.turnIndex ?? null };
        const rows = fresh.filter((r) => r.uuid !== null && parseOps(r.texts).length).map((r) => r.uuid);
        appendSnapshot(sessionId, { at: endedAt, ...turn, ...applyOps(cur?.items, ops, turn, sessionLang(prev)), rows });
      }
    }
  } catch { /* 见上 */ }

  if (prev) {
    writeState(sessionId, { ...prev, decode, tag, plan, next, touched, turnEndedAt: endedAt, updatedAt: endedAt });
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
