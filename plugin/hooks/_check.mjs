// 清单项的做完判据（ops-private spec 2026-10-07「清单项的做完判据」D1–D8）。
//
// 一项只有模型写「L3 做完」才会关：推送了、PR 合了、文件交出去了，清单都不知道（10-06 实见：交给作者勾的 36 个旧项，
// 21 个其实已做完或被取代）。现在一项可以带一句机器能核的判据，这里去核；全部满足、项还开着，下一轮点名一次。不自动关。
//
// 只认四种：合并 <owner>/<repo>#<n>、推到 <owner>/<repo> <分支> <提交号>、文件 <绝对路径或 ~/…>、进程退出 <pid>；
// 「；」连写，全部满足才算。其余照记，人工判。不支持「跑一条命令看结果」：钩子替模型跑命令会绕过 Claude Code 的权限确认。
//
// 谁核：一轮开头的钩子只读结果（它挡着用户的回车）；一轮结束的钩子和 listctl 发现有该核的，起一个脱离的核查进程
// （check.mjs），它把结果写进 <状态目录>/<会话>.checks。不用 .json 结尾：app 把状态目录顶层的 .json 都当会话。

import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './_willow.mjs';
import { pick } from './_lang.mjs';

const CLOSED = new Set(['做完', '撤掉']);
// D4：满足了不再核；没满足的联网判据 10 分钟内不重核，本机的 1 分钟。
export const TTL_NET_MS = 10 * 60 * 1000;
export const TTL_LOCAL_MS = 60 * 1000;
export const GH_TIMEOUT_MS = 8000;
export const RUN_BUDGET_MS = 60 * 1000;
export const LOCK_STALE_MS = 2 * 60 * 1000;
const NEWS_SHOW = 6;

// 参数白名单：仓库名、分支、提交号、pid。不合的整条进「认不出」，不会拿去调 gh。
const REPO = '([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)';
const KINDS = [
  ['merged', new RegExp(`^(?:合并|merged)\\s*[：:]?\\s*${REPO}#(\\d{1,7})$`, 'i'),
    (m) => ({ repo: m[1].toLowerCase(), n: m[2], key: `merged:${m[1].toLowerCase()}#${m[2]}` })],
  ['pushed', new RegExp(`^(?:推到|pushed)\\s*[：:]?\\s*${REPO}\\s+([A-Za-z0-9._/-]+)\\s+([0-9a-fA-F]{7,40})$`, 'i'),
    (m) => (/^[-/]|\.\.|\/$|\/\//.test(m[2]) ? null
      : { repo: m[1].toLowerCase(), branch: m[2], sha: m[3].toLowerCase(), key: `pushed:${m[1].toLowerCase()}@${m[2]}:${m[3].toLowerCase()}` })],
  ['file', /^(?:文件|file)\s*[：:]?\s*((?:\/|~\/)[^\0]*)$/i,
    (m) => { const path = m[1].startsWith('~/') ? join(homedir(), m[1].slice(2)) : m[1]; return { path, key: `file:${path}` }; }],
  ['exited', /^(?:进程退出|exited)\s*[：:]?\s*(\d{1,7})$/i, (m) => ({ pid: Number(m[1]), key: `exited:${m[1]}` })],
];
const NET = new Set(['merged', 'pushed']);

/** 一句判据拆成能核的几条（atoms）和认不出的几段（bad）。反引号、引号去掉。 */
export function parseCheck(text) {
  const atoms = [];
  const bad = [];
  for (const raw of String(text ?? '').split(/\s*[；;]\s*/)) {
    const part = raw.replace(/[`「」"]/g, '').trim();
    if (!part) continue;
    let atom = null;
    for (const [kind, re, f] of KINDS) {
      const m = re.exec(part);
      if (m) { const a = f(m); if (a) atom = { kind, text: part, ...a }; break; }
    }
    if (atom) atoms.push(atom); else bad.push(part);
  }
  return { atoms, bad };
}

export function checksPath(sessionId) {
  return join(stateDir(), `${sessionId}.checks`);
}

/** 核查结果；没有或读不出都是空的（读不出时下一次核查会重写）。 */
export function readChecks(sessionId) {
  try {
    const c = JSON.parse(readFileSync(checksPath(sessionId), 'utf8'));
    if (c && typeof c.entries === 'object' && c.entries) return c;
  } catch { /* 见上 */ }
  return { v: 1, entries: {} };
}

export function writeChecks(sessionId, cache) {
  const p = checksPath(sessionId);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, p);
}

/**
 * 一项的判据现在是什么状态：met（全部满足）、unmet（有一条核到没满足）、error（核不了）、pending（还没核过）、
 * manual（有认不出的部分，人工判）。没满足优先于核不了：有一条明确没满足，整句就是没满足。
 */
export function itemCheck(item, cache) {
  const { atoms, bad } = parseCheck(item?.check);
  if (bad.length || !atoms.length) return { state: 'manual', atoms, entries: [] };
  const entries = atoms.map((a) => cache?.entries?.[a.key] ?? null);
  const firstOf = (st) => entries.find((e) => e?.state === st);
  const state = firstOf('unmet') ? 'unmet' : firstOf('error') ? 'error' : entries.some((e) => !e) ? 'pending' : 'met';
  const detail = (firstOf('unmet') ?? firstOf('error'))?.detail ?? null;
  const latest = (k) => (entries.every((e) => e?.[k]) ? entries.map((e) => e[k]).sort().at(-1) : null);
  return { state, detail, atoms, entries, metAt: state === 'met' ? latest('metAt') : null, seenAt: state === 'met' ? latest('seenAt') : null };
}

const openWithCheck = (items) => (items ?? []).filter((x) => !CLOSED.has(x.status) && typeof x.check === 'string' && x.check);

/** 该核的条：开着的项的判据里，没满足、上次核过已超过 TTL（或没核过）的；人工判的整句不核。按 key 去重。 */
export function dueAtoms(items, cache, nowMs = Date.now()) {
  const out = new Map();
  for (const x of openWithCheck(items)) {
    const { atoms, bad } = parseCheck(x.check);
    if (bad.length) continue;
    for (const a of atoms) {
      const e = cache?.entries?.[a.key];
      if (e?.state === 'met') continue;
      const at = Date.parse(e?.checkedAt ?? '');
      if (Number.isFinite(at) && nowMs - at < (NET.has(a.kind) ? TTL_NET_MS : TTL_LOCAL_MS)) continue;
      out.set(a.key, a);
    }
  }
  return [...out.values()];
}

/** gh 在哪：WILLOW_GH，否则 PATH，再看几个常见位置（钩子起的进程 PATH 不一定带 ~/.local/bin）。 */
export function ghPath() {
  if (process.env.WILLOW_GH) return process.env.WILLOW_GH;
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) if (existsSync(join(dir, 'gh'))) return join(dir, 'gh');
  for (const p of [join(homedir(), '.local', 'bin', 'gh'), '/opt/homebrew/bin/gh', '/usr/local/bin/gh']) if (existsSync(p)) return p;
  return 'gh';
}

function gh(args, opts) {
  const r = spawnSync(opts.gh ?? ghPath(), args, { encoding: 'utf8', timeout: opts.timeoutMs ?? GH_TIMEOUT_MS });
  if (r.error?.code === 'ENOENT') return { fail: 'no-gh' };
  if (r.error?.code === 'ETIMEDOUT' || r.signal) return { fail: 'timeout' };
  if (r.error) return { fail: String(r.error.message ?? r.error).slice(0, 80) };
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

// 核查结果里的说明存成与语言无关的代码，显示时按会话语言翻；不在表里的（gh 的原话）照原样。
const DETAIL = {
  missing: ['还没有', 'not there yet'], exists: ['已存在', 'exists'], running: ['还在跑', 'still running'], exited: ['已退出', 'exited'],
  merged: ['已合并', 'merged'], open: ['还开着', 'still open'], closed: ['已关闭、没合并', 'closed without merging'],
  'no-pr': ['GitHub 上没有这个 PR', 'no such PR on GitHub'], 'no-gh': ['找不到 gh', 'gh not found'],
  timeout: [`gh 超时（${GH_TIMEOUT_MS / 1000} 秒）`, `gh timed out (${GH_TIMEOUT_MS / 1000} s)`], unreadable: ['gh 的回答读不懂', "can't read gh's answer"],
  'not-found': ['GitHub 上没找到这个提交或分支', 'GitHub has no such commit or branch'],
  'on-branch': ['已在分支上', 'on the branch'], 'not-on-branch': ['分支里没有这个提交', 'the branch lacks this commit'],
  unknown: ['不认识的判据', 'unknown check'],
};
export const detailText = (d, lang = 'zh') => (DETAIL[d] ? pick(lang, ...DETAIL[d]) : String(d ?? ''));

/** 核一条。返回 {state, checkedAt, metAt, detail}；metAt 是现实里成立的时间，取不到是 null；detail 见 DETAIL。 */
export function runAtom(atom, opts = {}) {
  const checkedAt = opts.now ?? new Date().toISOString();
  const done = (state, detail, metAt = null) => ({ state, checkedAt, metAt, detail });
  if (atom.kind === 'file') {
    let st;
    try { st = statSync(atom.path); } catch (e) { return e?.code === 'ENOENT' ? done('unmet', 'missing') : done('error', String(e?.code ?? e)); }
    const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    return done('met', 'exists', new Date(born).toISOString());
  }
  if (atom.kind === 'exited') {
    try { process.kill(atom.pid, 0); return done('unmet', 'running'); } catch (e) {
      return e?.code === 'ESRCH' ? done('met', 'exited') : e?.code === 'EPERM' ? done('unmet', 'running') : done('error', String(e?.code ?? e));
    }
  }
  if (atom.kind === 'merged') {
    const r = gh(['pr', 'view', atom.n, '--repo', atom.repo, '--json', 'state,mergedAt'], opts);
    if (r.fail) return done('error', r.fail);
    if (r.code !== 0) return done('error', /Could not resolve/.test(r.err) ? 'no-pr' : (r.err.split('\n')[0] || `gh exit ${r.code}`).slice(0, 80));
    let j;
    try { j = JSON.parse(r.out); } catch { return done('error', 'unreadable'); }
    if (j.state === 'MERGED') return done('met', 'merged', typeof j.mergedAt === 'string' ? j.mergedAt : null);
    return done('unmet', j.state === 'CLOSED' ? 'closed' : 'open');
  }
  if (atom.kind === 'pushed') {
    // compare 分支...提交：提交是分支的祖先时 GitHub 回 behind，就是分支头时回 identical。
    // 没推上去的提交和写错的分支都回 404，分不开，都记没满足（往安全的方向错）。
    const r = gh(['api', `repos/${atom.repo}/compare/${atom.branch}...${atom.sha}`, '--jq', '.status'], opts);
    if (r.fail) return done('error', r.fail);
    if (r.code !== 0) return /HTTP 404|Not Found/.test(`${r.err} ${r.out}`) ? done('unmet', 'not-found')
      : done('error', (r.err.split('\n')[0] || `gh exit ${r.code}`).slice(0, 80));
    if (r.out === 'behind' || r.out === 'identical') return done('met', 'on-branch');
    return done('unmet', r.out === 'ahead' || r.out === 'diverged' ? 'not-on-branch' : `GitHub: ${r.out || '-'}`);
  }
  return done('error', 'unknown');
}

/**
 * 写做完时重核没满足的那几条（D8）。缓存里的「未满足」是写做完之前核的，推送、合并多半就发生在这中间
 * （10-08 实见：推完、合完紧接着写做完，两次都报「判据核到未满足」）。返回重核后的 itemCheck。
 * net 为 false 时不调 gh（一轮结束的钩子不同步联网）：联网的那几条确认不了，返回 stale，不报。
 * 不写缓存：项一关，它的条目下次核查时就删掉了。
 */
export function recheckForDone(item, cache, opts = {}) {
  const s = itemCheck(item, cache);
  if (s.state !== 'unmet') return s;
  const entries = { ...cache?.entries };
  for (const a of s.atoms) {
    if (entries[a.key]?.state !== 'unmet') continue;
    if (NET.has(a.kind) && !opts.net) return { ...s, state: 'stale' };
    const e = runAtom(a, opts);
    entries[a.key] = { ...e, seenAt: e.state === 'met' ? e.checkedAt : null };
  }
  return itemCheck(item, { ...cache, entries });
}

/**
 * 起一个脱离的核查进程，自己立刻返回（一轮结束的钩子、listctl 用）。没有该核的、锁着、或 WILLOW_CHECK_SPAWN=0 时不起。
 * 返回起没起。
 */
export function startChecker(sessionId, items, nowMs = Date.now()) {
  if (process.env.WILLOW_CHECK_SPAWN === '0') return false;
  if (!dueAtoms(items, readChecks(sessionId), nowMs).length) return false;
  try { if (nowMs - statSync(`${checksPath(sessionId)}.lock`).mtimeMs < LOCK_STALE_MS) return false; } catch { /* 没锁 */ }
  const script = fileURLToPath(new URL('./check.mjs', import.meta.url));
  try {
    const child = spawn(process.execPath, [script, '--session', sessionId], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    return true;
  } catch { return false; }
}

const hm = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function describe(a, e, lang) {
  const T = (zh, en) => pick(lang, zh, en);
  const when = e?.metAt ? ` ${hm(e.metAt)}` : '';
  if (a.kind === 'merged') return T(`${a.repo}#${a.n} 已合并${when}`, `${a.repo}#${a.n} merged${when}`);
  if (a.kind === 'pushed') return T(`${a.repo} ${a.branch} 已含 ${a.sha.slice(0, 7)}`, `${a.repo} ${a.branch} has ${a.sha.slice(0, 7)}`);
  if (a.kind === 'file') return T(`${a.text.replace(/^(?:文件|file)\s*[：:]?\s*/i, '')} 已存在`, `${a.text.replace(/^(?:文件|file)\s*[：:]?\s*/i, '')} exists`);
  return T(`进程 ${a.pid} 已退出`, `process ${a.pid} has exited`);
}

/**
 * 这一轮要点名的项（D5）：判据全部满足、项还开着。said 是 {编号: 上次说的判据}，同一项、同一句判据只说一次。
 * 返回 {lines, said}；said 只留还开着、判据满足的项。
 */
export function checkNews(items, cache, said, lang = 'zh') {
  const T = (zh, en) => pick(lang, zh, en);
  const before = said && typeof said === 'object' ? said : {};
  const after = {};
  const lines = [];
  let more = 0;
  for (const x of openWithCheck(items)) {
    const s = itemCheck(x, cache);
    if (s.state !== 'met') continue;
    const key = `met:${x.check}`;
    if (before[x.id] === key) { after[x.id] = key; continue; }
    // 一轮最多点 NEWS_SHOW 项；没点到的不记成说过，下一轮再点。
    if (lines.length >= NEWS_SHOW) { more++; continue; }
    after[x.id] = key;
    const what = s.atoms.map((a, i) => describe(a, s.entries[i], lang)).join(T('；', '; '));
    lines.push(T(`${x.id} 的判据已经满足（${what}）：确认做完就写「${x.id} 做完：<证据>」；判据不够，改判据或改题。`,
      `${x.id}'s check holds (${what}): if it is done write "${x.id} done: <evidence>"; if the check is not enough, change it or retitle.`));
  }
  if (more) lines.push(T(`另有 ${more} 项判据已满足，下一轮再点。`, `${more} more items' checks hold; named next turn.`));
  return { lines, said: after };
}

/** 完整列出清单时项后面那一段：「（判据：…，已满足）」。 */
export function checkLabel(item, cache, lang = 'zh') {
  const T = (zh, en) => pick(lang, zh, en);
  const s = itemCheck(item, cache);
  const st = {
    met: T('已满足', 'holds'),
    unmet: T(`未满足：${detailText(s.detail, lang)}`, `not yet: ${detailText(s.detail, lang)}`),
    error: T(`核不了：${detailText(s.detail, lang)}`, `can't check: ${detailText(s.detail, lang)}`),
    pending: T('待核', 'not checked yet'),
    manual: T('人工判', 'judged by hand'),
  }[s.state];
  return T(`（判据：${item.check}，${st}）`, ` (check: ${item.check}, ${st})`);
}
