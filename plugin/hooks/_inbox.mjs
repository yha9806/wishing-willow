// 别的来源留给模型的话，由许愿柳这一个出口一起说。
//
// 以前写作循环在 UserPromptSubmit 里自己往模型塞一段，许愿柳也塞一段：同一个会话里两个出口，
// 短确认的轮次一边跳过、一边不跳。现在写作循环把要说的写进 <状态目录>/inbox/<来源>.<…>.json，
// 许愿柳读了一起说，轮次规则只有这一份。
//
// 哪些会话算那份稿件，仍由写作循环判定（cwd＋分支），它把会话 id 写进 sessions；这里只认会话 id，
// 不重做那条规则——重做就又是两份。
//
// 两个 UserPromptSubmit 钩子是并行跑的。写作循环第一次见到一个会话，这一轮它自己说，
// 并在 since 里记下这一轮的 prompt_id；这里见到 since 等于这一轮就不再重复。
//
// 一份留言可以带这份稿件的判定（verdict，可选，2026-10-07）：顶层 "verdict": {"ready": true | false, "text": "<一行>"}，
// 一份留言（一份稿件）一个。这里不转达它；结束钩子拿它对这一轮回复里的「做完了」（_claim.mjs）。
// 没有这个键，一切照旧。有就必须是这个形状：ready 是布尔，text 是非空字符串（换行折成空格，别的键不管）；
// 别的值（null 也算）是读不出，对属于它的会话每轮照实说，不当作没有、也不当作就绪。没有判定就别写这个键。

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './_willow.mjs';
import { pick } from './_lang.mjs';

const str = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null);

/**
 * 这一轮要替别的来源说的话。mode：'full'（普通轮）或 'always'（短确认、系统信封开始的一轮）。
 * said：上次转达给这个会话的信息段 {<文件>:<段>: 文字}，存在会话状态里（capture 的 inboxSaid）。
 * 返回 {text, said}：text 为 null（没有要说的）或一段文字；said 是这一轮之后的记忆。读不出的留言文件照实说出来，不能当作没有。
 *
 * 注入瘦身 D1（2026-09-30）：信息段（always 那一行、history 那一行）和上次转达的一字不差就不再说——
 * 历史来源会话里，同一行覆盖原来每轮都说一遍，一直占着上下文。规则段（full，比如写作循环的说明块）
 * 每个普通轮照说：逐轮日志里，这一轮没提醒规则时，按规则写的比例明显更低。
 * 压缩后 compacted 清掉这份记忆，下一轮全部重说。WILLOW_INBOX_EVERY_TURN=1 退回每轮都说。
 */
export function inboxText(sessionId, promptId, mode, lang = 'zh', said = null) {
  const dir = join(stateDir(), 'inbox');
  if (!existsSync(dir)) return { text: null, said };
  const dedupe = process.env.WILLOW_INBOX_EVERY_TURN !== '1';
  const next = { ...(said ?? {}) };
  const entries = [];
  const bad = [];
  const badVerdict = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let e;
    try { e = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { bad.push(f); continue; }
    if (!e || typeof e !== 'object' || !e.sessions || typeof e.sessions !== 'object') { bad.push(f); continue; }
    const s = e.sessions[sessionId];
    if (!s || typeof s !== 'object') continue;
    // 判定读不出：留言别的部分照旧转达，只把这一处照实说出来。写作循环自己说的那一轮（下面 since）它也不知道，照样说。
    if (verdictOf(e) === 'bad') badVerdict.push(f);
    const history = s.role === 'history';
    const info = history ? str(e.history) : str(e.always);
    const key = `${f}:${history ? 'history' : 'always'}`;
    // 写作循环这一轮自己说了（第一次见到这个会话）：不重复，但记下它说过的那一行。
    if (typeof promptId === 'string' && s.since === promptId) {
      if (info) next[key] = info;
      continue;
    }
    const rules = !history && mode === 'full' ? str(e.full) : null;
    const fresh = info && !(dedupe && next[key] === info) ? info : null;
    if (info) next[key] = info; else delete next[key];
    const text = [rules, fresh].filter(Boolean).join('\n');
    if (text) entries.push({ p: Number(e.priority) || 0, text: `【${str(e.label) ?? str(e.source) ?? f}】\n${text}` });
  }
  entries.sort((a, b) => b.p - a.p);
  const out = entries.map((x) => x.text);
  if (bad.length) out.push(pick(lang, `【Wishing-Willow】留言读不出：${bad.join('、')}。这一轮没带上它们要说的话，不能当作没有。`,
    `[Wishing-Willow] Messages that can't be read: ${bad.join(', ')}. This turn doesn't carry what they say; don't take that as there being none.`));
  if (badVerdict.length) out.push(pick(lang,
    `【Wishing-Willow】留言里的判定读不出：${badVerdict.join('、')}（verdict 要写成 {"ready": true 或 false, "text": "<一行>"}）。不知道它判的是什么，不能当作已就绪。`,
    `[Wishing-Willow] A verdict in a message can't be read: ${badVerdict.join(', ')} (verdict must be {"ready": true or false, "text": "<one line>"}). What it says is unknown; don't take it as ready.`));
  return { text: out.length ? out.join('\n\n') : null, said: Object.keys(next).length ? next : null };
}

/**
 * 开了对号的稿件（2026-10-04 spec「稿件待做挂上对话清单」D3）：本会话是它的改稿会话（primary）、留言里 hookup 为 true、
 * todo 是数组的那几份，各给出 {workspace, todo: [{id, title, state, closed}]}。历史来源会话、没开的、todo 为 null
 * （没有主张清单或算不出）的都不算：null 不是「全关了」，不对号也就不说。读不出的留言 inboxText 照实说，这里跳过。
 * opts.dir 换一个留言目录、opts.anySwitch 不管开关：只给预览用（listctl --hookup-preview）。
 */
export function hookupNotes(sessionId, opts = {}) {
  const dir = opts.dir ?? join(stateDir(), 'inbox');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let e;
    try { e = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    const s = e?.sessions?.[sessionId];
    if (!s || s.role !== 'primary' || (e.hookup !== true && !opts.anySwitch) || !Array.isArray(e.todo)) continue;
    const todo = e.todo.filter((t) => t && typeof t.id === 'string' && t.id.trim()).map((t) => ({
      id: t.id.trim(), title: str(t.title) ?? '', state: str(t.state) ?? '', closed: t.closed === true,
    }));
    out.push({ workspace: str(e.workspace) ?? f, todo });
  }
  return out;
}

/**
 * 一份留言里的判定（见文件头）：没有 verdict 这个键是 null；形状对是 {ready, text}；别的（null、ready 不是布尔、text 为空……）是 'bad'。
 */
export function verdictOf(e) {
  if (!e || typeof e !== 'object' || !Object.hasOwn(e, 'verdict')) return null;
  const v = e.verdict;
  const text = v && typeof v === 'object' && !Array.isArray(v) ? str(v.text) : null;
  if (typeof v?.ready !== 'boolean' || !text) return 'bad';
  return { ready: v.ready, text: text.replace(/\s*\n\s*/g, ' ') };
}

/**
 * 本会话所属的各份留言（sessions 里有这个会话，改稿会话与历史来源会话都算）里读得出的判定：[{file, label, ready, text}]。
 * 读不出的文件、没有判定的、判定读不出的都不在里面——后两种 inboxText 每轮照实说。
 */
export function sessionVerdicts(sessionId) {
  const dir = join(stateDir(), 'inbox');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let e;
    try { e = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    const s = e?.sessions?.[sessionId];
    if (!s || typeof s !== 'object') continue;
    const v = verdictOf(e);
    if (v && v !== 'bad') out.push({ file: f, label: str(e.label) ?? str(e.source) ?? f, ...v });
  }
  return out;
}
