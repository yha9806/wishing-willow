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

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './_willow.mjs';
import { pick } from './_lang.mjs';

const str = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null);

/**
 * 这一轮要替别的来源说的话。mode：'full'（普通轮）或 'always'（短确认、系统信封开始的一轮）。
 * 返回 null（没有要说的），或一段文字。读不出的留言文件照实说出来，不能当作没有。
 */
export function inboxText(sessionId, promptId, mode, lang = 'zh') {
  const dir = join(stateDir(), 'inbox');
  if (!existsSync(dir)) return null;
  const entries = [];
  const bad = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let e;
    try { e = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { bad.push(f); continue; }
    if (!e || typeof e !== 'object' || !e.sessions || typeof e.sessions !== 'object') { bad.push(f); continue; }
    const s = e.sessions[sessionId];
    if (!s || typeof s !== 'object') continue;
    if (typeof promptId === 'string' && s.since === promptId) continue;
    const parts = s.role === 'history' ? [str(e.history)]
      : mode === 'full' ? [str(e.full), str(e.always)] : [str(e.always)];
    const text = parts.filter(Boolean).join('\n');
    if (text) entries.push({ p: Number(e.priority) || 0, text: `【${str(e.label) ?? str(e.source) ?? f}】\n${text}` });
  }
  entries.sort((a, b) => b.p - a.p);
  const out = entries.map((x) => x.text);
  if (bad.length) out.push(pick(lang, `【Wishing-Willow】留言读不出：${bad.join('、')}。这一轮没带上它们要说的话，不能当作没有。`,
    `[Wishing-Willow] Messages that can't be read: ${bad.join(', ')}. This turn doesn't carry what they say; don't take that as there being none.`));
  return out.length ? out.join('\n\n') : null;
}
