#!/usr/bin/env node
// 说「做完了」对来源的判定：认哪些说法（findClaim）、留言里的判定怎么读（verdictOf）、下一轮说的那一句（claimText）。
//
// 句子全是虚构的。纪律同 replay：先在没有 _claim.mjs 的旧代码上跑。kind 为 new 的断言新行为，旧代码上必须变红；
// guard 只防回归（否定、问句、引号里的不算），旧代码上本来就绿，不能拿它们证明什么；
// known 把已知的误报、漏报照现状钉住——改了说法表，这几条会红，提醒去改 _claim.mjs 里的清单。

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let mod = {};
let inboxMod = {};
try { mod = await import(pathToFileURL(join(HERE, '..', '..', 'plugin', 'hooks', '_claim.mjs')).href); } catch (e) { console.log(`  （_claim.mjs 读不进来：${e?.code ?? e?.message ?? e}）`); }
try { inboxMod = await import(pathToFileURL(join(HERE, '..', '..', 'plugin', 'hooks', '_inbox.mjs')).href); } catch { /* 下面按缺失算 */ }
const findClaim = mod.findClaim ?? (() => null);
const claimText = mod.claimText ?? (() => null);
const verdictOf = inboxMod.verdictOf ?? (() => undefined);

// [名字, kind, 回复最后一段, 认出的说法（null 表示不认）]
const claims = [
  // ── 认 ──
  ['zh-all-done', 'new', '合成检查甲、合成检查乙都过了，都做完了。', '都做完了'],
  ['zh-done', 'new', '做完了：合成段落已替换。', '做完了'],
  ['zh-written', 'new', '第二节写完了。', '写完了'],
  ['zh-completed', 'new', '合成任务完成了。', '完成了'],
  ['zh-already', 'new', '已完成：合成检查甲、合成检查乙。', '已完成'],
  ['zh-all-complete', 'new', '全部完成。', '全部完成'],
  ['zh-final', 'new', '合成稿定稿了。', '定稿了'],
  ['zh-can-submit', 'new', '现在可以投了。', '可以投了'],
  ['zh-can-upload', 'new', '合成包备好了，可以上传。', '可以上传'],
  ['zh-can-hand-in', 'new', '检查全过，可以提交。', '可以提交'],
  ['zh-however', 'new', '不过现在都做完了。', '都做完了'],             // 「不过」不是否定
  ['zh-etc', 'new', '表格、图注等都做完了。', '都做完了'],              // 「等」不在分句开头，不是「等到」
  ['en-ready', 'new', 'The synthetic draft is ready to submit.', 'ready to submit'],
  ['en-ready-for', 'new', 'Ready for submission.', 'Ready for submission'],
  ['en-all-done', 'new', 'All done: the synthetic checks pass.', 'All done'],
  ['en-its-done', 'new', "It's done.", "It's done"],
  ['en-curly', 'new', 'It’s done.', "It's done"],
  ['en-everything', 'new', 'Everything is finished.', 'Everything is finished'],
  ['en-done-opener', 'new', 'Done. The synthetic table is updated.', 'Done'],
  ['en-finished-opener', 'new', 'Finished: one synthetic file edited.', 'Finished'],
  // ── 不认：否定、问句、条件、引号、回复里的固定行 ──
  ['zh-not-yet', 'guard', '还没做完，第三节在改。', null],
  ['zh-incomplete', 'guard', '未完成：合成检查乙。', null],
  ['zh-not-written', 'guard', '第二节没写完。', null],
  ['zh-question', 'guard', '是不是都做完了？', null],
  ['zh-question-ma', 'guard', '可以投了吗？', null],
  ['zh-question-later', 'guard', '合成检查都做完了没有？', null],
  ['zh-not-is', 'guard', '不是都完成了，还差合成表。', null],
  ['zh-not-adj', 'guard', '现在还不可以提交。', null],
  ['zh-ask-before', 'guard', '是否已完成，要看合成检查乙。', null],
  ['zh-ask-after', 'guard', '都做完了吗，我再查一遍。', null],
  ['zh-if-clause', 'guard', '我看了一下，如果都做完了，就推。', null],
  ['zh-only-then', 'guard', '跑完合成检查才可以提交。', null],
  ['en-when', 'guard', 'I will push it when everything is done.', null],
  ['en-modal', 'guard', 'It should be ready to submit after one more pass.', null],
  ['zh-cant-say', 'guard', '不能说都做完了：合成检查乙还红着。', null],
  ['zh-not-equal', 'guard', '单项通过不等于可以投了。', null],
  ['zh-cond-before', 'guard', '等合成检查都做完了再推。', null],
  ['zh-cond-after', 'guard', '做完了再告诉你。', null],
  ['zh-cond-if', 'guard', '可以提交的话就提交。', null],
  ['zh-quoted', 'guard', '上次那句「都做完了」说早了。', null],
  ['zh-what', 'guard', '## 完成了什么', null],
  ['zh-declaration', 'guard', '你批准的：第二节写完了就推送\n我读成了：合成推送\n我补上的：无\n标签：推送', null],
  ['zh-list-block', 'guard', '合成段落改短了。\n\n清单变化：\nL2 做完：合成提交\n+ 以后：写完了再看\n\n下一步：L3 都做完了再推', null],
  ['en-isnt-ready', 'guard', "It isn't ready to submit.", null],
  ['en-not-ready', 'guard', 'The draft is not ready for submission yet.', null],
  ['en-not-all', 'guard', 'Not all done: one synthetic check is red.', null],
  ['en-question', 'guard', 'Is it ready to submit?', null],
  ['en-if', 'guard', 'If everything is done, I will push.', null],
  ['en-once', 'guard', "Once it's done I'll tell you.", null],
  ['en-quoted', 'guard', 'You said "all done" earlier.', null],
  ['en-code', 'guard', 'Run `echo all done` to see it.', null],
  ['zh-reported', 'guard', '上一轮我说都做完了，其实循环判的是未就绪。', null],
  ['zh-sentence-if', 'guard', '等合成检查乙过了，就可以投了。', null],
  ['en-reported', 'guard', "Earlier I said it's done, but the loop says not ready.", null],
  ['en-sentence-if', 'guard', "Once the synthetic check passes, it's done.", null],
  ['en-next-line', 'guard', 'Edited one synthetic file.\n\nNext: L2 all done after the check', null],
  // ── 已知误报：说的是一小件事，也照样认 ──
  ['known-fp-part', 'known', '这一段写完了，下一段还没动。', '写完了'],
  ['known-fp-commit', 'known', '改动可以提交了。', '可以提交'],            // git 提交的意思
  ['known-fp-step', 'known', '第一步完成了。', '完成了'],
  ['known-fp-en-step', 'known', 'All done with step one.', 'All done'],
  // ── 已知漏报 ──
  ['known-miss-bare', 'known', '稿子写完。', null],
  ['known-miss-hao', 'known', '都改好了。', null],
  ['known-miss-neng', 'known', '能投了。', null],
  ['known-miss-meiwenti', 'known', '都做完了没问题。', null],              // 「没」被当成问句「做完了没」
  ['known-miss-en-complete', 'known', 'The paper is complete.', null],
  ['known-miss-en-good', 'known', "We're good to go.", null],
  ['known-miss-en-finished-the', 'known', 'Finished the edits.', null],
];

// [名字, kind, 留言, 期望]：期望 null 是没有判定，'bad' 是形状不对（照实说读不出），对象是读出的判定。
const verdicts = [
  ['absent', 'guard', { always: '合成' }, null],
  ['not-ready', 'new', { verdict: { ready: false, text: '合成状态：未就绪' } }, { ready: false, text: '合成状态：未就绪' }],
  ['ready', 'new', { verdict: { ready: true, text: '合成状态：已就绪' } }, { ready: true, text: '合成状态：已就绪' }],
  ['extra-keys', 'new', { verdict: { ready: false, text: '合成', stage: '改稿' } }, { ready: false, text: '合成' }],
  ['folds-lines', 'new', { verdict: { ready: false, text: '合成甲\n  合成乙' } }, { ready: false, text: '合成甲 合成乙' }],
  ['null', 'new', { verdict: null }, 'bad'],
  ['string-ready', 'new', { verdict: { ready: 'false', text: '合成' } }, 'bad'],
  ['no-text', 'new', { verdict: { ready: false } }, 'bad'],
  ['empty-text', 'new', { verdict: { ready: false, text: '  ' } }, 'bad'],
  ['array', 'new', { verdict: [false, '合成'] }, 'bad'],
  ['string', 'new', { verdict: '未就绪' }, 'bad'],
];

const failures = [];
for (const [name, kind, text, want] of claims) {
  let got;
  try { got = findClaim(text); } catch (e) { got = `（抛错：${e?.message ?? e}）`; }
  const ok = got === want;
  console.log(`  ${ok ? '✓' : '✗'} [${kind}] ${name}`);
  if (!ok) failures.push(`${name} · 要 ${JSON.stringify(want)}，得到 ${JSON.stringify(got)}（${JSON.stringify(text)}）`);
}
for (const [name, kind, note, want] of verdicts) {
  let got;
  try { got = verdictOf(note); } catch (e) { got = `（抛错：${e?.message ?? e}）`; }
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} [${kind}] verdict-${name}`);
  if (!ok) failures.push(`verdict-${name} · 要 ${JSON.stringify(want)}，得到 ${JSON.stringify(got)}`);
}

// 下一轮说的那一句：两种语言；几份留言判的都是没就绪，一句里都说出来。
const texts = [
  ['text-zh', 'new', ['都做完了', [{ label: '合成来源甲', text: '合成状态：未就绪' }], 'zh'],
    '【Wishing-Willow】上一轮回复说「都做完了」，但「合成来源甲」的判定是「合成状态：未就绪」。说完成要按来源的判定说；单项检查通过不等于完成。'],
  ['text-zh-two', 'new', ['可以投了', [{ label: '合成来源甲', text: '未就绪甲' }, { label: '合成来源乙', text: '未就绪乙' }], 'zh'],
    '【Wishing-Willow】上一轮回复说「可以投了」，但「合成来源甲」的判定是「未就绪甲」，「合成来源乙」的判定是「未就绪乙」。说完成要按来源的判定说；单项检查通过不等于完成。'],
  ['text-en', 'new', ['All done', [{ label: 'Synthetic source', text: 'Synthetic state: not ready' }], 'en'],
    '[Wishing-Willow] Your last reply said "All done", but "Synthetic source" says "Synthetic state: not ready". Call it finished only as the source\'s verdict does; single checks passing is not finished.'],
];
for (const [name, kind, args, want] of texts) {
  let got;
  try { got = claimText(...args); } catch (e) { got = `（抛错：${e?.message ?? e}）`; }
  const ok = got === want;
  console.log(`  ${ok ? '✓' : '✗'} [${kind}] ${name}`);
  if (!ok) failures.push(`${name} · 要 ${JSON.stringify(want)}，得到 ${JSON.stringify(got)}`);
}

console.log('');
if (failures.length) {
  console.log(`  ${failures.length} 项失败：\n`);
  for (const f of failures) console.log(`    · ${f}`);
  console.log('');
  process.exit(1);
}
console.log('  全部通过\n');
