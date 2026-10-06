#!/usr/bin/env node
// 清单那一行（inlineLine）的检查：带日期的「等别的」「以后」项什么时候露出标题。
//
// 规则在 ops-private spec 2026-10-06「清单那一行露出带日期的以后、等项」D1–D8，
// 同日增补「到了日子的项：只认截止日期，久过期的让位」D9–D10。今天由第三个参数给定，
// 不随跑测试的那一天变。标题全是虚构的。
//
// 纪律同 replay：先在旧实现上跑。kind 为 new 的用例断言新行为，旧实现上必须变红；
// kind 为 guard 的只防回归（认不出就不露、远期不露），旧实现上本来就绿，不能拿它们证明什么。

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { inlineLine, datedDays } = await import(pathToFileURL(join(HERE, '..', '..', 'plugin', 'hooks', '_list.mjs')).href);

const later = (id, text) => ({ id, text, status: '以后', wait: null });
const other = (id, text, wait = '合成回信') => ({ id, text, status: '等', wait });
const you = (id, text) => ({ id, text, status: '等你', wait: null });

// [名字, kind, 开着的项, 语言, 今天, 必须有的片段, 不许有的片段]
const cases = [
  ['overdue-later', 'new', [later('L1', '合成事项甲，09-18 说好的')], 'zh', '2026-10-06',
    ['▫ 以后 1：L1 合成事项甲', '（已过 18 天）'], []],
  ['today-other', 'new', [other('L2', '合成回执，对方 10-06 回')], 'zh', '2026-10-06',
    ['⬚ 等别的 1：L2 合成回执', '（今天）'], []],
  ['day-14-inclusive', 'new', [later('L3', '10 月 20 日前交合成说明')], 'zh', '2026-10-06',
    ['▫ 以后 1：L3', '（还有 14 天）'], []],
  ['day-15-hidden', 'guard', [later('L3', '10-21 前交合成说明')], 'zh', '2026-10-06',
    ['▫ 以后 1'], ['：L3', '还有']],
  ['month-end', 'new', [later('L4', '10 月底前给合成档案馆交说明')], 'zh', '2026-10-20',
    ['▫ 以后 1：L4', '（还有 11 天）'], []],
  ['month-end-with-year', 'new', [later('L4', '合成说明 2026 年 10 月底交')], 'zh', '2026-10-20',
    ['▫ 以后 1：L4', '（还有 11 天）'], []],
  // 带年份的认过就遮住：不然「10 月底」会被再读成今年的 10 月底（还有 25 天），盖过真正的 2020 年。
  ['year-form-masked', 'new', [later('L5', '合成旧事 2020 年 10 月底前')], 'zh', '2026-10-06',
    ['▫ 以后 1：L5', '（已过 '], ['还有']],
  ['iso-overdue', 'new', [later('L5', '合成课程，2026-09-30 前')], 'zh', '2026-10-06',
    ['▫ 以后 1：L5', '（已过 6 天）'], []],
  ['iso-far-hidden', 'guard', [later('L5', '合成课程约 4 小时，2027-07-31 前')], 'zh', '2026-10-06',
    ['▫ 以后 1'], ['：L5', '还有']],
  ['year-rolls-forward', 'new', [later('L6', '合成材料 01-05 前交')], 'zh', '2026-12-28',
    ['▫ 以后 1：L6', '（还有 8 天）'], []],
  ['year-rolls-back', 'new', [other('L7', '合成回执，12-20 答应')], 'zh', '2027-01-03',
    ['⬚ 等别的 1：L7', '（已过 14 天）'], []],
  // D3：取最晚的日期。09-18 是答应的日子，10-10 是截止。
  ['latest-date-wins', 'new', [later('L8', '09-18 答应，10-10 前发合成信')], 'zh', '2026-10-06',
    ['▫ 以后 1：L8', '（还有 4 天）'], ['已过']],
  ['latest-date-far', 'guard', [later('L8', '09-18 答应，10-30 前发合成信')], 'zh', '2026-10-06',
    ['▫ 以后 1'], ['：L8', '已过']],
  // D6 + D10：全行最多两项；已过的最多占一个，取过得最少的，另一个给今天和最近的；没露完的组末尾带「…」。
  ['cap-one-past-one-next', 'new', [
    later('L1', '合成甲，09-03 答应'),
    other('L2', '合成乙，09-28 前'),
    other('L3', '合成丙，10-06 回'),
    later('L4', '合成丁，10-10 前'),
    later('L5', '合成戊，没写日子'),
  ], 'zh', '2026-10-06',
    ['⬚ 等别的 2：L2 合成乙', '（已过 8 天）、L3 合成丙', '（今天）', '▫ 以后 3'], ['L1 合成甲', '已过 33 天', 'L4 合成丁', 'L5', '（今天）…']],
  // D10：只有已过的，取过得最少的两项，照旧从早到晚排。
  ['only-past-least-first', 'new', [
    later('L1', '合成甲，09-03 答应'),
    later('L2', '合成乙，09-18 答应'),
    later('L3', '合成丙，09-28 前'),
  ], 'zh', '2026-10-06',
    ['▫ 以后 3：L2 合成乙', '（已过 18 天）、L3 合成丙', '（已过 8 天）…'], ['L1 合成甲', '已过 33 天']],
  // D10：只有没过的，和原来一样取最近的两项。
  ['only-next-nearest', 'guard', [
    other('L1', '合成甲，10-10 前'),
    other('L2', '合成乙，10-06 回'),
    other('L3', '合成丙，10-08 前'),
  ], 'zh', '2026-10-06',
    ['⬚ 等别的 3：L2 合成乙', '（今天）、L3 合成丙', '（还有 2 天）…'], ['L1 合成甲']],
  // D9：版本日期、过去的事不算到日子。
  ['version-date-hidden', 'new', [later('L1', '合成平台上取回 08-14 定稿'), other('L2', '核对 08-14 终版合成讲义')], 'zh', '2026-10-06',
    ['⬚ 等别的 1 ｜ ▫ 以后 1'], ['：L1', '：L2', '已过']],
  ['undated-hidden', 'guard', [later('L1', '合成事项没写日子'), other('L2', '合成回信')], 'zh', '2026-10-06',
    ['⬚ 等别的 1 ｜ ▫ 以后 1'], ['：L1', '：L2']],
  // D2：认不出的不露。
  ['unparseable-hidden', 'guard', [
    later('L1', '合成导师定 13 还是 14 日'),
    later('L2', '合成稿 10月15前交'),
    later('L3', 'ABCD-26-0517 合成返修'),
    later('L4', '合成来信 10:07 到'),
    later('L5', 'ABCD-2026-0517 合成状态'),
    later('L6', '合成 13-14 之间定'),
    later('L7', '合成 02-30 前'),
    // 下面两条切出来的是有效日子（07-10、10-06），只有「前后紧挨 - : 的不认」挡得住。
    later('L8', '合成会 10:07-10:30 开'),
    later('L9', 'ABCD-10-0612 合成返修'),
  ], 'zh', '2026-10-06',
    ['▫ 以后 9'], ['：L', '已过', '还有', '今天']],
  // D4：没有这一天的年份不算（2027 年没有 2 月 29 日，最近的是 2028 年，远）。
  ['feb-29', 'guard', [later('L1', '合成报名 02-29 前')], 'zh', '2027-02-20',
    ['▫ 以后 1'], ['：L1']],
  // 只改「等别的」「以后」两组：在做、等你的选法不变，不挂天数。
  ['you-unchanged', 'guard', [you('L1', '合成确认，09-18 答应')], 'zh', '2026-10-06',
    ['□ 等你 1：L1 合成确认'], ['已过']],
  // 等你的项不占那两个名额：它更早，也不能把以后组里到了日子的挤掉。
  ['you-takes-no-slot', 'new', [you('L1', '合成确认，09-01 答应'), later('L2', '合成乙，09-18 答应'), later('L3', '合成丙，10-06 回')], 'zh', '2026-10-06',
    ['▫ 以后 2：L2 合成乙', '（已过 18 天）、L3 合成丙', '（今天）'], ['（已过 35 天）', '（今天）…']],
  ['english', 'new', [later('L1', 'Synthetic report, promised 09-18'), other('L2', 'Synthetic reply due 10-07')], 'en', '2026-10-06',
    ['⬚ Waiting on other 1: L2 Synthetic reply due', '(in 1 day)', '▫ Later 1: L1 Synthetic report, prom', '(18 days ago)'], []],
];

const failures = [];
let newRed = 0;
for (const [name, kind, open, lang, today, want, wantNot] of cases) {
  let line;
  try {
    line = inlineLine(open, lang, today);
  } catch (e) {
    line = `（抛错：${e?.message ?? e}）`;
  }
  const bad = [];
  for (const w of want) if (!line.includes(w)) bad.push(`没有「${w}」`);
  for (const w of wantNot) if (line.includes(w)) bad.push(`不该有「${w}」`);
  console.log(`  ${bad.length ? '✗' : '✓'} [${kind}] ${name}`);
  if (bad.length) failures.push(`${name} · ${bad.join('；')}（得到：${line}）`);
}

// 和 app 共用的日期用例（dated-cases.json）：同一个标题、同一个今天，两边算出的天数必须一样。
// app 的导出器（DueDate.swift）读同一份；这里改了规则、那边没跟上，swift test 会红（刘海 spec 2026-10-06 D2）。
{
  const { readFileSync } = await import('node:fs');
  const shared = JSON.parse(readFileSync(join(HERE, 'dated-cases.json'), 'utf8'));
  let bad = 0;
  for (const c of shared) {
    const got = datedDays(c.text, c.today);
    if (got !== c.days) { bad++; failures.push(`共用用例 ${c.name} · 要 ${c.days}，得到 ${got}`); }
  }
  console.log(`  ${bad ? '✗' : '✓'} [guard] dated-cases.json ${shared.length - bad}/${shared.length}`);
}

// 不传今天就按本机今天算：一个 2020 年的日子永远已经过了。
{
  const line = inlineLine([later('L9', '合成旧账，2020-01-15 前')], 'zh');
  const ok = line.includes('▫ 以后 1：L9') && line.includes('（已过 ');
  console.log(`  ${ok ? '✓' : '✗'} [new] default-today`);
  if (!ok) failures.push(`default-today · 没露出 L9（得到：${line}）`);
}

if (failures.length) {
  console.log(`\n  ${failures.length} 项失败：\n`);
  for (const f of failures) console.log(`    · ${f}`);
  process.exit(1);
}
console.log('\n  全部通过');
