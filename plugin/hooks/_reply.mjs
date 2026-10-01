// 「下一步」那一行末尾建议的回复：中文写「回「X」」，英文写 reply "X"。
//
// 纯函数，不用 Node：两处共用。一处是 UserPromptSubmit 钩子（_list.mjs），用户只回「.」时按 X 来办；
// 另一处是函数钩子模块 next-reply.ts，一轮结束后把 X 放进输入框当灰字建议。后者跑在 Claude Code 的
// 插件环境里，那里没有 Node，所以这个文件不能 import 任何 node: 模块。
const NEXT = /^\s*(?:下一步|Next)\s*[:：](.*)$/;
const REPLY = /(?:回|reply)\s*[「"“]([^」"”\n]{1,60})[」"”]/giu;

/** 「下一步」那一行（冒号后面的内容）里最后一个 回「X」 的 X；没有就 null。 */
export function replyIn(next) {
  if (typeof next !== 'string') return null;
  const all = [...next.matchAll(REPLY)];
  return all.length ? (all[all.length - 1][1].trim() || null) : null;
}

/** 一整条回复里，最后几行中的「下一步」那一行（冒号后面的内容）；没有就 null。 */
export function nextLineOf(answer, scan = 6) {
  if (typeof answer !== 'string') return null;
  const lines = answer.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-scan).reverse();
  for (const line of lines) {
    const m = NEXT.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** 一整条回复建议用户回的那一句；没写就 null。 */
export function suggestedReplyOf(answer) {
  const next = nextLineOf(answer);
  return next === null ? null : replyIn(next);
}
