// 说「做完了」对上来源的判定（2026-10-07）。
//
// 写作循环这类来源可以在留言里写这份稿件的判定（verdict：{ready, text}，见 _inbox.mjs verdictOf）。
// 实见：单项检查一项项报绿，回复就对用户说做完了，而循环那一行开头写的是「未就绪」。
// 所以结束钩子看这一轮回复的最后一段：说了做完、可以投，而本会话所属的留言里有一份判的是没就绪，
// 就记下一句，下一轮开头和留言一起说一次（capture 说完就清掉；压缩后不重说）。没有判定、判的是就绪、没说完成，都不说。
//
// 只看最后一段（最后一次调用工具之后写的，_willow.mjs turnFinalText）：中途的「装好了、甲跑完了」是进度，不是交差。
// 判的只是说法，不判做没做完；说法只认下面这张表，要改先看表后的已知误报与漏报，tests/claim 里各有用例钉着。

import { pick } from './_lang.mjs';

// ── 认的说法 ──────────────────────────────────────────────────────────────────
// 中文逐字。从左往右取第一处（「都做完了」而不是其中的「做完了」）；同一处有几个说法互为前缀时取长的（现在没有，留给以后加的）。
const ZH = [
  '都做完了', '都写完了', '都改完了', '都完成了', '全都做完', '全部做完', '全部写完', '全部完成',
  '做完了', '写完了', '完成了', '已完成', '定稿了',
  '可以投了', '可以投稿', '可以投出', '可以上传', '可以提交',
];
// 英文。比较前把弯引号 ’ 换成 '。
const EN = [
  /\bready (?:to submit|for submission|to upload)\b/gi,
  /\ball done\b/gi,
  /\b(?:it|everything)(?:'s| is) (?:all )?(?:done|finished|complete)\b/gi,
  /\bwe(?:'re| are) (?:all )?(?:done|finished)\b/gi,
  /^[ \t]*(?:\*\*|__)?(?:done|finished)(?=[*_]*[ \t]*[.!:])/gim,   // 一行开头的「Done.」「Finished:」
];
const ZH_RE = new RegExp([...ZH].sort((a, b) => b.length - a.length).join('|'), 'gu');

// ── 不算的 ────────────────────────────────────────────────────────────────────
// 回复里的固定行：开头四行、清单、清单变化（+ 新增、L3 …）、下一步、计划卡。「你批准的：把第二节写完了就推」说的是请求。
const FIXED = /^\s*(?:[-*]\s+)?(?:>|\\?\+|L\d+\s|[①②③④⑤⑥⑦⑧⑨⑩]|(?:你批准的|我读成了|我理解为|我补上的|标签|清单变化|清单|下一步|计划卡[^：:\n]*|计划|不做|You approved|How I read it|Read as|What I filled in|Tag|List changes|List|Next|Plan card[^：:\n]*|Plan|Not doing)\s*[：:])/iu;
// 引号、行内代码、代码块里的是引用别人的话或命令，不是这一轮在说完成（下一轮转述「上一轮说「做完了」」也不能再触发一次）。
const QUOTED = /「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|‘[^’\n]*’|"[^"\n]*"|`[^`\n]*`/g;
// 说法前面、同一个分句里的否定（「不过」不算）；紧挨着的单字否定（「不可以提交」「没写完了」）。
const ZH_NOT = /不是|不能|不算|不等于|不代表|不可|不要|别说|并非|并没|没有|还没|尚未|未必|远没/;
const ZH_NOT_ADJ = /[不没未别非]$/;
const EN_NOT = /\b(?:not|never|no|nothing|nor|cannot)\b|n't\b/i;
// 转述：「上一轮我说都做完了，其实…」「I said it's done」——下一轮回头说上一轮的话，不能再触发一次。
const ZH_SAID = /说$/;
const EN_SAID = /\bsaid\b/i;
// 问句：说法前的「是不是、有没有」，说法后紧跟的「吗、没有」，或这个分句以问号结尾。
const ZH_ASK_BEFORE = /是不是|是否|有没有|能不能|可不可以|可否|算不算/;
const ZH_ASK_AFTER = /^\s*(?:吗|么|嘛|呢|没|与否|什么|哪些)/;
// 条件与将来：分句里说法前的「等、如果」，说法后紧跟的「再、就、之后」，或整句以「等、如果、once」起头。
const ZH_IF_BEFORE = /如果|要是|一旦|假如|只要|直到|除非|^\s*(?:等|若)/;   // 「等」「若」只认在分句开头：「不等于」「表格等」不是
const ZH_IF_ADJ = /才$/;
const ZH_IF_AFTER = /^\s*(?:再|就|之后|以后|后|才|的话|时|前)/;
const EN_IF = /\b(?:if|once|when|whenever|until|after|before|unless|whether|as soon as|will|would|should|could|might|may)\b|'ll\b/i;
const SENTENCE_IF = /^\s*(?:等|如果|要是|若|一旦|假如|只要|直到|除非|if\b|once\b|when\b|until\b|after\b|unless\b|as soon as\b)/i;

// ── 已知误报（会说，其实不该）──
// 说的是一小件事：「这一段写完了」「第一步完成了」「All done with step one」——说法表不看说的是哪件事。
// 「可以提交」「可以上传」也指 git 提交、上传到服务器。
// 同一句里条件在别的分句、又不在句首：「改完这处就可以投了」。
// ── 已知漏报（不说，其实该说）──
// 不带「了」的「写完」「做完」（「稿子写完。」）；「改好了」「都弄好了」「能投了」「搞定」；
// 分句里有「没有」却不是在否定说法（「没有问题，都做完了」用了逗号的不受影响）；说法后紧跟「没」「就」的（「都做完了没问题」「都做完了就差投」）；
// 英文 "The paper is complete."、"We're good to go."、"Finished the edits."、"I'm done."、行首带列表符号的 "- Done:"；
// 只说在中途、最后一段没说的（只看最后一段，见文件头）。

function plain(text) {
  const t = String(text).replace(/\r/g, '').replace(/```[\s\S]*?```/g, ' ');
  return t.split('\n').filter((l) => !FIXED.test(l)).join('\n').replace(QUOTED, ' ').replace(/’/g, "'");
}

const CLAUSE = /[，。！？；：,.!?;:\n]/;
/** 说法前面、同一个分句里的文字（最多 40 字）。 */
function before(t, i) {
  let s = i;
  while (s > 0 && !CLAUSE.test(t[s - 1])) s--;
  return t.slice(Math.max(s, i - 40), i);
}
/** 说法后面到这个分句结束；分句以问号结束时带上问号。 */
const after = (t, j) => /^[^，。！？；：,.!?;:\n]*[？?]?/u.exec(t.slice(j))[0];
/** 说法所在这句话从句首到说法前的文字。 */
function sentence(t, i) {
  let s = i;
  while (s > 0 && !/[。！？!?\n]/.test(t[s - 1]) && !(t[s - 1] === '.' && /\s/.test(t[s] ?? ''))) s--;
  return t.slice(s, i);
}

function counts(t, i, j, zh) {
  const b = before(t, i);
  const a = after(t, j);
  if (/[？?]$/.test(a) || SENTENCE_IF.test(sentence(t, i))) return false;
  if (zh) {
    return !(ZH_NOT.test(b) || ZH_NOT_ADJ.test(b) || ZH_SAID.test(b) || ZH_ASK_BEFORE.test(b) || ZH_ASK_AFTER.test(a)
      || ZH_IF_BEFORE.test(b) || ZH_IF_ADJ.test(b) || ZH_IF_AFTER.test(a));
  }
  return !(EN_NOT.test(b) || EN_SAID.test(b) || EN_IF.test(b));
}

/** 这段文字里第一个算数的「做完了」说法（原样，弯引号已换直），没有就 null。 */
export function findClaim(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const t = plain(text);
  let best = null;
  for (const [re, zh] of [[ZH_RE, true], ...EN.map((r) => [r, false])]) {
    for (const m of t.matchAll(re)) {
      if (best && m.index >= best.index) break;
      if (counts(t, m.index, m.index + m[0].length, zh)) { best = { index: m.index, phrase: m[0].replace(/^[\s*_]+/, '') }; break; }
    }
  }
  return best?.phrase ?? null;
}

/** 下一轮说的那一句。sources：判定没就绪的那几份留言 [{label, text}]。 */
export function claimText(phrase, sources, lang = 'zh') {
  return pick(lang,
    `【Wishing-Willow】上一轮回复说「${phrase}」，但${sources.map((s) => `「${s.label}」的判定是「${s.text}」`).join('，')}。`
      + '说完成要按来源的判定说；单项检查通过不等于完成。',
    `[Wishing-Willow] Your last reply said "${phrase}", but ${sources.map((s) => `"${s.label}" says "${s.text}"`).join(' and ')}. `
      + 'Call it finished only as the source\'s verdict does; single checks passing is not finished.');
}

/**
 * 这一轮要记下的那一句，或 null。text：这一轮回复的最后一段；verdicts：本会话所属留言的判定（_inbox.mjs sessionVerdicts），
 * 给函数时只在认出说法以后才读留言。
 */
export function claimProblem(text, verdicts, lang = 'zh') {
  const phrase = findClaim(text);
  if (!phrase) return null;
  const not = (typeof verdicts === 'function' ? verdicts() : verdicts ?? []).filter((v) => v?.ready === false);
  return not.length ? claimText(phrase, not, lang) : null;
}
