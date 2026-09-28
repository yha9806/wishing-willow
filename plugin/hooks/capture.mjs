#!/usr/bin/env node
// UserPromptSubmit — store the prompt verbatim, and (for substantial requests
// only) remind the model to declare how it read the request.
//
// This hook runs before Claude sees your message and blocks until it returns,
// so it does exactly two cheap things and then gets out of the way.

import { statSync } from 'node:fs';
import {
  SCHEMA, readStdin, parseInput, readPrompt, readState, writeState, shouldBypass, isSystemEnvelope,
  appendTurnLog, findDeclaration, interruptedSince, quietExit, envelopeRulesProblem,
} from './_willow.mjs';
import { triggerBlock } from './_triggers.mjs';
import { inboxText } from './_inbox.mjs';
import { listBlock, listRules, commandRule, authorChanges } from './_list.mjs';
import { inheritList } from './_inherit.mjs';
import { promptLang, sessionLang, pick } from './_lang.mjs';

/**
 * transcript 在此刻的字节长度 —— 也就是「本轮开始之前」的位置。
 *
 * Stop 那边靠它直接定位本轮：从这个偏移往后读，读到的就是且只是这一轮，
 * 不用从文件尾部回溯猜边界。回溯那条路有窗口上限，而超出上限的恰好是
 * 塞了巨量工具输出的那种大轮次 —— 于是最重要的那一轮最容易被误报成
 * 「没声明」。一次 statSync 是微秒级，这个 hook 挡着用户的回车，只做得起这么多。
 */
function transcriptLength(path) {
  if (typeof path !== 'string' || !path) return null;
  try { return statSync(path).size; } catch { return null; }
}

const REMINDER_ZH =
  // 第四行「我补上的」（2026-09-13 用户选定）：把默认值补进去的部分说出来。
  // 装上后一天的记录里，一个查文献的会话把「有没有相关 paper」读成只查撞车——两行彼此一致、没有 ⚠，
  // 做完一轮后用户才补「还要看会刊收不收」。「你批准的」也是模型写的，会跟着一起偏；补上的东西要单独一行才看得见。
  '【Wishing-Willow】请在本轮回复的最开头写四行，然后再回答：\n' +
  '你批准的：<一句话写出用户要的>\n' +
  '我读成了：<一句话写出你把这个请求读成了什么任务；与上一行不一致时，本行开头标 ⚠>\n' +
  '我补上的：<请求里没说、由你替用户定下的部分——范围、对象、标准、先后、形式，逐项简写；确实没有就写「无」>\n' +
  '标签：<把「我读成了」压成 ≤6 个汉字（英文 ≤14 字符），动词+宾语；' +
  '禁止「继续 / 往下做 / 处理 / 优化 / 完善 / 推进 / 跟进」这类不含信息的词>\n' +
  '前两行一致时也照写，保持平淡。不要解释这几行本身。\n';

// 英文版（2026-09-27 装机演练 F2）。四个标签与 README 一致；读的一侧（_willow.mjs）认 How I read it 与 Tag。
const REMINDER_EN =
  '[Wishing-Willow] Open this reply with four lines, then answer:\n' +
  'You approved: <one sentence: what the user asked for>\n' +
  'How I read it: <one sentence: the task you took this request to be; if it differs from the line above, start this line with ⚠>\n' +
  'What I filled in: <what the request left unsaid and you decided for the user — scope, target, standard, order, form; brief, item by item; ' +
  'write "nothing" if there truly is nothing>\n' +
  'Tag: <"How I read it" squeezed to ≤14 characters (Chinese ≤6), verb + object; ' +
  'no empty verbs such as "continue", "handle", "improve", "polish", "follow up">\n' +
  'Write them even when the first two lines agree, and keep them plain. Don\'t comment on these lines.\n';

// 长清单的写法：压缩之后 compacted.mjs 要原样重交，所以只有一份（_list.mjs listRules）。
const reminder = (lang) => pick(lang, REMINDER_ZH, REMINDER_EN) + listRules(lang);

// 标签那一行是给菜单栏／刘海那条常亮层用的：刘海 156pt，11pt 中文大约 14 个字，
// 一句解码放不下。它必须由模型自己压，**不能由读方截断解码行** —— 实测
// 「起草不发送，发送等你一句话」截到 14 个字是「起草那封跟进信，内容具体到…」，
// 「不发送」被切掉，意思正好反过来。截断名字是安全的，截断解码是危险的。

try {
  const input = parseInput(readStdin());
  if (!input) quietExit();

  const sessionId = input.session_id;
  if (typeof sessionId !== 'string') quietExit();

  const { text: prompt, field: promptField } = readPrompt(input);

  // The prompt is written exactly as submitted. Nothing in this plugin — and
  // nothing the model can do — rewrites this field. That asymmetry is the point.
  //
  // When no prompt field matched, the record is still written, with both
  // `prompt` and `promptField` null. That combination means "the hook ran and
  // could not read this turn's input" — a broken plugin, not a quiet model —
  // and the reader shows it as such instead of leaving the screen blank.
  // 这一轮到底问没问，capture 是唯一知道的人。日志里没有这一位，
  // 「我们没问」和「问了没答」就算成同一件事 —— 统计直接是错的。
  const bypass = prompt === null || shouldBypass(prompt);

  // 原话是不是人说的。2026-09-12 真实截图：灵动岛把一条 <task-notification>
  // 显示成了「你批准的」。原话照旧逐字记下，但要标明它的来历。
  const origin = prompt === null ? null : (isSystemEnvelope(prompt) ? 'system' : 'user');

  const prev = readState(sessionId);

  // 这一轮写给模型的话用哪种语言：人说的、够长的原话才作数；系统信封、斜杠命令、短确认沿用上一轮（_lang.mjs）。
  const lang = origin === 'user' && !bypass ? promptLang(prompt, prev?.lang ?? null) : sessionLang(prev);
  const T = (zh, en) => pick(lang, zh, en);

  // 上一轮还没结束（Stop 还没写下 turnEndedAt）而且是用户发起的。
  const inFlight = !!prev && prev.turnEndedAt === null && prev.origin === 'user';

  // 进行中插进来的系统信封不是一轮新对话，不许覆盖用户那一轮。
  // 2026-09-12 实证：两条 <task-notification> 覆盖了进行中的一轮，原话和声明一起丢了。
  if (origin === 'system' && inFlight) quietExit();

  // 上一轮没结束就来了新的用户消息，有两种来历：你按了打断（被打断不触发 Stop），
  // 或者你在 Claude 干活时又发了一条、Claude Code 在同一轮里把它交给 Claude（中途追加，这一轮没停）。
  // 覆盖之前先把上一轮记进日志，并从 transcript 补回已经写出的声明——否则永远丢失。
  // 只在这种少见情形下多读一次聊天记录（约几十毫秒），平常的回车不受影响。
  const now = new Date().toISOString();
  let midTurn = false;
  if (origin === 'user' && inFlight) {
    const found = findDeclaration({ transcript_path: input.transcript_path }, prev);
    const interrupted = interruptedSince(input.transcript_path, prev.transcriptOffset);
    midTurn = !interrupted;
    appendTurnLog(sessionId, {
      turnId: prev.turnId ?? null,
      at: prev.updatedAt ?? null,
      endedAt: null,
      interrupted,
      // 被追加的时刻。之后 Claude 写的理解夹在工具调用之间，聊天记录不存那段文字，读方据此显示「无法核对」。
      supersededAt: interrupted ? null : now,
      midTurn: prev.midTurn === true,
      reminded: prev.reminded ?? null,
      promptField: prev.promptField ?? null,
      origin: prev.origin ?? null,
      prompt: prev.prompt ?? null,
      decode: found?.decode ?? null,
      tag: found?.tag ?? null,
    });
  }

  // 待触发清单：没有配置就是 null，输出与以前一字不差。读不出不当成空（triggerBlock 自己说）。
  // 「可以」这类短确认也要带上：批准往往就发生在这种轮次。系统信封（后台通知等）不带，也不动 shown。
  let block = null;
  let shown = prev?.shown ?? null;
  if (origin !== 'system') {
    try {
      const r = triggerBlock(input.cwd, prev?.touched ?? [], prev?.shown ?? null);
      if (r) { block = r.text; shown = r.shown; }
    } catch {
      block = T('【Wishing-Willow · 待触发】清单读不出。不能当作没有待触发的条目。（私有清单，勿写进公开仓）',
        '[Wishing-Willow · Triggers] The trigger list can\'t be read. Don\'t take that as nothing being due. (Private list; keep it out of public repos.)');
    }
  }

  // 长清单：普通轮放开着的项（没变就只放要紧的，见 listBlock）；短确认、系统信封开始的一轮只放「等你」的。
  let list = null;
  let listShown = prev?.listShown ?? null;
  // 续接成新会话号的对话，清单还在前身名下：每个会话查一次，没有自己的清单才继承（_inherit.mjs）。
  let listInherit = prev?.listInherit ?? null;
  // 「新会话」「没有聊天记录」不是最终结论：续接时第一次 capture 可能比 Claude Code 抄旧消息还早
  // （09-28 实见，早 0.2 秒），那一次判成新会话，记下来就再也不查了。这两种下一轮再查；
  // 真正的新会话每轮只多读一次记录开头，第一条消息满五分钟后查一次就定为「没有前身」。
  if (!listInherit || listInherit.why === 'fresh' || listInherit.why === 'no-transcript') {
    try { listInherit = inheritList(sessionId, input.transcript_path, (prev?.turnIndex ?? -1) + 1); } catch (e) {
      listInherit = { from: null, at: now, why: 'error', error: String(e?.message ?? e).slice(0, 200) };
    }
  }
  try {
    const r = listBlock(sessionId, bypass ? 'always' : 'full', (prev?.turnIndex ?? -1) + 1, listShown, lang);
    list = r.text;
    listShown = r.shown;
    if (list && prev?.nextProblem) {
      list += T(`\n${prev.nextProblem}：这一轮的最后一行写成「下一步：Lx <这件事>——<为什么是它>」。`,
        `\n${prev.nextProblem}: end this turn with "Next: Lx <the item> — <why it comes first>".`);
    }
    if (list && prev?.listHeld) list += `\n${prev.listHeld}。`;
    // 作者在 lintel 面板里做的改动（spec 清单实时 C）：上一轮开始以来的都说一遍，模型不用从清单里自己找。
    // 从上一次 capture 起算：extract 会把 updatedAt 改成一轮结束的时刻，作者在一轮进行中点的会被漏掉。
    const byAuthor = authorChanges(sessionId, prev?.listAuthorSeen ?? prev?.updatedAt ?? now);
    if (list && byAuthor.length) {
      list += T(`\n你在面板里改了：${byAuthor.join('、')}（这些是你本人点的，照此更新计划）。`,
        `\nYou changed on the panel: ${byAuthor.join(', ')} (you clicked these yourself; plan accordingly).`);
    }
    if (list && listInherit.from && !prev?.listInherit?.from) {
      list = T(`【Wishing-Willow · 清单】这场对话是续接的：清单继承自会话 ${listInherit.from}，编号接着用。\n`,
        `[Wishing-Willow · List] This conversation was resumed: the list is carried over from session ${listInherit.from}, and the IDs continue.\n`) + list;
    }
  } catch {
    list = T('【Wishing-Willow · 清单】清单读不出，不能当作没有开着的事。', '[Wishing-Willow · List] The list can\'t be read. Don\'t take that as nothing being open.');
  }

  writeState(sessionId, {
    schema: SCHEMA,
    sessionId,
    pid: process.ppid,
    cwd: typeof input.cwd === 'string' ? input.cwd : null,
    turnId: typeof input.prompt_id === 'string' ? input.prompt_id : null,
    transcriptOffset: transcriptLength(input.transcript_path),
    // app 要在一轮进行中实时读这一轮（声明一写出就显示、进度跟着真实工具调用走），
    // 得知道文件在哪。2026-09-12 实测：声明写出后要等整轮结束才读，中位在后台躺 280 秒。
    transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null,
    turnIndex: (prev?.turnIndex ?? -1) + 1,
    updatedAt: now,
    prompt,
    promptField,
    origin,
    lang,                  // 写给模型的话用的语言（zh / en）；compacted、listctl、状态栏跟着它
    // 这一条是在上一轮进行中追加进来的（见上）。桌面端聊天记录只存一轮里第一次调用工具之前的文字和最后一段文字
    // （2026-09-13 实测），Claude 之后写的理解多半进不了文件——找不到不等于没写，读方显示「无法核对」。
    midTurn,
    reminded: !bypass,
    decode: null,          // absence is the signal; extract.mjs fills it in
    tag: null,             // ≤6 字，同样由 extract.mjs 填
    plan: null,            // 「计划：」块，逐步；同样由 extract.mjs 填，没声明就留 null
    next: null,            // 回复最后一行的「下一步：」
    touched: prev?.touched ?? null,   // 本会话用工具动过的路径，extract 每轮并进来；跨轮带着走
    shown,                 // 这一轮说了哪些待触发条目、各在什么阶段；下一轮拿来说「本轮变化」
    listShown,             // 长清单上次完整列出是哪份快照、第几轮；没变就不重列（_list.mjs）
    listInherit,           // 续接时从前身继承清单：查过一次就记下，{from, at, why}（_inherit.mjs）
    nextProblem: null,     // 上一轮「下一步」没点清单上开着的项时的问题，extract 写、下一轮 capture 说（spec D2）
    listHeld: null,        // 上一轮很长、清单变化全攒到回复末尾时的问题，extract 写、下一轮 capture 说（spec 清单实时 A）
    listAuthorSeen: now,   // 这一刻之前作者在面板里的改动都已经说过；下一轮只说这之后的（spec 清单实时 C）
    // 这一轮还没结束。extract 在 Stop 时写下时间戳。没有这一位，读方分不清
    // 「模型还在回答」和「答完了没写声明」—— 2026-09-12 用户实测：每一轮一开头
    // 灵动岛都冒一次橙色的「问了，模型没写声明」，而模型那时一个字都还没回。
    turnEndedAt: null,
    endedAt: null,
  });

  // 别的来源（写作循环）留给模型的话，由这一个出口一起说（_inbox.mjs）。普通轮带全部；
  // 短确认、系统信封开始的一轮只带常驻的那一行——两边用同一条轮次规则。读不出照实说。
  let inbox = null;
  try {
    inbox = inboxText(sessionId, input.prompt_id, bypass ? 'always' : 'full', lang);
  } catch {
    inbox = T('【Wishing-Willow】留言读不出。这一轮没带上别的来源要说的话，不能当作没有。',
      '[Wishing-Willow] Messages from other sources can\'t be read. This turn doesn\'t carry them; don\'t take that as there being none.');
  }

  if (bypass && !block && !inbox && !list) quietExit();

  // Must be complete, valid JSON: Claude Code treats output starting with '{'
  // but not ending in '}' as plain text.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      // 规则文件读不出时，只认得 [SYSTEM NOTIFICATION 这一种信封：照实说出来，不静默。
      additionalContext: (envelopeRulesProblem && !bypass
        ? T(`【Wishing-Willow】${envelopeRulesProblem}：后台通知等可能被当成你的话记下。\n`,
          `[Wishing-Willow] ${envelopeRulesProblem}: background notifications may be recorded as the user's words.\n`) : '')
        + [bypass ? null : `${reminder(lang)}\n${commandRule(sessionId, lang)}`, block, list, inbox].filter(Boolean).join('\n\n'),
    },
  }));
  process.exit(0);
} catch {
  quietExit();
}
