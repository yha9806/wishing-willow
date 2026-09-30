// 计划卡（轻计划）：多步、含不可逆动作的事，先写一张 ≤ 8 行的卡，用户批一次。
//
// 原生计划模式为写代码设计，一次要十几分钟、派子代理、交一份长文档；聊天里逐步「照推荐」又要来回好几条消息。
// 卡在两者之间：一行目标、一行不做、每步一行「做什么 → 怎么验」，要用户点头的标 ✋，用户亲手跑的给一条命令。
// 每步记成清单上的一项（标题以「K<n>·①」开头），不另起一张表：09-23 的「计划：」块第二天就并进了长清单。
//
// 这里只管两件事：写法（随规则每个普通轮注入，压缩后重交）；卡长和「怎么验」（Stop 时量，下一轮说一次）。
// 判的只是形状，不判卡写得对不对。

import { pick } from './_lang.mjs';

export const CARD_MAX_LINES = 8;

const CARD_RULE_ZH =
  '两个以上不可逆动作（推送、开 PR、合并、发出、删除、改写提交等）或要用户亲手跑命令时，先写计划卡：' +
  '首行「计划卡 K<n>：<目标>」，一行「不做：…」，每步一行「① 做什么 → 怎么验」，要用户点头的标 ✋，用户跑的给一条命令；' +
  `≤ ${CARD_MAX_LINES} 行。批一次即批卡上全部步骤（记「K<n> 认可」），没写到的情况整张卡停下只问那一处。每步记成清单项，标题以「K<n>·①」开头。`;

const CARD_RULE_EN =
  'Before two or more irreversible actions (push, open a PR, merge, send, delete, rewrite a commit…) or a command the user must run, '
  + 'write a plan card: first line "Plan card K<n>: <goal>", one line "Not doing: …", one line per step "① what → how it is checked", '
  + `✋ on steps the user must approve, one command for a step the user runs; at most ${CARD_MAX_LINES} lines. `
  + 'One approval covers every step on the card; anything it does not cover stops the card and asks about that one thing. '
  + 'Record each step as a list item titled "K<n>·① …", and the approval as "K<n> approved".';

export const cardRule = (lang) => pick(lang, CARD_RULE_ZH, CARD_RULE_EN);

const HEAD = /^\s*(?:计划卡|plan card)\s*(K\d+)?\s*[：:]/iu;
// 卡在这些行之前结束：它们是回复末尾另外的块。
const STOP = /^\s*(?:清单变化|清单|下一步|list changes|list|next)\s*[：:]/iu;
const STEP = /^\s*([①②③④⑤⑥⑦⑧⑨⑩])/u;
const ARROW = /→|->/u;

/** 回复里的计划卡：[{id, lines, unchecked}]，unchecked 是没写「→」的步的编号。同一张卡在一轮里写了几遍，只量最后一遍。 */
export function findCards(texts) {
  const byId = new Map();
  let n = 0;
  for (const text of texts ?? []) {
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const h = HEAD.exec(lines[i]);
      if (!h) continue;
      const body = [lines[i]];
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim() || STOP.test(lines[j]) || HEAD.test(lines[j])) break;
        body.push(lines[j]);
      }
      const unchecked = body.map((l) => STEP.exec(l)).map((m, k) => (m && !ARROW.test(body[k]) ? m[1] : null)).filter(Boolean);
      const id = h[1] ?? `#${++n}`;
      byId.set(id, { id: h[1] ?? null, lines: body.length, unchecked });
      i += body.length - 1;
    }
  }
  return [...byId.values()];
}

/** 这一轮的卡有什么形状问题：一句话，或 null。 */
export function cardProblem(texts, lang = 'zh') {
  const out = [];
  for (const c of findCards(texts)) {
    const long = c.lines > CARD_MAX_LINES;
    if (!long && !c.unchecked.length) continue;
    const parts = [];
    if (long) {
      parts.push(pick(lang, `写了 ${c.lines} 行，超过 ${CARD_MAX_LINES} 行，压到 ${CARD_MAX_LINES} 行以内（目标、不做各一行，每步一行）`,
        `has ${c.lines} lines, over ${CARD_MAX_LINES}; bring it within ${CARD_MAX_LINES} (goal and not-doing one line each, one line per step)`));
    }
    if (c.unchecked.length) {
      parts.push(pick(lang, `第 ${c.unchecked.join('、')} 步没写「→ 怎么验」`, `step ${c.unchecked.join(', ')} has no "→ how it is checked"`));
    }
    out.push(pick(lang, `上一轮的计划卡${c.id ? ` ${c.id} ` : ''}${parts.join('；')}。`, `Last turn's plan card${c.id ? ` ${c.id}` : ''} ${parts.join('; ')}.`));
  }
  return out.length ? out.join('\n') : null;
}
