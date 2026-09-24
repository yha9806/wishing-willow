#!/usr/bin/env node
// SessionStart（source = compact）——上下文刚被压缩：把清单和清单的写法重新交给模型。
//
// 清单和那几条写法是每轮开头由 capture 注入的，压缩之后这一轮开头那份多半已经不在上下文里。
// 2026-09-24 实测：一轮中途自动压缩后，那一轮的回复既没写「清单变化」也没带清单那一行，做完的两项一直开着。
// 所以压缩一结束就重交一份完整的，并把「上次完整列出」清掉，下一轮开头照样完整列，不说「其余和第 N 轮一样」；
// 待触发条目同理（shown 清掉，下一轮重新说）。别的字段不动：这一轮的原话、偏移、声明都还是这一轮的。
// 压缩后能不能交话给模型：Claude Code 2.1.280 的 SessionStart 匹配值有 compact，「Exit code 0 - stdout shown to Claude」，
// 输出里认 hookSpecificOutput.additionalContext。

import { readStdin, parseInput, readState, writeState, quietExit } from './_willow.mjs';
import { listBlock, LIST_RULES } from './_list.mjs';

const HEAD = '【Wishing-Willow · 压缩后】上下文刚被压缩，这一轮开头交给你的清单和写法可能已经不在了，这里重交一份。'
  + '这一轮里已经做完或变了的事，照下面的写法在回复末尾补上。';

try {
  const input = parseInput(readStdin());
  if (!input || input.source !== 'compact') quietExit();
  const sessionId = input.session_id;
  if (typeof sessionId !== 'string') quietExit();

  const prev = readState(sessionId);
  let list = null;
  try {
    list = listBlock(sessionId, 'full', prev?.turnIndex ?? null, null).text;
  } catch {
    list = '【Wishing-Willow · 清单】清单读不出，不能当作没有开着的事。';
  }
  if (prev) writeState(sessionId, { ...prev, listShown: null, shown: null });

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: [HEAD, LIST_RULES, list].filter(Boolean).join('\n\n'),
    },
  }));
  process.exit(0);
} catch {
  quietExit();
}
