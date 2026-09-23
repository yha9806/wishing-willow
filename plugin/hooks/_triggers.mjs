// 待触发清单：「等某件事发生再做」的条目，到时候才告诉模型。
//
// 清单是作者自己的一份 Markdown 文件，路径写在 <状态目录>/config/willow.json 的 "triggers" 里。
// 没有这份配置，这个功能就是关的：capture 的输出和以前一字不差。
// 配置放在 config/ 子目录，不放状态目录顶层：app 把顶层的每个 .json 都当成一个会话来读。
//
// 这个文件跑在 UserPromptSubmit 里，挡着用户的回车，所以只读本地的几个小文件，不访问网络。
// 阶段由这里推导，不写进清单（和状态文件里 status 由读方推导是同一条线）：
//   状态「未决」且条件没满足 → 休眠，不说；条件满足 → 已触发，说。
// 读不出、格式坏了：说「读不出」，绝不当成「没有条目」。

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { stateDir } from './_willow.mjs';

const HEAD = /^##\s+待触发\s+(\S+)\s+(.+?)\s*$/;
const FIELD = /^\s*(来源|指向|范围|什么时候出现|消除它的证据|状态)\s*[：:]\s*(.*?)\s*$/;
const NEEDS = ['指向', '范围', '什么时候出现', '状态'];
const ACTIVE = new Set(['进行中', '等作者关']);

export function configPath() {
  return join(stateDir(), 'config', 'willow.json');
}

/** null = 功能关着；{ triggers } = 开着；{ error } = 配置本身坏了。 */
export function loadConfig() {
  const p = configPath();
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(readFileSync(p, 'utf8'));
    if (c && typeof c.triggers === 'string' && c.triggers) return { triggers: expand(c.triggers) };
    return null;
  } catch {
    return { error: `配置读不出：${p}` };
  }
}

function expand(p) {
  return p.startsWith('~/') || p === '~' ? join(homedir(), p.slice(1)) : p;
}

/** 解析清单。返回 { items, problems }；读不出时 items 为 null。 */
export function parseTriggers(text) {
  const items = [];
  const problems = [];
  let cur = null;
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }   // 代码块里举的例子不是条目
    if (fence) continue;
    const h = HEAD.exec(line);
    if (h) {
      cur = { id: h[1], title: h[2], fields: {}, when: [] };
      items.push(cur);
      continue;
    }
    if (!cur) continue;
    const f = FIELD.exec(line);
    if (!f) continue;
    if (f[1] === '什么时候出现') cur.when.push(f[2]);
    else if (!(f[1] in cur.fields)) cur.fields[f[1]] = f[2];
  }
  for (const it of items) {
    const missing = NEEDS.filter((k) => (k === '什么时候出现' ? it.when.length === 0 : !it.fields[k]));
    if (missing.length) problems.push(`${it.id} 缺 ${missing.join('、')}`);
  }
  return { items, problems };
}

/** 台账里某条的状态行；找不到这一条返回 null。 */
function ledgerStatus(text, id) {
  const lines = text.split(/\r?\n/);
  const head = new RegExp(`^##\\s+(门|风险)\\s+${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`);
  const at = lines.findIndex((l) => head.test(l));
  if (at === -1) return null;
  for (let i = at + 1; i < lines.length && !/^##\s/.test(lines[i]); i += 1) {
    const m = /^状态\s*[：:]\s*(.*)$/.exec(lines[i]);
    if (m) return m[1];
  }
  return '';
}

/** 一个条件是否满足。写法不认识就抛错，由调用方报成「读不出」。 */
function holds(cond, today) {
  const c = cond.trim();
  if (c === '现在') return true;
  if (c === '手动') return false;
  let m = /^日期\s+(\d{4}-\d{2}-\d{2})$/.exec(c);
  if (m) return today >= m[1];
  m = /^文件\s+(\S+)$/.exec(c);
  if (m) return existsSync(expand(m[1]));
  m = /^台账\s+(\S+)\s+(.+?)\s+已决$/.exec(c);
  if (m) {
    const text = readFileSync(expand(m[1]), 'utf8');
    return m[2].split(/\s+/).every((id) => {
      const s = ledgerStatus(text, id);
      if (s === null) throw new Error(`台账里没有 ${id}`);
      return s.startsWith('已决');
    });
  }
  throw new Error(`触发条件写法不认识：${c}`);
}

/** 多行「什么时候出现」任一满足即可；同一行里「并且」连起来的要同时满足。 */
function triggered(item, today) {
  return item.when.some((line) => line.split(/\s*；\s*/).some(
    (alt) => alt.split(/\s+并且\s+/).every((c) => holds(c, today)),
  ));
}

function norm(p) {
  const abs = resolve(expand(p.trim()));
  try { return realpathSync(abs); } catch { return abs; }
}

/** 范围按路径分段比：/a/b 包括 /a/b/c，不包括 /a/bc。 */
export function inScope(item, cwd) {
  const scope = item.fields['范围'] ?? '';
  if (scope.trim() === '全部') return true;
  if (typeof cwd !== 'string' || !cwd) return false;
  const here = norm(cwd);
  return scope.split(/\s*[,，]\s*/).filter(Boolean).some((p) => {
    const root = norm(p);
    return here === root || here.startsWith(root.endsWith('/') ? root : `${root}/`);
  });
}

function today() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/**
 * 给 capture 用：和这个会话相关、这一刻该说的条目，拼成一段注入文字。
 * 功能关着或没有该说的，返回 null。
 */
export function triggerBlock(cwd) {
  const cfg = loadConfig();
  if (cfg === null) return null;
  const head = '【Wishing-Willow · 待触发】';
  const tailNote = '（私有清单，勿写进公开仓）';
  if (cfg.error) return `${head}${cfg.error}。不能当作没有待触发的条目。${tailNote}`;
  let text;
  try { text = readFileSync(cfg.triggers, 'utf8'); } catch {
    return `${head}清单读不出：${cfg.triggers}。不能当作没有待触发的条目。${tailNote}`;
  }
  const { items, problems } = parseTriggers(text);
  const t = today();
  const lines = [];
  for (const it of items) {
    if (problems.some((p) => p.startsWith(`${it.id} `))) continue;
    if (!inScope(it, cwd)) continue;
    const status = it.fields['状态'];
    let stage;
    if (status === '未决') {
      try {
        if (!triggered(it, t)) continue;          // 休眠：不说
      } catch (e) {
        problems.push(`${it.id} ${e.message}`);
        continue;
      }
      stage = '已触发';
    } else if (ACTIVE.has(status)) {
      stage = status;
    } else {
      if (!/^已关闭\s+\d{4}-\d{2}-\d{2}/.test(status)) problems.push(`${it.id} 状态写法不认识：${status}`);
      continue;                                   // 已关闭：不说
    }
    const ev = it.fields['消除它的证据'] ? `｜消除它的证据：${it.fields['消除它的证据']}` : '';
    lines.push(`- ${it.id} ${stage}：${it.title}｜指向 ${it.fields['指向']}${ev}`);
  }
  if (lines.length === 0 && problems.length === 0) return null;
  const out = [`${head}和这个会话相关的条目${tailNote}：`, ...lines];
  if (problems.length) out.push(`清单有读不懂的地方：${problems.join('；')}`);
  return out.join('\n');
}
