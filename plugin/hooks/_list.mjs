// 整场对话的长清单。
//
// 以前只有这一轮的「计划：」和一行「下一步：」，每轮重写，事项会不声不响地掉。现在清单跨轮留着：
// 模型只在清单有变化时，在回复末尾写一个「清单变化：」块，一行一条——
//   + 在做：… / + 等你：… / + 等 <什么>：… / + 以后：…（末尾可带「（依据：…）」，不带就是预测）
//   L3 做完：<证据>   L3 → <状态>[：说明]   L3 撤掉：<原因>   L3 挪到以后：<条件>   L3 认可
//   L3 属于：E5（挂到稿件那边的一件待做）   E6 不挂：<理由>（稿件那边这件不挂到清单上）
//   L3 判据：合并 o/r#12（做完的判据，机器去核，满足了点名一次；新增行末尾也可带「（判据：…）」，见 _check.mjs）
// 编号由这里分配。一项只能靠明写的一行离开清单；没提到的原样留着，所以「悄悄消失」在写法上就不会发生。
// 撤掉没写原因的不撤，做完没附证据的照记，引用了不存在的编号——都记为问题，下一轮说出来。
//
// 每轮有变化就往 <状态目录>/<会话>.list.jsonl 追加一行快照（{at, turnId, turnIndex, items, changes, problems, rows}）。
// rows 是这一份的操作出自哪几条消息（uuid）：同一条消息只执行一次，压缩把它重写进后面的一轮也一样（见 appliedRows）。
// 不用 .json 结尾：app 把状态目录顶层的每个 .json 都当成一个会话。

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './_willow.mjs';
import { pick } from './_lang.mjs';
import { replyIn } from './_reply.mjs';
import { hookupNotes } from './_inbox.mjs';
import { parseCheck, itemCheck, checkLabel, readChecks } from './_check.mjs';

// 清单的写法，每轮开头随提醒注入（capture.mjs），压缩后原样重交一次（compacted.mjs）。
// 长清单（2026-09-24 用户：要整场对话的长链路清单，跟着对话变，不只下一步）。旧的「计划：」块并进来：
// 这一轮要做的步骤就是清单里「在做」的项。只写变化，一项只能靠明写的一行离开。
const LIST_RULES_ZH =
  // 注入瘦身 D2 第一步（2026-09-30）：每条写法都在，只把说法写短。
  '长清单（【清单】里是开着的项）：每条回复在「下一步：」之前照【清单】给的那一行写「清单：…」，本轮有变化先改好。' +
  '本轮清单有变化（新的要做或要等、做完、换状态、撤掉）就在「下一步：」之前写「清单变化：」，一行一条：' +
  '「+ 在做：<事>」「+ 等你：<事>」「+ 等 <什么>：<事>」「+ 以后：<事>」新增，有事实依据就在末尾加「（依据：<提交号、文件或 CI>）」，不加算预测；' +
  '「L3 做完：<证据>」「L3 → 等你：<为什么>」「L3 撤掉：<原因>」「L3 认可」（用户本轮认可）「L3 改题：<新标题>」（原标题读着像还悬着）' +
  '「L3 挡着：L5、L7」（落地能放开哪几项，可写外部的事，写「无」清空）。' +
  '机器能核的完成条件写在末尾「（判据：合并 o/r#12）」，还认「推到 o/r 分支 提交号」「文件 ~/路径」「进程退出 pid」，「；」连写；已有的项写「L3 判据：…」；满足了这里点名一次，关不关仍由你写。' +
  '标题一行约 40 字，背景进依据；编号只在本对话算数，提到别的对话的编号要带上对话名（「会话甲的 L3」）；没提到的项原样留着，没变化就不写这块。\n' +
  '回复的最后一行写「下一步：Lx <这件事>——<为什么是它>」：有开着的项就点名一项，说它为什么排第一（挡着别的、在等你、快到期）；' +
  '没有就写之后等用户什么或你接着做什么。要用户回话或拍板时，末尾再加「；回「<用户可以原样回的一句>」」，用户只回「.」就等于回了这一句；' +
  '不用用户回的（你接着做、等后台跑完、等别的对话）就不写 回「…」。';

// 英文版（2026-09-27 装机演练 F2）。与中文版逐条对应；写法两种都认（parseOps）。
const LIST_RULES_EN =
  'Long list (open items under [Wishing-Willow · List]): end every reply, just before "Next:", with the "List: …" line given there, updated first if the list changed. '
  + 'When this turn changes the list (new to do or wait for, finished, moved, dropped), write "List changes:" before "Next:", one per line: '
  + '"+ Doing: <item>", "+ Waiting on you: <item>", "+ Waiting on <what>: <item>", "+ Later: <item>" to add (end with "(basis: <commit, file or CI>)" when a fact backs it; else it is a forecast); '
  + '"L3 done: <evidence>", "L3 → waiting on you: <why>", "L3 dropped: <reason>", "L3 approved" (the user approved it this turn), "L3 retitled: <new title>" (the old title reads as still open), '
  + '"L3 blocks: L5, L7" (what it frees once it lands; outside events allowed; "none" clears). '
  + 'A done condition a machine can check goes at the end as "(check: merged o/r#12)"; also "pushed o/r branch sha", "file ~/path", "exited pid", joined with ";"; '
  + 'for an existing item write "L3 check: …"; you are told once here when it holds, and closing it is still yours to write. '
  + 'One-line titles (about 80 characters), background in the basis; IDs count only in this conversation, so name the conversation for another one\'s ID ("session A\'s L3"); '
  + 'unmentioned items stay; no change, no block.\n'
  + 'Last line: "Next: Lx <the item> — <why it comes first>": with open items, name one and say why it comes first (blocks others, waits on the user, due); '
  + 'with none, say what you wait on the user for or what you do next. When the user has to answer or decide, end it with '
  + '"; reply "<a reply the user can send as is>""; a bare "." from the user means that reply. '
  + 'When nothing is needed from the user (you carry on, a background run, another conversation), leave the reply out.';

export const listRules = (lang) => pick(lang, LIST_RULES_ZH, LIST_RULES_EN);

// 一键接受（K9，2026-10-01）：「下一步」末尾写 回「X」，用户只回「.」或「。」就当回了 X。
// 只有点也算（2026-10-02）：「。。」「...」「…」「．」顺手打出来都是这个意思；带了别的字（「好.」）就不算。
// Claude Code 输入框里的灰字建议是另调一次模型猜出来的，插件写不进去（2.1.284 程序摘录）；这条不靠它。
// 用户的原话照旧逐字记下（还是「.」），只是告诉模型这一轮按哪句来办。
export const ACCEPT = /^\s*[.。．…]+\s*$/u;

/** 「下一步」那一行里最后一个 回「X」（英文 reply "X"）的 X；没有就 null。和输入框灰字（next-reply.ts）同一份规则。 */
export const suggestedReply = replyIn;

/** 用户只回了「.」时要告诉模型的一句；不是这种回复就 null。 */
export function acceptText(prompt, next, lang) {
  if (typeof prompt !== 'string' || !ACCEPT.test(prompt)) return null;
  const p = prompt.trim();
  const x = suggestedReply(next);
  return x
    ? pick(lang, `【Wishing-Willow】用户只回了「${p}」：照你上一条回复末尾的建议，这一轮按用户回的是「${x}」来办。`,
      `[Wishing-Willow] The user replied only "${p}": per the end of your last reply, take this turn as the user saying "${x}".`)
    : pick(lang, `【Wishing-Willow】用户只回了「${p}」，可你上一条回复末尾没有写 回「…」：别猜，先问一句要做什么。`,
      `[Wishing-Willow] The user replied only "${p}", but your last reply ended without a suggested reply: don't guess; ask what to do.`);
}

export const STALE_TURNS = 5;
// 「等你」10 轮以上没动的标出来（2026-09-24：26 项等你大半是早上提的、没人再问过，刘海上的「等你 N」因此失去意义）。
export const STALE_YOU_TURNS = 10;
const CLOSED = new Set(['做完', '撤掉']);
const STATUS = '(在做|等你|以后|等\\s*[^：:]+?|doing|waiting on you|later|waiting on\\s+[^：:]+?)';
const ADD = new RegExp(`^\\+\\s*${STATUS}\\s*[：:]\\s*(.+)$`, 'i');
const DONE = /^(L\d+)\s*(?:做完|done)\s*(?:[：:]\s*(.*))?$/i;
const MOVE = new RegExp(`^(L\\d+)\\s*(?:→|->)\\s*${STATUS}\\s*(?:[：:]\\s*(.*))?$`, 'i');
const DROP = /^(L\d+)\s*(?:撤掉|dropped)\s*(?:[：:]\s*(.*))?$/i;
const LATER = /^(L\d+)\s*(?:挪到以后|moved to later)\s*(?:[：:]\s*(.*))?$/i;
// 一项挡着什么（09-28 spec「清单与下一步的分工」D1）：它一落地就能放开的项，或外部的事（投稿）。
const BLOCKS = /^(L\d+)\s*(?:挡着|blocks)\s*[：:]\s*(.+)$/i;
// 一项属于稿件那边的哪件待做（2026-10-04 spec「稿件待做挂上对话清单」D2）：「L33 属于：E5」；
// 对话绑了几篇稿子时写「ipm E5」。稿件那边一件不挂到清单上，写「E6 不挂：<理由>」（D3）。
const OF = /^(L\d+)\s*(?:属于|belongs to)\s*[：:]\s*(.+)$/i;
// 做完的判据（ops-private spec 2026-10-07 D1）：「L3 判据：合并 o/r#12」，写「无」清空。
const CHECK = /^(L\d+)\s*(?:判据|check)\s*[：:]\s*(.+)$/i;
const NOHOOK = /^((?:[\w.\-\u2e80-\u9fff]+\s+)?[A-Za-z]+\d+)\s*(?:不挂|not hooked)\s*(?:[：:]\s*(.*))?$/i;
// 末尾的「（挡着：…）」「（依据：…）」：从句尾往回数括号找到配对的那个开括号，里面再套括号也拆得开
// （09-28 实测一张真实清单：依据里写了带括号的文件名或说明，整段依据留在了标题里）。
function tail(text, label) {
  const t = String(text).replace(/\s+$/, '');
  if (!/[）)]$/.test(t)) return null;
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    const c = t[i];
    if (c === '）' || c === ')') depth++;
    else if (c === '（' || c === '(') {
      depth--;
      if (depth === 0) {
        const m = label.exec(t.slice(i + 1, t.length - 1));
        return m ? { value: m[1].trim(), index: i } : null;
      }
    }
  }
  return null;
}
const BLOCKS_LABEL = /^\s*(?:挡着|blocks)\s*[：:]\s*([\s\S]+)$/i;
const OF_LABEL = /^\s*(?:属于|belongs to)\s*[：:]\s*([\s\S]+)$/i;
const BASIS_LABEL = /^\s*(?:依据|basis)\s*[：:]\s*([\s\S]+)$/i;
const CHECK_LABEL = /^\s*(?:判据|check)\s*[：:]\s*([\s\S]+)$/i;
const NONE = /^(无|none|nothing|-)$/i;
const TARGETS = /\s*[、,，;；]\s*|\s+(?=L\d)/;
export function splitTargets(t) {
  const v = String(t).trim();
  if (/^(无|none|nothing|-)$/i.test(v)) return [];
  return v.split(TARGETS).map((x) => x.trim()).filter(Boolean);
}
const APPROVE = /^(L\d+)\s*(?:认可|approved)\s*$/i;
// 「K1 认可」：批一张计划卡就是批卡上写明的全部步骤（轻计划 D3，_card.mjs）。
const APPROVE_CARD = /^(K\d+)\s*(?:认可|approved)\s*$/i;
// 计划卡上的一步：标题以「K1·」开头（· 也认 ・ 和 .）。
export function cardOf(text) {
  const m = /^(K\d+)\s*[·・.]/i.exec(String(text ?? '').trim());
  return m ? m[1].toUpperCase() : null;
}
const RETITLE = /^(L\d+)\s*(?:改题|retitled?)\s*[：:]\s*(\S.*)$/i;
// 标题一行写完：中文约 40 字、英文约 80 个字符（CJK 记 1、其余记 0.5）。09-28 面板 grill 第三轮 R1：
// 建项时写成三到五行的问句，事情定了标题还在问，面板上比「现在那句」显眼得多。
export const TITLE_MAX = 40;
export function titleWidth(t) {
  let w = 0;
  for (const c of String(t)) w += c.codePointAt(0) >= 0x2e80 ? 1 : 0.5;
  return w;
}
const HEAD = /^(?:清单变化|List changes)\s*[：:]\s*$/i;
// 标题里写了会被新提交取代的东西（09-28：「领先 31 个提交」「c2210ee 连同改动说明……」——事情还成立，标题先过时了）。
// 提交号：7–40 位十六进制、既有数字又有字母（deadbeef、日期、纯数字不算）；提交数：「N 个提交」「N commits」。只报不拦，要求挪进依据。
const HASH_IN_TITLE = /(?<![0-9A-Za-z])(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![0-9A-Za-z])/;
const COUNT_IN_TITLE = /\d+\s*个(?:本地|新)?提交|\d+\s+commits?\b/i;
// 「（依据：…」起到末尾不算标题正文：依据里套了括号时解析拆不开，整段依据会留在标题里——那是照规矩写的依据，不该再催。
const BASIS_TAIL = /[（(]\s*(?:依据|basis)\s*[：:][\s\S]*$/i;
export function volatileProblem(id, text, lang = 'zh') {
  const T = (zh, en) => pick(lang, zh, en);
  const head = String(text).replace(BASIS_TAIL, '');
  const h = HASH_IN_TITLE.exec(head);
  if (h) {
    return T(`${id} 的标题里有提交号 ${h[0]}：新提交一来它就过时了，写进依据（可以「${id} 改题：…」去掉它）`,
      `${id}'s title carries a commit id (${h[0]}): the next commit makes it stale; put it in the basis (drop it with "${id} retitled: …")`);
  }
  const c = COUNT_IN_TITLE.exec(head);
  return c ? T(`${id} 的标题里写了提交数（${c[0]}）：数会变，写进依据`,
    `${id}'s title carries a commit count (${c[0]}): the count changes; put it in the basis`) : null;
}

export function listPath(sessionId) {
  return join(stateDir(), `${sessionId}.list.jsonl`);
}

/** 最后一份快照；没有文件是 null；读不出是 {error}——读不出不能当成空清单。 */
export function readList(sessionId) {
  const p = listPath(sessionId);
  if (!existsSync(p)) return null;
  try {
    const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    const last = JSON.parse(lines[lines.length - 1]);
    if (!last || !Array.isArray(last.items)) throw new Error('最后一行不是快照');
    return last;
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

// 磁盘上的状态值始终是中文键（app 按键翻译），英文写法在这里换成同一个键。
function status(s) {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t === '在做' || t === '等你' || t === '以后') return { status: t, wait: null };
  const low = t.toLowerCase();
  if (low === 'doing') return { status: '在做', wait: null };
  if (low === 'waiting on you') return { status: '等你', wait: null };
  if (low === 'later') return { status: '以后', wait: null };
  if (low.startsWith('waiting on ')) return { status: '等', wait: t.slice('waiting on '.length).trim() };
  return { status: '等', wait: t.replace(/^等\s*/, '') };
}

/** 从这一轮的文字里取出所有「清单变化：」块里的行，按出现顺序。块在空行、「下一步：」或一行不认识的字处结束。 */
export function parseOps(texts) {
  const ops = [];
  for (const text of texts ?? []) {
    if (typeof text !== 'string') continue;
    let inBlock = false;
    for (const raw of text.split('\n')) {
      // 「\+」是 Markdown 列表里对 + 的转义（2026-09-27 实测：模型写了「- \+ Later: …」，这一行和块里其后的行都静默丢了）。
      const line = raw.trim().replace(/^[-*]\s+/, '').replace(/^\\(?=\+)/, '');
      if (HEAD.test(line)) { inBlock = true; continue; }
      if (!inBlock) continue;
      let m;
      const before = ops.length;
      if ((m = ADD.exec(line))) {
        // 末尾的「（依据：…）」「（挡着：…）」「（属于：…）」「（判据：…）」都可以有，先后不论。
        let text = m[2], basis = '预测', blocks = null, of = null, check = null;
        for (let k = 0; k < 4; k++) {
          const b = tail(text, BASIS_LABEL);
          if (b) { basis = b.value; text = text.slice(0, b.index); continue; }
          const c = tail(text, CHECK_LABEL);
          if (c) { check = NONE.test(c.value) ? null : c.value; text = text.slice(0, c.index); continue; }
          const t = tail(text, BLOCKS_LABEL);
          if (t) { blocks = splitTargets(t.value); text = text.slice(0, t.index); continue; }
          const o = tail(text, OF_LABEL);
          if (o) { of = splitTargets(o.value); text = text.slice(0, o.index); }
        }
        ops.push({ op: 'add', ...status(m[1]), text: text.trim(), basis, ...(blocks ? { blocks } : {}), ...(of ? { of } : {}), ...(check ? { check } : {}) });
      } else if ((m = BLOCKS.exec(line))) ops.push({ op: 'blocks', id: m[1], targets: splitTargets(m[2]) });
      else if ((m = OF.exec(line))) ops.push({ op: 'of', id: m[1], targets: splitTargets(m[2]) });
      else if ((m = CHECK.exec(line))) ops.push({ op: 'check', id: m[1], check: NONE.test(m[2].trim()) ? null : m[2].trim() });
      else if ((m = DONE.exec(line))) ops.push({ op: 'done', id: m[1], note: (m[2] ?? '').trim() });
      else if ((m = MOVE.exec(line))) ops.push({ op: 'move', id: m[1], ...status(m[2]), note: (m[3] ?? '').trim() });
      else if ((m = DROP.exec(line))) ops.push({ op: 'drop', id: m[1], note: (m[2] ?? '').trim() });
      else if ((m = LATER.exec(line))) ops.push({ op: 'move', id: m[1], status: '以后', wait: null, note: (m[2] ?? '').trim() });
      else if ((m = APPROVE.exec(line))) ops.push({ op: 'approve', id: m[1] });
      else if ((m = APPROVE_CARD.exec(line))) ops.push({ op: 'approveCard', card: m[1].toUpperCase() });
      else if ((m = RETITLE.exec(line))) {
        // 改题时写的依据也拆出来（09-28：「L3 改题：新标题（依据：…）」整行进了标题）；它是新的依据，替掉旧的。
        const b = tail(m[2], BASIS_LABEL);
        ops.push({ op: 'retitle', id: m[1], text: (b ? m[2].slice(0, b.index) : m[2]).trim(), ...(b ? { basis: b.value } : {}) });
      }
      else if ((m = NOHOOK.exec(line))) ops.push({ op: 'nohook', ref: m[1].replace(/\s+/g, ' '), note: (m[2] ?? '').trim() });
      else if (/^(\+|L\d+)/.test(line)) ops.push({ op: 'bad', line });
      else inBlock = false;   // 空行、「下一步：」、正文：块到此为止
      if (ops.length > before) ops[ops.length - 1].raw = line;   // 用命令记过的行，回复末尾再写一遍时认得出
    }
  }
  return ops;
}

/**
 * 「属于」和「不挂」写的稿件待做编号对到开了对号的稿件上（spec「稿件待做挂上对话清单」D2）：
 * 「E5」或「ipm E5」→ {key: 'ipm E5', ws, id, todo}；对不上 → {problem}。裸编号在两篇稿子里都有就要带稿件名。
 */
export function resolveTodo(ref, manuscripts, lang = 'zh') {
  const T = (zh, en) => pick(lang, zh, en);
  const m = /^(?:(\S+)\s+)?([A-Za-z]+\d+)$/.exec(String(ref).trim());
  if (!m) return { problem: T(`「${ref}」不是稿件待做的编号`, `"${ref}" is not a manuscript item ID`) };
  const [, ws, id] = m;
  const hits = manuscripts.filter((x) => (!ws || x.workspace === ws) && x.todo.some((t) => t.id === id));
  if (hits.length === 1) return { key: `${hits[0].workspace} ${id}`, ws: hits[0].workspace, id, todo: hits[0].todo.find((t) => t.id === id) };
  if (hits.length > 1) {
    return { problem: T(`${id} 在 ${hits.map((h) => h.workspace).join('、')} 都有，写「${hits[0].workspace} ${id}」这样带上稿件名`,
      `${id} is in ${hits.map((h) => h.workspace).join(', ')}; write "${hits[0].workspace} ${id}" with the manuscript's name`) };
  }
  if (ws && !manuscripts.some((x) => x.workspace === ws)) {
    return { problem: T(`没有开了对号的稿件 ${ws}`, `no manuscript named ${ws} has the hookup on`) };
  }
  return { problem: T(`稿件那边没有 ${ws ? `${ws} ` : ''}${id}`, `the manuscript has no ${ws ? `${ws} ` : ''}${id}`) };
}

/**
 * 把一轮的操作应用到上一份快照上。turn = {turnId, turnIndex}。
 * ctx.manuscripts：开了对号的稿件（_inbox.mjs hookupNotes）；有就核「属于」「不挂」写的编号，没有就照记不核。
 * ctx.unhooked：上一份快照里写过「不挂」的 {'ipm E6': {reason, turn}}，带到这一份。
 * ctx.checks：做完判据的核查结果（_check.mjs readChecks），ctx.now：这一刻（ISO）。有就在做完时记时间、核对判据（spec 2026-10-07 D6、D8）。
 */
export function applyOps(prevItems, ops, turn, lang = 'zh', ctx = {}) {
  const T = (zh, en) => pick(lang, zh, en);
  const items = (prevItems ?? []).map((x) => ({ ...x }));
  const changes = [];
  const problems = [];
  const ms = Array.isArray(ctx?.manuscripts) ? ctx.manuscripts : [];
  const unhooked = { ...(ctx?.unhooked && typeof ctx.unhooked === 'object' ? ctx.unhooked : {}) };
  // 开了对号时核编号、写成带稿件名的那种；没开时照记。全都对不上的，返回 null（不动原来的）。
  const ofTargets = (owner, targets) => {
    if (!ms.length) return targets;
    const kept = [];
    for (const t of targets) {
      const r = resolveTodo(t, ms, lang);
      if (r.problem) problems.push(T(`${owner} 属于的 ${t}：${r.problem}`, `${owner} belongs to ${t}: ${r.problem}`));
      else if (!kept.includes(r.key)) kept.push(r.key);
    }
    return targets.length && !kept.length ? null : kept;
  };
  let next = items.reduce((n, x) => Math.max(n, Number(String(x.id).slice(1)) || 0), 0) + 1;
  const find = (id) => items.find((x) => x.id === id);
  // 判据里认不出的部分照记，人工判；说一次（spec 2026-10-07 D2）。
  const checkProblem = (id, check) => {
    const { bad } = parseCheck(check);
    if (bad.length) {
      problems.push(T(`${id} 的判据「${bad.join('；')}」机器核不了（只认 合并 o/r#n、推到 o/r 分支 提交号、文件 路径、进程退出 pid），照记、人工判`,
        `${id}'s check "${bad.join('; ')}" can't be checked by machine (only merged o/r#n, pushed o/r branch sha, file path, exited pid); kept, judged by hand`));
    }
  };
  for (const o of ops) {
    if (o.op === 'bad') { problems.push(T(`看不懂这一行：${o.line}`, `Can't read this line: ${o.line}`)); continue; }
    if (o.op === 'add') {
      // 「+ 以后：L23 发布前……」：正文以一个已有的编号开头，是在复述那一项，不是新事（09-27 面板 grill 第二轮 N6：
      // 命令记过 L21、L23 之后，回复末尾又带着编号写了一遍，各多出一项）。不新增，记成问题，下一轮说出来。
      const ref = /^(L\d+)(?![\d])/.exec(o.text);
      if (ref && find(ref[1])) {
        problems.push(T(`${ref[1]} 已在清单上，这一行是在复述它，没有新增`, `${ref[1]} is already on the list; this line restates it, so nothing was added`));
        continue;
      }
      const id = `L${next++}`;
      const of = o.of ? ofTargets(id, o.of) : null;
      items.push({ id, text: o.text, status: o.status, wait: o.wait, basis: o.basis,
        sourceTurn: turn.turnId ?? null, since: turn.turnIndex ?? null, touched: turn.turnIndex ?? null,
        ...(o.blocks && o.blocks.length ? { blocks: o.blocks } : {}), ...(of && of.length ? { of } : {}), ...(o.check ? { check: o.check } : {}) });
      changes.push(T(`新增 ${id}`, `added ${id}`));
      if (o.check) checkProblem(id, o.check);
      if (titleWidth(o.text) > TITLE_MAX) {
        problems.push(T(`${id} 的标题太长（一行写完，约 40 字内），背景写进依据或说明；可以「${id} 改题：…」改短`,
          `${id}'s title is too long (keep it to one line, about 80 characters); put background in the basis or the note, or shorten it with "${id} retitled: …"`));
      }
      const v = volatileProblem(id, o.text, lang);
      if (v) problems.push(v);
      continue;
    }
    if (o.op === 'approveCard') {
      const steps = items.filter((x) => cardOf(x.text) === o.card && !CLOSED.has(x.status));
      if (!steps.length) {
        problems.push(T(`${o.card} 没有开着的步骤（标题以「${o.card}·」开头的项），没记认可`,
          `${o.card} has no open steps (items titled "${o.card}·…"), so nothing was approved`));
        continue;
      }
      for (const x of steps) x.approvedTurn = turn.turnId ?? null;
      changes.push(T(`${o.card} 认可（${steps.map((x) => x.id).join('、')}）`, `${o.card} approved (${steps.map((x) => x.id).join(', ')})`));
      continue;
    }
    if (o.op === 'nohook') {
      if (!o.note) { problems.push(T(`${o.ref} 不挂没写理由，没记`, `${o.ref} not hooked without a reason, so not recorded`)); continue; }
      if (!ms.length) {
        problems.push(T(`这场对话没有开了对号的稿件，${o.ref} 不挂没记`, `no manuscript in this conversation has the hookup on; ${o.ref} not recorded`));
        continue;
      }
      const r = resolveTodo(o.ref, ms, lang);
      if (r.problem) { problems.push(r.problem); continue; }
      unhooked[r.key] = { reason: o.note, turn: turn.turnIndex ?? null };
      changes.push(T(`${r.key} 不挂`, `${r.key} not hooked`));
      continue;
    }
    const it = find(o.id);
    if (!it) { problems.push(T(`${o.id} 不存在`, `${o.id} doesn't exist`)); continue; }
    if (o.op === 'of') {
      const kept = ofTargets(o.id, o.targets);
      if (kept === null) continue;   // 写的全对不上：不动原来的，问题已记
      if (kept.length) it.of = kept; else delete it.of;
      it.touched = turn.turnIndex ?? it.touched;
      changes.push(kept.length ? T(`${o.id} 属于 ${kept.join('、')}`, `${o.id} belongs to ${kept.join(', ')}`)
        : T(`${o.id} 不再属于稿件待做`, `${o.id} belongs to no manuscript item now`));
      continue;
    }
    if (o.op === 'check') {
      if (o.check) it.check = o.check; else delete it.check;
      it.touched = turn.turnIndex ?? it.touched;
      changes.push(o.check ? T(`${o.id} 判据`, `${o.id} check set`) : T(`${o.id} 不再带判据`, `${o.id} check cleared`));
      if (o.check) checkProblem(o.id, o.check);
      continue;
    }
    if (o.op === 'approve') { it.approvedTurn = turn.turnId ?? null; changes.push(T(`${o.id} 认可`, `${o.id} approved`)); continue; }
    if (o.op === 'blocks') {
      // 编号只认这场对话里有的；外部的事（投稿、截止）照写。写「无」清空。
      const missing = o.targets.filter((t) => /^L\d+$/.test(t) && !find(t));
      for (const t of missing) problems.push(T(`${o.id} 挡着的 ${t} 不存在`, `${o.id} blocks ${t}, which doesn't exist`));
      const kept = o.targets.filter((t) => !missing.includes(t));
      if (kept.length) it.blocks = kept; else delete it.blocks;
      it.touched = turn.turnIndex ?? it.touched;
      changes.push(kept.length ? T(`${o.id} 挡着 ${kept.join('、')}`, `${o.id} blocks ${kept.join(', ')}`) : T(`${o.id} 不再挡着别的`, `${o.id} blocks nothing now`));
      continue;
    }
    if (o.op === 'retitle') {
      // 建项原句留在 firstText：面板和记录都还能查到当初是怎么写的。
      if (it.firstText === undefined) it.firstText = it.text;
      it.text = o.text;
      if (o.basis) it.basis = o.basis;
      it.touched = turn.turnIndex ?? it.touched;
      changes.push(T(`${o.id} 改题`, `${o.id} retitled`));
      const v = volatileProblem(o.id, o.text, lang);
      if (v) problems.push(v);
      continue;
    }
    if (o.op === 'drop' && !o.note) { problems.push(T(`${o.id} 撤掉没写原因，没撤`, `${o.id} dropped without a reason, so not dropped`)); continue; }
    if (o.op === 'done' && !o.note) problems.push(T(`${o.id} 做完没附证据`, `${o.id} done without evidence`));
    if (o.op === 'done' && it.check && !CLOSED.has(it.status)) {
      // 带判据的项写做完：记两个时间（现实里成立、第一次核到），和写做完的这一刻；判据核到没满足就说一次，照记做完（D6、D8）。
      const s = ctx?.checks ? itemCheck(it, ctx.checks) : null;
      if (s?.state === 'met') { it.checkMetAt = s.metAt; it.checkSeenAt = s.seenAt; }
      if (s?.state === 'unmet') {
        problems.push(T(`${o.id} 写了做完，但判据核到未满足（${it.check}）：核一下证据，或改判据`,
          `${o.id} was marked done but its check does not hold yet (${it.check}): recheck the evidence or change the check`));
      }
      if (ctx?.now) it.doneAt = ctx.now;
    }
    if (o.op === 'done') { it.status = '做完'; it.wait = null; it.evidence = o.note || null; }
    else if (o.op === 'drop') { it.status = '撤掉'; it.wait = null; it.reason = o.note; }
    // 不带说明的转状态清掉旧说明：旧那句说的是上一个状态，留着面板就显示过期的话（L15，_list.mjs 原 119 行）。
    else { it.status = o.status; it.wait = o.wait; if (o.note) it.note = o.note; else delete it.note; }
    it.touched = turn.turnIndex ?? it.touched;
    changes.push(`${o.id} ${label(it, lang)}`);
  }
  // 稿件那边关了的，「不挂」就不用再记（只清开了对号、看得见的那几篇的）。
  for (const k of Object.keys(unhooked)) {
    const r = ms.length ? resolveTodo(k, ms, lang) : null;
    if (r && !r.problem && r.todo.closed) delete unhooked[k];
    else if (r?.problem && ms.some((x) => k.startsWith(`${x.workspace} `))) delete unhooked[k];
  }
  return { items, changes, problems, ...(Object.keys(unhooked).length ? { unhooked } : {}) };
}

/**
 * 已经执行过清单变化的消息（所有快照的 rows 并起来）。压缩会把旧消息带着原来的 uuid 重写进聊天记录末尾；
 * 比这一轮早一分钟以上的由 turnSlice 按时间挡掉，挡不住的那一分钟由这里按 uuid 挡。
 * 读不出就是空集：那种时候 extract 本来就不写新快照（readList 报错）。
 */
export function appliedRows(sessionId) {
  const out = new Set();
  const p = listPath(sessionId);
  if (!existsSync(p)) return out;
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let snap;
      try { snap = JSON.parse(line); } catch { continue; }
      for (const u of Array.isArray(snap?.rows) ? snap.rows : []) if (typeof u === 'string') out.add(u);
    }
  } catch { /* 见上 */ }
  return out;
}

/**
 * 这一轮用命令记过的行（listctl.mjs 写的快照：via = 'command'，lines 是原样的行）。
 * 回复末尾的「清单变化：」里再写一遍同一行，extract 跳过它——一行只算一次。
 */
/** 比较「同一行」时不看 Markdown 的修饰（反引号、加粗）和多余空白：回复末尾复述命令记过的行时常带这些。 */
export const normLine = (l) => String(l).replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();

export function commandedLines(sessionId, turnId) {
  const out = new Set();
  const p = listPath(sessionId);
  if (!existsSync(p) || turnId === null || turnId === undefined) return out;
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let snap;
      try { snap = JSON.parse(line); } catch { continue; }
      if (snap?.via !== 'command' || snap.turnId !== turnId) continue;
      for (const l of Array.isArray(snap.lines) ? snap.lines : []) if (typeof l === 'string') out.add(normLine(l));
    }
  } catch { /* 读不出就不跳：最坏是同一行记两次，比丢一行好认 */ }
  return out;
}

/**
 * 作者在 lintel 面板里做的改动（09-28 spec「清单实时」C）：app 调 listctl --by author 写的快照，via = 'author'。
 * 列出某一刻之后的，下一轮在【清单】里告诉模型「你在面板里改了什么」。
 */
export function authorChanges(sessionId, sinceIso) {
  const out = [];
  const p = listPath(sessionId);
  if (!existsSync(p)) return out;
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let snap;
      try { snap = JSON.parse(line); } catch { continue; }
      if (snap?.via !== 'author' || (sinceIso && !(String(snap.at) > sinceIso))) continue;
      for (const c of Array.isArray(snap.changes) ? snap.changes : []) if (typeof c === 'string') out.push(c);
    }
  } catch { /* 读不出就不说：最坏是模型下一轮才从清单本身看到变化 */ }
  return out;
}

/** 一轮做了这么久，清单变化却全攒到回复末尾，就说出来（09-28 spec「清单实时」A）。 */
export const HELD_MS = 5 * 60 * 1000;

/**
 * 回复末尾的「清单变化」里有做完、撤掉或换状态，这一轮却一次都没用命令记过清单，而且一轮 ≥ 5 分钟：
 * 这些变化本该发生时就记下（刘海一直是旧的）。新增不算——新增常常就是回复末尾才想清楚的。
 */
export function heldProblem(ops, commandedCount, startedMs, endedMs, lang) {
  if (commandedCount > 0 || !Number.isFinite(startedMs) || !Number.isFinite(endedMs)) return null;
  const mins = Math.floor((endedMs - startedMs) / 60000);
  if (endedMs - startedMs < HELD_MS) return null;
  const n = ops.filter((o) => o.op === 'done' || o.op === 'drop' || o.op === 'move').length;
  if (!n) return null;
  return pick(lang, `上一轮做了 ${mins} 分钟，${n} 处清单变化（做完、撤掉、换状态）都攒到了回复末尾，刘海上一直是旧的：发生时就用命令记`,
    `Last turn ran ${mins} minutes and ${n} list changes (done, dropped, moved) waited until the end of the reply, so the notch stayed stale: record them with the command as they happen`);
}

// 一轮有提交之后核一遍等你（09-28：一张清单 9 项等你里 6 项过时——前提被新提交取代、条件已经满足、默认做法已经落稿，
// 每项都只在记下它的那一轮被看过，「落稿后扫一遍」只是一条记在别处的规矩）。同一项核过后 SWEEP_EVERY 轮内不再问，
// 它被改动过就重新算：每轮都提交的会话里每轮把每项点一遍，这一行很快就没人读了。
export const SWEEP_EVERY = 5;
const SWEEP_SHOW = 6;

/** 该核的等你：这一轮之前记下、这一轮没碰过、改动以来没核过或核过已 SWEEP_EVERY 轮。swept 是 {编号: 上次核的轮次}。 */
export function sweepDue(items, turnIndex, swept) {
  if (!Array.isArray(items) || typeof turnIndex !== 'number') return [];
  const s = swept && typeof swept === 'object' ? swept : {};
  return items.filter((x) => {
    if (x.status !== '等你' || x.touched === turnIndex) return false;
    const at = s[x.id];
    return typeof at !== 'number' || (typeof x.touched === 'number' && at < x.touched) || turnIndex - at >= SWEEP_EVERY;
  });
}

/** 下一轮开头说的那一句；没有提交或没有该核的是 null。commits 是 turnCommits 的结果。 */
export function sweepText(commits, due, lang = 'zh') {
  if (!commits?.length || !due?.length) return null;
  const T = (zh, en) => pick(lang, zh, en);
  // 安静提交读不到提交号（turnCommits 的 hash 为 null）：有号的列前三个，其余只报个数。
  const known = commits.filter((c) => c.hash).slice(0, 3).map((c) => c.hash.slice(0, 7));
  const hashes = !known.length ? T(`${commits.length} 次`, `${commits.length} time${commits.length === 1 ? '' : 's'}`)
    : known.join(T('、', ', ')) + (commits.length > known.length
      ? T(` 等 ${commits.length} 个`, ` and ${commits.length - known.length} more`) : '');
  const ids = due.slice(0, SWEEP_SHOW).map((x) => `${x.id} ${brief(x.text, lang)}`).join(T('、', ', '))
    + (due.length > SWEEP_SHOW ? T(` 等 ${due.length} 项`, ` and ${due.length - SWEEP_SHOW} more`) : '');
  return T(`上一轮提交了 ${hashes}。之前记下、那一轮没碰过的等你 ${due.length} 项，逐条核它是否还成立：${ids}。`
    + '前提被这些提交取代的改题或撤掉，条件已经满足的改状态或做完；仍成立的不用写。',
  `Last turn committed ${hashes}. ${due.length} item(s) waiting on the user were recorded earlier and not touched in that turn; `
    + `check each still holds: ${ids}. Retitle or drop what the commits superseded, move or finish what they satisfied; `
    + 'nothing to write for what still holds.');
}

// 挂久了的项点一次名（09-28：一项「在做」连续 9 轮被标「N 轮没动」没人处理——每轮都在的被动标记会被读麻木；
// 一项「等别的会话」挂了 184 轮，「等 X」连标记都没有）。门槛：在做 STALE_TURNS、等你 STALE_YOU_TURNS、等别的 STALE_WAIT_TURNS；
// 点过以后，没动的轮数翻倍、并且至少又过 NUDGE_EVERY 轮才再点（在做 5→15→30、等你 10→20→40、等别的 20→40→80）：
// 长期停着等外部的事不会每十轮点一次（按固定十轮，一个会话 170 轮里有 68 轮要点名）。改动过就重新算。
// 「问过」与提交后核对共用一张记录（{编号: 轮次}），同一项一轮里不会被点两次。
export const STALE_WAIT_TURNS = 20;
export const NUDGE_EVERY = 10;
const NUDGE_SHOW = 6;

/** 该点名的项，各带 idle（没动的轮数）。asked 是 {编号: 上次问的轮次}。以后的不点。 */
export function idleDue(items, turnIndex, asked) {
  if (!Array.isArray(items) || typeof turnIndex !== 'number') return [];
  const a = asked && typeof asked === 'object' ? asked : {};
  const limit = { 在做: STALE_TURNS, 等你: STALE_YOU_TURNS, 等: STALE_WAIT_TURNS };
  return items.filter((x) => {
    const lim = limit[x.status];
    if (!lim || typeof x.touched !== 'number' || turnIndex - x.touched < lim) return false;
    const at = a[x.id];
    if (typeof at !== 'number' || at < x.touched) return true;
    const was = at - x.touched;
    return turnIndex - x.touched >= Math.max(2 * was, was + NUDGE_EVERY);
  }).map((x) => ({ ...x, idle: turnIndex - x.touched }));
}

/** 点名的那一句；没有该点的是 null。 */
export function idleText(due, lang = 'zh') {
  if (!due?.length) return null;
  const T = (zh, en) => pick(lang, zh, en);
  const one = (x) => T(`${x.id} ${brief(x.text, lang)}（${label(x, lang)}，${x.idle} 轮）`,
    `${x.id} ${brief(x.text, lang)} (${label(x, lang)}, ${x.idle} turns)`);
  const ids = due.slice(0, NUDGE_SHOW).map(one).join(T('、', ', '))
    + (due.length > NUDGE_SHOW ? T(` 等 ${due.length} 项`, ` and ${due.length - NUDGE_SHOW} more`) : '');
  return T(`这几项挂了很久没动，逐条核一次：${ids}。没在做的改成以后或「等 X」，前提变了的改题或撤掉，做完的写做完；`
    + '仍然成立的不用写，挂得越久问得越稀。',
  `These have not moved for a long time; check each once: ${ids}. Move what is not being done to later or "waiting on X", `
    + 'retitle or drop what changed, mark done what is done; nothing to write for what still holds (the longer it waits, the less often it is asked).');
}

/** 「问过」的记录只留还开着的项。 */
export function openAsked(asked, items) {
  const open = new Set((items ?? []).filter((x) => !CLOSED.has(x.status) && x.status !== '以后').map((x) => x.id));
  return Object.fromEntries(Object.entries(asked ?? {}).filter(([id]) => open.has(id)));
}

/**
 * 一轮中途改清单的那条命令（2026-09-24 作者要求进度和内容实时更新）。清单原来只在回复结束时记下，
 * 一轮做二十分钟，刘海上的清单二十分钟不动。命令一跑就追加一份快照，app 靠 FSEvents 一秒内读到。
 * 会话号直接写进命令：跑命令的 shell 不知道自己属于哪个会话。
 */
export function listCommand(sessionId) {
  const script = fileURLToPath(new URL('./listctl.mjs', import.meta.url));
  return `node "${script}" --session ${sessionId}`;
}

export function commandRule(sessionId, lang = 'zh') {
  if (lang === 'en') {
    return 'Record a list change the moment it happens (the notch shows it at once): run '
      + `${listCommand(sessionId)} "<line>" ["<line>" …]` + ', each line as under "List changes:"; it replies with the new list line. '
      + 'Lines recorded this way need not be repeated at the end of the reply.';
  }
  return '清单一变就立刻记（刘海马上显示）：跑 '
    + `${listCommand(sessionId)} "<一行>" ["<一行>" …]` + '，写法同「清单变化：」，它会回新的清单那一行；记过的回复末尾不用再写。';
}

export function appendSnapshot(sessionId, snap) {
  appendFileSync(listPath(sessionId), JSON.stringify(snap) + '\n');
}

const EN = { 在做: 'doing', 等你: 'waiting on you', 以后: 'later', 做完: 'done', 撤掉: 'dropped' };

function label(x, lang = 'zh') {
  if (lang === 'en') return x.status === '等' ? `waiting on ${x.wait}` : (EN[x.status] ?? x.status);
  return x.status === '等' ? `等 ${x.wait}` : x.status;
}

// 英文词长，同样一眼的量要多给些字符。
const brief = (t, lang = 'zh') => { const n = lang === 'en' ? 24 : 12; return t.length > n ? t.slice(0, n) + '…' : t; };

// 那一行里带日期的「等别的」「以后」（ops-private spec 2026-10-06 D1–D8）。10-06 实见：一件答应了两周多还没做的事、
// 一件约在当天的事，都只算在「以后」「等别的」的个数里，作者以为没记上。
// 日期已过、或 DATED_DAYS 天内到的，露出标题和天数，全行最多 DATED_MAX 项。只认下面几种写法，认不出就当没有日期，不猜；
// 日期每次从标题现算，不进清单数据。
export const DATED_DAYS = 14;
export const DATED_MAX = 2;
const DAY_MS = 86400000;
// 月、日超出范围（02-30、13-14）不是日期：Date.UTC 会把它进位成别的日子，回算一遍对得上才认。
function dayNo(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? Math.round(t.getTime() / DAY_MS) : null;
}
const monthEnd = (y, m) => (m >= 1 && m <= 12 ? Math.round(Date.UTC(y, m, 0) / DAY_MS) : null);
// 带年份的：2027-07-31、2027 年 7 月 31 日、2026 年 10 月底。
const WITH_YEAR = [
  [/(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g, (m) => dayNo(+m[1], +m[2], +m[3])],
  [/(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g, (m) => dayNo(+m[1], +m[2], +m[3])],
  [/(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月底/g, (m) => monthEnd(+m[1], +m[2])],
];
// 不带年份的：09-18（月、日都两位；前后紧挨数字、字母、- : / 的不认，免得从 ABCD-26-0517、10:07-11:30 里切出一段）、
// 10 月 15 日、10 月底。返回 [月, 日]，日为 0 表示月底。
const NO_YEAR = [
  [/(?<![\dA-Za-z\-:/.])(\d{2})-(\d{2})(?![\d\-:/])/g, (m) => [+m[1], +m[2]]],
  [/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g, (m) => [+m[1], +m[2]]],
  [/(?<!\d)(\d{1,2})\s*月底/g, (m) => [+m[1], 0]],
];

// 日期要挨着提示词才算（ops-private spec 2026-10-06「只认截止日期，久过期的让位」D9）。10-06 装上后实见：
// 标题里一份文件的版本日期被当成截止日，露成「已过 8 天」。后面的提示词前可以隔钟点、时区、上午晚上之类和一个「的」；
// 「交了」「发过」「课后」是过去的事，不算。「约」前面是别的汉字（合约、旧约）不算。认不准的照旧当没有日期。
const CUE_SKIP = /^\s*(?:\d{1,2}[:：]\d{2}|\d{1,2}\s*点)?\s*(?:(?:UTC|BST|GMT|CST)(?![A-Za-z]))?\s*(?:上午|下午|晚上|早上|中午|晚|早)?\s*的?\s*/i;
const CUE_AFTER = /^(?:前|之前|以前|截止|截至|到期|答应|说好|(?:提交|交|发|付|见|回)(?![了过])|课(?!后)|上课|会议|开会|冻结|终检|复查|能否|(?:deadline|due)(?![A-Za-z]))/i;
const CUE_BEFORE = /(?:截止|截至|最晚|不晚于|默认|建议|定时|(?:^|[^\p{Script=Han}]|[大预])约|周[一二三四五六日天]|星期[一二三四五六日天]|(?<![A-Za-z])(?:due|by|before|until|promised|deadline))[\s:：]*$/iu;
const cued = (s, at, len) => CUE_AFTER.test(s.slice(at + len).replace(CUE_SKIP, '')) || CUE_BEFORE.test(s.slice(0, at));

function todayNo(today) {
  if (typeof today === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
    return m ? { no: dayNo(+m[1], +m[2], +m[3]), y: +m[1] } : null;
  }
  const d = today instanceof Date ? today : new Date();
  return { no: dayNo(d.getFullYear(), d.getMonth() + 1, d.getDate()), y: d.getFullYear() };
}

/**
 * 标题里认得出、挨着提示词的日期离今天几天（负数是已过）；几个日期取最晚的（早的多半是「哪天说的」，晚的多半是截止）；认不出是 null。
 * 没写年份的在去年、今年、明年里取离今天最近的，一样近取晚的。today 是 'YYYY-MM-DD' 或 Date，不传就是本机今天。
 */
export function datedDays(text, today = new Date()) {
  const t = todayNo(today);
  if (!t || t.no === null) return null;
  let s = String(text ?? '').replace(BASIS_TAIL, '');
  const found = [];
  for (const [re, f] of WITH_YEAR) {
    for (const m of s.matchAll(re)) { const n = f(m); if (n !== null && cued(s, m.index, m[0].length)) found.push(n); }
    s = s.replace(re, (x) => ' '.repeat(x.length));   // 带年份的认过了，不让后面再从里面切出「07-31」
  }
  for (const [re, f] of NO_YEAR) {
    for (const m of s.matchAll(re)) {
      if (!cued(s, m.index, m[0].length)) continue;
      const [mo, d] = f(m);
      let best = null;
      for (const y of [t.y - 1, t.y, t.y + 1]) {
        const n = d === 0 ? monthEnd(y, mo) : dayNo(y, mo, d);
        if (n === null) continue;
        if (best === null || Math.abs(n - t.no) < Math.abs(best - t.no) || (Math.abs(n - t.no) === Math.abs(best - t.no) && n > best)) best = n;
      }
      if (best !== null) found.push(best);
    }
  }
  return found.length ? Math.max(...found) - t.no : null;
}

/**
 * 到了日子的项里取哪几项（spec D10）：已过的最多占一个，取过得最少的；其余给今天和最近的；只有一类就在那一类里取。
 * 10-06 前是「越早越先」，一件已过一个月、作者决定先放着的事会一直排第一，今天到的反而挤不进来。
 * due 的每项是 {d: 天数, i: 清单顺序}；取出来照旧按天数从早到晚排，一样的按清单顺序。
 */
export function pickDue(due, max = DATED_MAX) {
  const past = due.filter((e) => e.d < 0).sort((a, b) => (b.d - a.d) || (a.i - b.i));
  const next = due.filter((e) => e.d >= 0).sort((a, b) => (a.d - b.d) || (a.i - b.i));
  const out = past.length && max > 0 ? [past.shift()] : [];
  while (out.length < max && next.length) out.push(next.shift());
  while (out.length < max && past.length) out.push(past.shift());
  return out.sort((a, b) => (a.d - b.d) || (a.i - b.i));
}

/**
 * 回复里的那一行清单（作者 09-24：「每次回复应该有一个 inline 的 todolist」）。钩子写好，模型照抄——
 * 让模型从十几项里自己摘，摘法每轮会不一样；照抄一行，本轮有变化再改。
 * today 只给测试用（'YYYY-MM-DD'），平时按本机今天算带日期的项。
 */
export function inlineLine(open, lang = 'zh', today = new Date()) {
  const T = (zh, en) => pick(lang, zh, en);
  const by = (st) => open.filter((x) => x.status === st);
  const parts = [];
  const doing = by('在做');
  if (doing.length) {
    parts.push(T('◧ 在做 ', '◧ Doing ') + doing.slice(0, 2).map((x) => `${x.id} ${brief(x.text, lang)}`).join(T('、', ', '))
      + (doing.length > 2 ? T(` 等 ${doing.length} 项`, ` and ${doing.length - 2} more`) : ''));
  }
  // 最近动过的等你排前面：按编号列出来的总是最早那两项，而那两项往往早就没人问了。
  const you = by('等你').map((x, i) => [x, i])
    .sort((a, b) => ((b[0].touched ?? -1) - (a[0].touched ?? -1)) || (a[1] - b[1])).map(([x]) => x);
  if (you.length) {
    parts.push(T(`□ 等你 ${you.length}：`, `□ Waiting on you ${you.length}: `) + you.slice(0, 2).map((x) => `${x.id} ${brief(x.text, lang)}`).join(T('、', ', ')) + (you.length > 2 ? '…' : ''));
  }
  // 等别的、以后：只写个数，带日期、到了日子的露出来（全行最多 DATED_MAX 项，取法见 pickDue）。
  // 一组里还有到了日子、因为上限没露的，末尾加「…」，和等你组的写法一样。
  const due = open.map((x, i) => ({ x, i, d: x.status === '等' || x.status === '以后' ? datedDays(x.text, today) : null }))
    .filter((e) => e.d !== null && e.d <= DATED_DAYS);
  const picked = pickDue(due);
  const when = (d) => (d < 0 ? T(`已过 ${-d} 天`, `${-d} day${d === -1 ? '' : 's'} ago`)
    : d === 0 ? T('今天', 'today') : T(`还有 ${d} 天`, `in ${d} day${d === 1 ? '' : 's'}`));
  const withDue = (st, head) => {
    const shown = picked.filter((e) => e.x.status === st);
    if (!shown.length) return head;
    const more = due.some((e) => e.x.status === st && !picked.includes(e));
    return head + T('：', ': ') + shown.map((e) => `${e.x.id} ${brief(e.x.text, lang)}${T(`（${when(e.d)}）`, ` (${when(e.d)})`)}`).join(T('、', ', '))
      + (more ? '…' : '');
  };
  const other = by('等');
  if (other.length) parts.push(withDue('等', T(`⬚ 等别的 ${other.length}`, `⬚ Waiting on other ${other.length}`)));
  const later = by('以后');
  if (later.length) parts.push(withDue('以后', T(`▫ 以后 ${later.length}`, `▫ Later ${later.length}`)));
  return parts.length ? T('清单：', 'List: ') + parts.join(T(' ｜ ', ' | ')) : T('清单：没有开着的事', 'List: nothing open');
}

export const REFRESH_TURNS = 10;

/**
 * 稿件待做对号（2026-10-04 spec「稿件待做挂上对话清单」D3）。manuscripts 来自 _inbox.mjs hookupNotes。
 * 「没挂上」：开着的待做，没有任何开着的清单项属于它，也没写「不挂」。
 * 「对不上」：那边关了、属于它的清单项还开着；那边在做、属于它的开着的清单项全是以后。
 * 返回 {sig, lines(titled)}：sig 是没挂上的那一组（集合变了才写标题），lines(true/false) 给出要说的行。
 */
export function hookupCheck(items, manuscripts, unhooked, lang = 'zh') {
  const T = (zh, en) => pick(lang, zh, en);
  const ms = Array.isArray(manuscripts) ? manuscripts : [];
  if (!ms.length) return null;
  const skip = unhooked && typeof unhooked === 'object' ? unhooked : {};
  const open = (items ?? []).filter((x) => !CLOSED.has(x.status));
  // 每个开着的清单项属于哪几件：写的时候没开对号、存的是裸编号的，这里再对一次。
  const owners = new Map();
  for (const x of open) {
    for (const ref of x.of ?? []) {
      const r = resolveTodo(ref, ms, lang);
      if (r.problem) continue;
      if (!owners.has(r.key)) owners.set(r.key, []);
      if (!owners.get(r.key).includes(x)) owners.get(r.key).push(x);
    }
  }
  const several = ms.length > 1;
  const doing = (st) => st === '在做' || /^doing$/i.test(st);
  const out = [];
  const sig = [];
  for (const m of ms) {
    const ref = (id) => (several ? `${m.workspace} ${id}` : id);
    const loose = [];
    const off = [];
    for (const t of m.todo) {
      const key = `${m.workspace} ${t.id}`;
      const ls = owners.get(key) ?? [];
      const ids = ls.map((x) => x.id).join(T('、', ', '));
      if (t.closed) {
        if (ls.length) off.push(T(`${t.id} 那边已关，属于它的 ${ids} 还开着`, `${t.id} is closed there but ${ids} belonging to it ${ls.length > 1 ? 'are' : 'is'} still open`));
        continue;
      }
      if (!ls.length) { if (!skip[key]) loose.push(t); continue; }
      if (doing(t.state) && ls.every((x) => x.status === '以后')) {
        off.push(T(`${t.id} 在做，属于它的 ${ids} 全是以后`, `${t.id} is in progress but ${ids} belonging to it ${ls.length > 1 ? 'are all' : 'is'} later`));
      }
    }
    if (loose.length) {
      sig.push(...loose.map((t) => `${m.workspace} ${t.id}`));
      const first = ref(loose[0].id);
      out.push((titled) => T(
        `稿件 ${m.workspace} 开着、清单里没挂：${titled ? loose.map((t) => `${t.id} ${brief(t.title)}·${t.state}`).join('、') : `${loose.map((t) => t.id).join('、')}（标题同上一轮）`}。`
          + `挂上写「Lx 属于：${first}」，不挂写「${first} 不挂：<理由>」。`,
        `Manuscript ${m.workspace} has open items no list item belongs to: ${titled ? loose.map((t) => `${t.id} ${brief(t.title, 'en')} (${t.state})`).join(', ') : `${loose.map((t) => t.id).join(', ')} (titles as last turn)`}. `
          + `To hook one up write "Lx belongs to: ${first}"; to leave it out write "${first} not hooked: <reason>".`));
    }
    if (off.length) {
      const text = T(`稿件 ${m.workspace} 对不上：${off.join('；')}。`, `Manuscript ${m.workspace} doesn't match the list: ${off.join('; ')}.`);
      out.push(() => text);
    }
  }
  return { sig: sig.sort().join('|'), lines: (titled) => out.map((f) => f(titled)) };
}

/** 开着的项里写了「挡着」的，按挡着的开着的项与外部事件的多少排，取前三（spec D2 的候选，只给数不替模型选）。 */
export function blockCandidates(items) {
  const open = new Set(items.filter((x) => !CLOSED.has(x.status)).map((x) => x.id));
  return items.filter((x) => open.has(x.id) && x.blocks?.length)
    .map((x) => ({ id: x.id, n: x.blocks.filter((t) => !/^L\d+$/.test(t) || open.has(t)).length }))
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n || Number(a.id.slice(1)) - Number(b.id.slice(1)))
    .slice(0, 3);
}

/**
 * 回复最后一行「下一步」有没有点到清单上开着的项（spec D2）。清单上没有开着的项、或这一轮没写「下一步」时不管。
 * 返回要在下一轮说出来的问题，没有问题是 null。
 */
export function nextProblem(next, items, lang = 'zh') {
  const T = (zh, en) => pick(lang, zh, en);
  if (typeof next !== 'string' || !next.trim() || !Array.isArray(items)) return null;
  if (!items.some((x) => !CLOSED.has(x.status))) return null;
  const ids = [...next.matchAll(/(?<![A-Za-z0-9])L(\d+)(?!\d)/g)].map((m) => `L${m[1]}`);
  if (!ids.length) return T('上一轮的「下一步」没点清单上的编号', 'Last turn\'s "Next:" named no list ID');
  const openIds = ids.filter((id) => items.some((x) => x.id === id && !CLOSED.has(x.status)));
  if (!openIds.length) return T(`上一轮的「下一步」点的 ${ids.join('、')} 不是开着的项`, `Last turn's "Next:" named ${ids.join(', ')}, which is not open`);
  return null;
}

/**
 * 这一轮注入的清单：{text, shown}。mode：'full'（普通轮）或 'always'（短确认、系统信封：只放等你的）。
 *
 * 注入的内容会一直留在对话里。清单没变时每轮重列一遍，一百轮就是十几万 token 的重复，所以普通轮里：
 * 清单自上次完整列出以来有变化，或者隔了 REFRESH_TURNS 轮（压缩上下文会丢掉早先那份）——完整列；
 * 否则只列等你的、N 轮没动的和问题，并说其余和第几轮列的一样。shown 是新的「上次完整列出」，没完整列就原样返回。
 * 上一次有变化的那一轮留下的问题照样带上，直到下一份快照。
 */
export function listBlock(sessionId, mode, turnIndex, lastShown = null, lang = 'zh', manuscripts = undefined) {
  const T = (zh, en) => pick(lang, zh, en);
  // 开了对号的稿件（spec「稿件待做挂上对话清单」D3）：只在普通轮说；还没有清单时也要说，没挂上的正是这时最多。
  const ms = mode === 'full' ? (manuscripts ?? hookupNotes(sessionId)) : [];
  let cur = readList(sessionId);
  if (cur === null && ms.length) cur = { items: [], problems: [] };
  if (cur === null) return { text: null, shown: lastShown };
  if (cur.error) return { text: T(`【Wishing-Willow · 清单】清单文件读不出（${cur.error}），不能当作没有开着的事。`,
    `[Wishing-Willow · List] The list file can't be read (${cur.error}). Don't take that as nothing being open.`), shown: lastShown };
  const snap = `${cur.turnIndex ?? ''}@${cur.at ?? ''}`;
  const full = mode === 'full' && (!lastShown || lastShown.snap !== snap
    || typeof lastShown.turn !== 'number' || typeof turnIndex !== 'number' || turnIndex - lastShown.turn >= REFRESH_TURNS);
  const open = cur.items.filter((x) => !CLOSED.has(x.status));
  const idleOf = (x) => ((x.status === '在做' || x.status === '等你') && typeof turnIndex === 'number' && typeof x.touched === 'number'
    ? turnIndex - x.touched : 0);
  const staleAt = (x) => (x.status === '等你' ? STALE_YOU_TURNS : STALE_TURNS);
  const shownItems = full ? open : open.filter((x) => x.status === '等你' || (mode === 'full' && x.status === '在做' && idleOf(x) >= STALE_TURNS));
  // 「属于」只在完整列出的那一轮注：其余轮列出的等你、挂久的项，关系在那一轮已经交给模型了（A5 实测：每轮都注，
  // 十项挂久的就多一百多字）。只开了一篇稿子时只写编号。
  // 做完判据的状态（spec 2026-10-07 D5）：带判据的项后面标出来。核查结果只在有带判据的项时读。
  const checks = open.some((x) => x.check) ? readChecks(sessionId) : null;
  const ofs = (x) => (full && x.of?.length ? x.of.map((r) => (ms.length === 1 && r.startsWith(`${ms[0].workspace} `) ? r.slice(ms[0].workspace.length + 1) : r)) : null);
  const lines = shownItems.map((x) => {
    const idle = idleOf(x);
    if (lang === 'en') {
      return `${x.id} ${label(x, lang)}: ${x.text}`
        + (x.blocks?.length ? ` (blocks ${x.blocks.join(', ')})` : '')
        + (ofs(x) ? ` (belongs to ${ofs(x).join(', ')})` : '')
        + (x.basis && x.basis !== '预测' ? ` (basis: ${x.basis})` : '')
        + (x.check ? checkLabel(x, checks, lang) : '')
        + (x.approvedTurn ? ' (approved)' : '')
        + (idle >= staleAt(x) ? ` (untouched for ${idle} turns)` : '');
    }
    return `${x.id} ${label(x)}：${x.text}`
      + (x.blocks?.length ? `（挡着 ${x.blocks.join('、')}）` : '')
      + (ofs(x) ? `（属于 ${ofs(x).join('、')}）` : '')
      + (x.basis && x.basis !== '预测' ? `（依据：${x.basis}）` : '')
      + (x.check ? checkLabel(x, checks) : '')
      + (x.approvedTurn ? '（已认可）' : '')
      + (idle >= staleAt(x) ? `（${idle} 轮没动）` : '');
  });
  const problems = Array.isArray(cur.problems) ? cur.problems : [];
  const rest = open.length - shownItems.length;
  const count = (st) => open.filter((x) => x.status === st).length;
  const head = T(`【Wishing-Willow · 清单】开着 ${open.length} 项（等你 ${count('等你')}、在做 ${count('在做')}、`
    + `等别的 ${count('等')}、以后 ${count('以后')}）。编号给「清单变化：」用；清单只在本机，别抄进公开仓。`,
  `[Wishing-Willow · List] ${open.length} open (waiting on you ${count('等你')}, doing ${count('在做')}, `
    + `waiting on other ${count('等')}, later ${count('以后')}). The IDs are for "List changes:". The list stays on this Mac; don't copy it into public repos.`);
  const tail = [];
  if (!full && mode === 'full' && rest > 0) tail.push(T(`其余 ${rest} 项和第 ${lastShown.turn} 轮列出的一样。`, rest === 1 ? `The other item is as listed in turn ${lastShown.turn}.` : `The other ${rest} are as listed in turn ${lastShown.turn}.`));
  if (problems.length) tail.push(T(`上一次清单变化的问题：${problems.join('；')}`, `Problems with the last list changes: ${problems.join('; ')}`));
  const cands = blockCandidates(cur.items);
  if (cands.length) {
    tail.push(T(`按挡着的多少：${cands.map((c) => `${c.id}（挡着 ${c.n} 件）`).join('、')}`,
      `By what they block: ${cands.map((c) => `${c.id} (blocks ${c.n})`).join(', ')}`));
  }
  // 稿件待做对号：非空就每轮说（作者 10-04 认可）；没挂上的那一组变了（或压缩后）才写标题，其余轮只写编号。
  const hk = hookupCheck(cur.items, ms, cur.unhooked, lang);
  if (hk) tail.push(...hk.lines(!lastShown || lastShown.hookup !== hk.sig));
  // 每条回复都带：短确认、系统信封开始的一轮也一样。
  tail.push(T(`回复末尾照写这一行（本轮有变化就先改好）：\n${inlineLine(open)}`, `End your reply with this line (update it first if the list changed this turn):\n${inlineLine(open, lang)}`));
  let shown = full ? { snap, turn: turnIndex } : lastShown;
  if (hk) shown = { ...(shown ?? {}), hookup: hk.sig };
  return { text: [head, ...lines, ...tail].join('\n'), shown, items: cur.items };
}
