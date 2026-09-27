// 注入给模型的话用哪种语言（2026-09-27 装机演练 F2：以前一律中文，英文用户装上后四行和清单规则都是中文）。
//
// 只管「写给模型的」那一侧：四行提醒、清单规则、清单块、压缩后重交、状态栏标签、listctl 的回话。
// 读的一侧（_willow.mjs 的声明行、_list.mjs 的清单变化）两种语言都认，不看这里——
// 一个会话中途换了语言，前面用另一种写的行照样算数。清单在磁盘上的状态值始终是中文键（在做/等你/…），app 按键翻译。
//
// 顺序：WILLOW_LANG（zh / en）> 这一轮的原话 > 这个会话上一轮定下的 > 系统语言。

import { execFileSync } from 'node:child_process';

const forced = () => {
  const v = (process.env.WILLOW_LANG ?? '').trim().toLowerCase();
  return v.startsWith('zh') ? 'zh' : v.startsWith('en') ? 'en' : null;
};

let systemCache;
/** 系统语言。环境变量没说的时候（从 Claude Code 起的钩子通常没有 LANG），macOS 上读 AppleLanguages 的第一项。 */
export function systemLang() {
  const f = forced();
  if (f) return f;
  if (systemCache) return systemCache;
  const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  let tag = env && !/^(C|POSIX)(\.|$)/.test(env) ? env : '';
  if (!tag && process.platform === 'darwin') {
    try {
      const out = execFileSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore'] });
      tag = (out.match(/"?([A-Za-z]{2,3}[-_A-Za-z]*)"?/) ?? [])[1] ?? '';
    } catch { /* 读不出就按英文 */ }
  }
  if (!tag) tag = Intl.DateTimeFormat().resolvedOptions().locale ?? '';
  systemCache = /^zh/i.test(tag) ? 'zh' : 'en';
  return systemCache;
}

/**
 * 按这一轮的原话定语言。prev 是这个会话上一轮定下的（没有就是 null）。
 * 有了会话语言以后要换，得换得明白：中文会话里贴一大段英文日志，只要还有一个汉字就不换；
 * 英文会话里提到一个中文名字，汉字比英文词少就不换。太短的（「好」「ok」）不作数，沿用上一轮。
 */
export function promptLang(prompt, prev) {
  const f = forced();
  if (f) return f;
  if (typeof prompt !== 'string') return prev ?? systemLang();
  const han = (prompt.match(/\p{Script=Han}/gu) ?? []).length;
  const words = (prompt.match(/[A-Za-z]+/g) ?? []).length;
  if (prev === 'zh') return han === 0 && words >= 3 ? 'en' : 'zh';
  if (prev === 'en') return han > 0 && han >= words ? 'zh' : 'en';
  if (han === 0 && words === 0) return systemLang();
  return han >= 4 || han >= words ? 'zh' : 'en';
}

/** 状态文件里记下的语言；老状态没有这一位时按系统语言。 */
export function sessionLang(state) {
  const f = forced();
  if (f) return f;
  return state?.lang === 'zh' || state?.lang === 'en' ? state.lang : systemLang();
}

export const pick = (lang, zh, en) => (lang === 'en' ? en : zh);
