import Foundation

/// 许愿柳作为 lintel 的来源程序：把每个会话写成一份活动（lintel 活动格式 v1）。
///
/// 灵动岛原来在视图里现算的东西——两翼标签、胶囊、耳朵、精简卡两行、「你的要求 / Claude 的理解 / Claude 在做」、
/// 数据条、点击面板的轮次与图表——在这里算成数据，lintel 只负责画。
/// 规则一条都不在这里新发明：每一段都对应一处原视图代码（注释里写了出处），迁移前后同一份状态必须画出同一个样子。
///
/// 依赖「你看过没有」的地方不在这里判：看过由 lintel 记。这里用两份临时的已读记录各算一遍（没看过 / 看过），
/// 写出「看过之后缩回」的开关或看过之后的另一种写法。
///
/// 输出是 JSON 字典，不依赖 lintel 的 Swift 代码：许愿柳公开仓不能引用私有仓，而且活动格式本来就是 JSON 协议。
/// 字段与 lintel `Sources/LintelCore/Validation.swift` 的结构表对齐，漂了由 `lintel validate` 抓。
@MainActor
enum ActivityExport {
    static let producerId = "willow"

    /// 许愿柳在 lintel 登记里的样子（`lintel register` 等价物，供 --lintel-register 与测试用）。
    static var registration: [String: Any] {
        [
            "name": L("许愿柳", "Wishing Willow"),
            "initial": "W",
            "events": [
                "declaration": ["attention": true],
                "choice": ["attention": true],
                "withdraw-interrupted": ["attention": false, "dismissExpandedAfter": 1.8],
                "withdraw-queued": ["attention": false],
            ],
            "nouns": [
                "activities": L("会话", "Sessions"),
                "history": L("轮次", "Turns"),
                "recentHistory": L("最近的轮次", "Recent turns"),
                "noTag": L("还没有标签", "No tag yet"),
            ],
        ]
    }

    /// 带时区与毫秒（与插件 `toISOString()` 同一种写法）。lintel 拒收不带时区的时刻。
    static func iso(_ d: Date?) -> Any { d.map { $0.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)) } ?? NSNull() }
    static func opt(_ v: Any?) -> Any { v ?? NSNull() }

    /// 全部会话 → [活动 id: 活动字典]。
    static func activities(_ store: WillowStore, now: Date = Date()) -> [String: [String: Any]] {
        var out: [String: [String: Any]] = [:]
        for s in store.sessions { out[s.id] = activity(s, store, now: now) }
        return out
    }

    /// 这一轮还在进行：声明在等、而且会话进程还在。进程不在了（一轮没写完就关掉），这一轮不会再进行——
    /// 先前照样导出成「在跑」：计时从几天前一直走、胶囊在闪、带心跳，来源进程每 30 秒重写这些文件（F9，lintel 负担报告 2026-09-18）。
    static func turnLive(_ s: SessionState) -> Bool { s.declaration == .inProgress && s.isOpen }

    static func activity(_ s: SessionState, _ store: WillowStore, now: Date) -> [String: Any] {
        let unseen = SeenStore(ephemeral: true)
        let seen = SeenStore(ephemeral: true)
        if let t = s.record.turnId { seen.markSeen(sessionId: s.id, turnId: t) }
        let p = store.progress(for: s)
        let tl = store.timeline(for: s)

        var a: [String: Any] = [
            "schema": 1,
            "id": s.id,
            "revision": opt(s.record.turnId),
            "updatedAt": iso(s.record.updatedAt),
            "open": s.isOpen,
            "running": s.isRunning,
            "stale": s.isStale,
            "inProgress": turnLive(s),
            "rank": rank(s, store),
            "flagged": s.flaggedByModel,
            "activityAt": iso(WillowStore.activity(s)),
            "closedAt": iso(DetailView.closedAt(s)),
            "group": ["id": s.record.cwd ?? s.workspace, "name": s.workspace],
            "events": events(s, store),
            "status": status(s, store),
        ]
        // 进行中的一轮计时在走：许愿柳停了（来源进程退出），lintel 要能看出「没有消息」，不能让计时一直走下去。
        if turnLive(s) { a["heartbeatSeconds"] = 60 }

        // 右翼：FocusRule.label；看过之后是否缩回
        let lu = FocusRule.label(s, unseen, store)
        let ls = FocusRule.label(s, seen, store)
        a["label"] = lu.map { ["text": $0.text, "tone": s.declaration == .unreadable ? "red" : ($0.carried ? "white55" : "white")] } ?? NSNull()
        a["labelUntilSeen"] = lu != nil && ls == nil

        // 胶囊：FocusRule.pill + SessionPill
        let pu = FocusRule.pill(s, unseen, store)
        let ps = FocusRule.pill(s, seen, store)
        // 关掉的会话不上刘海（stale），胶囊不导出：它里面的「在跑」符号与计时只会是旧的。
        a["pill"] = s.isOpen ? (pu.map { pill($0, s, store) } ?? NSNull()) : NSNull()
        a["pillUntilSeen"] = s.isOpen && pu != nil && ps == nil

        // 耳朵：IslandExpandedContent.ears
        let tu = IslandExpandedContent.earTag(s, store: store, seen: unseen)
        let ts = IslandExpandedContent.earTag(s, store: store, seen: seen)
        var ears: [String: Any] = ["leading": s.workspace, "tag": earTag(tu, s), "phase": IslandExpandedContent.phaseWord(s, store: store)]
        if tu != ts { ears["tagSeen"] = earTag(ts, s) }
        a["ears"] = ears

        a["popup"] = IslandExpandedContent.compactLines(s, store: store).map { line -> [String: Any] in
            let tone: String = switch line.tone {
            case .primary: "primary"
            case .secondary: "secondary"
            case .warning: "warning"
            case .accent: "accent"
            case .quiet: "quiet"
            }
            return ["label": line.label, "text": line.text, "tone": tone, "lines": line.lines]
        }

        var body: [[String: Any]] = [request(s, tl), reading(s, tl, p)]
        if let tl { body.append(working(tl, asked: s.record.reminded != false)) }
        body.append(["kind": "stats", "cells": islandStats(s, tl, store)])
        a["body"] = body

        a["flip"] = ["title": title(s, store), "subtitle": s.workspace, "phase": IslandExpandedContent.phaseWord(s, store: store)]
        a["detail"] = detail(s, store, tl: tl, unseen: unseen, seen: seen)
        return a
    }

    // MARK: 排序字段

    /// 原 FocusRule.focus 的前三条（排序本身在 lintel 的 Ordering）：插件坏了 > 等你选择 > 刚撤回。
    static func rank(_ s: SessionState, _ store: WillowStore) -> String {
        if s.declaration == .unreadable { return "anomaly" }
        if store.progress(for: s)?.pendingChoice != nil { return "waiting" }
        if store.recentWithdraw[s.id] != nil { return "event" }
        return "none"
    }

    /// WillowStore 的 onDeclarationArrived / onChoiceArrived / onWithdraw，改成按状态写出的事件。id 稳定：同一件事每次导出都是同一个 id，lintel 只展开一次。
    static func events(_ s: SessionState, _ store: WillowStore) -> [[String: Any]] {
        guard let turn = s.record.turnId else { return [] }
        var out: [[String: Any]] = []
        let p = store.progress(for: s)
        let decoded = (p?.decode != nil && p?.interruptedAt == nil) || s.record.decode?.isEmpty == false
        if decoded {
            out.append(["id": "declaration|\(turn)", "type": "declaration", "at": iso(p?.declaredAt ?? s.record.updatedAt)])
        }
        if let c = p?.pendingChoice {
            out.append(["id": "choice|\(c.id)", "type": "choice", "at": iso(c.at)])
        }
        if let at = p?.interruptedAt {
            out.append(["id": "withdraw-interrupted|\(turn)", "type": "withdraw-interrupted", "at": iso(at)])
        }
        if let n = p?.withdrawnQueued.count, n > 0 {
            out.append(["id": "withdraw-queued|\(turn)|\(n)", "type": "withdraw-queued", "at": iso(store.recentWithdraw[s.id]?.at)])
        }
        return out
    }

    // MARK: 收起态

    /// WingStatus + DuoGlyph。
    static func status(_ s: SessionState, _ store: WillowStore) -> [String: Any] {
        let p = store.progress(for: s)
        let withdraw = store.recentWithdraw[s.id]
        let snap = ClaudeStatus.snapshot(store.timeline(for: s)?.progress, settingsModel: store.settingsModel)
        let center: String = switch StatusCenter.of(s, progress: p, withdrawn: withdraw != nil) {
        case .live: "live"
        case .waiting: "waiting"
        case .done: "done"
        case .flagged: "flagged"
        case .broken: "broken"
        case .withdrawn: "withdrawn"
        case .idle: "idle"
        }
        var out: [String: Any] = ["center": center == "live" && !s.isOpen ? "idle" : center]
        if let snap {
            out["ringRemaining"] = snap.remaining
            out["lastWriteAt"] = iso(snap.lastWrite)
            out["summary"] = L("上下文剩 \(Int((snap.remaining * 100).rounded()))%（已用 \(ClaudeStatus.compact(snap.contextUsed)) / \(ClaudeStatus.compact(snap.window))）",
                               "Context \(Int((snap.remaining * 100).rounded()))% left (\(ClaudeStatus.compact(snap.contextUsed)) of \(ClaudeStatus.compact(snap.window)) used)")
        } else {
            out["summary"] = L("还没有这一轮的 token 数据", "No token data for this turn yet")
        }
        if let w = withdraw { out["bounceAt"] = iso(w.at) }
        if let w = withdraw, w.kind == .interrupted, let start = s.record.updatedAt, let end = p?.interruptedAt {
            out["clock"] = ["style": "frozen", "seconds": end.timeIntervalSince(start)]
        } else if let c = p?.pendingChoice, s.isOpen {
            out["clock"] = ["style": "live", "since": iso(c.at ?? s.record.updatedAt ?? Date()), "opacity": 0.8]
        } else if turnLive(s), let start = s.record.updatedAt {
            out["clock"] = ["style": "live", "since": iso(start), "opacity": 0.7]
        } else if s.declaration != .unreadable, let end = s.record.turnEndedAt ?? s.record.updatedAt {
            out["clock"] = ["style": "ago", "since": iso(end)]
        }
        return out
    }

    /// SessionPill：符号 / 圆点 + 计时或两三个字。
    static func pill(_ pill: FocusRule.Pill, _ s: SessionState, _ store: WillowStore) -> [String: Any] {
        var out: [String: Any] = ["pulse": false]
        switch pill {
        case .broken: out["symbol"] = "exclamationmark.triangle.fill"; out["tint"] = "red"
        case .choice(let plan, let since):
            out["symbol"] = plan ? "checklist" : "questionmark.bubble.fill"; out["tint"] = "blue"
            if let since { out["clockSince"] = iso(since) }
        case .withdraw: out["symbol"] = "arrow.uturn.backward"
        case .running(let since):
            out["symbol"] = "ellipsis"; out["pulse"] = true
            if let since { out["clockSince"] = iso(since) }
        case .fresh(_, let flagged): out["dot"] = flagged ? "orange" : "white"
        case .silent: out["dot"] = "orange"
        }
        if let t = SessionPill.title(pill) { out["title"] = t }
        out["preview"] = store.progress(for: s)?.tag ?? s.tag ?? FocusRule.lastLoggedTag(s, store) ?? s.workspace
        return out
    }

    static func earTag(_ t: (text: String, carried: Bool), _ s: SessionState) -> [String: Any] {
        ["text": t.text, "tone": s.flaggedByModel ? "orange" : (t.carried ? "inkTertiary" : "inkPrimary")]
    }

    // MARK: 展开态三块（IslandExpandedContent.request / reading / working / stats）

    static func section(_ title: String, value: String? = nil, valueTone: String? = nil, badge: String? = nil, items: [[String: Any]]) -> [String: Any] {
        var out: [String: Any] = ["kind": "section", "title": title, "items": items]
        if let value { out["value"] = value }
        if let valueTone { out["valueTone"] = valueTone }
        if let badge { out["badge"] = badge }
        return out
    }

    static func para(_ text: String, _ tone: String) -> [String: Any] { ["kind": "para", "text": text, "tone": tone] }

    static func request(_ s: SessionState, _ tl: TurnTimeline?) -> [String: Any] {
        let system = s.record.isSystemMessage
        let start = tl?.startedAt ?? (s.declaration == .inProgress ? s.record.updatedAt : nil)
        let value = [start.map(IslandExpandedContent.clock), system ? nil : s.prompt.map { L("\($0.count) 字", "\($0.count) chars") }]
            .compactMap { $0 }.joined(separator: " · ")
        return section(system ? L("这一轮", "This turn") : L("你的要求", "Your request"), value: value.isEmpty ? nil : value, items: [
            para(system ? L("系统消息（\(PromptSource.describe(s.prompt))），不是你说的", "System message (\(PromptSource.describe(s.prompt))) — not from you")
                        : (s.prompt.map(IslandExpandedContent.oneLine) ?? "—"),
                 system ? "inkSecondary" : "inkPrimary"),
        ])
    }

    static func offsetNote(_ d: Date?, _ tl: TurnTimeline?) -> String? {
        guard let d, let start = tl?.startedAt else { return nil }
        return "+" + Clock.text(d.timeIntervalSince(start))
    }

    static func reading(_ s: SessionState, _ tl: TurnTimeline?, _ p: TurnProgress?) -> [String: Any] {
        let title = L("Claude 的理解", "Claude’s reading")
        switch s.declaration {
        case .declared(let d):
            var parts: [String] = []
            if let at = offsetNote(tl?.progress.declaredAt, tl) { parts.append(at + L(" 写出", " written")) }
            parts.append(s.flaggedByModel ? L("⚠ Claude 自标不一致", "⚠ Claude flagged a mismatch") : L("已结束", "Ended"))
            return section(title, value: parts.joined(separator: " · "), valueTone: s.flaggedByModel ? "orange" : "inkTertiary",
                           items: [para(d, s.flaggedByModel ? "orange" : "inkPrimary")])
        case .undeclared:
            return section(title, value: L("已结束 · 没有写", "Ended · none written"), valueTone: "orange",
                           items: [para(L("问了，Claude 没写理解", "Asked, but Claude wrote no reading"), "orange")])
        case .unverifiable:
            return section(title, value: L("中途追加 · 无法核对", "Sent mid-turn · can’t verify"), items: [
                para(L("这条是 Claude 干活时追加的。之后写的理解不会存进聊天记录，这一轮核对不了——不代表没写。",
                       "You sent this while Claude was working. A reading written after it isn’t saved to the transcript, so this turn can’t be checked — that doesn’t mean none was written."),
                     "inkTertiary"),
            ])
        case .unreadable:
            return section(title, value: L("插件读不到输入", "Plugin can’t read the input"), valueTone: "red", items: [
                para(L("读不到本轮输入 —— 插件坏了，不是 Claude 没说话", "Can’t read this turn’s input — the plugin is broken, Claude isn’t silent"), "red"),
            ])
        case .awaiting:
            return section(title, value: L("等待开始", "Waiting to start"), items: [para(L("等这一轮开始", "Waiting for this turn to start"), "inkTertiary")])
        case .notAsked:
            return section(title, value: L("这一轮没问", "Not asked this turn"),
                           items: [para(L("这一轮没问（太短或是系统消息）", "Not asked (too short, or a system message)"), "inkTertiary")])
        case .interrupted:
            var items: [[String: Any]] = [["kind": "iconLine", "symbol": "arrow.uturn.backward", "text": L("你撤回了这一轮", "You withdrew this turn")]]
            if let d = p?.decode { items.append(para(L("撤回前的理解：", "Reading before you withdrew: ") + d, "inkTertiary")) }
            return section(title, value: offsetNote(p?.interruptedAt, tl).map { L("撤回于 ", "Withdrawn at ") + $0 }, items: items)
        case .inProgress where s.record.reminded == false:
            return section(title, value: L("这一轮没问", "Not asked this turn"),
                           items: [para(L("这一轮没问（太短或是系统消息）", "Not asked (too short, or a system message)"), "inkTertiary")])
        case .inProgress:
            if let d = p?.decode {
                return section(title, value: offsetNote(p?.declaredAt, tl).map { $0 + L(" 写出", " written") }, badge: L("实时", "Live"),
                               items: [para(d, d.hasPrefix("⚠") ? "orange" : "inkPrimary")])
            }
            var pending: [String: Any] = ["kind": "pending", "symbol": "ellipsis", "text": IslandExpandedContent.phase(p)]
            if let start = s.record.updatedAt { pending["clockSince"] = iso(start) }
            return section(title, value: L("还没写出", "Not written yet"), items: [pending])
        }
    }

    static func working(_ tl: TurnTimeline, asked: Bool, stepLimit: Int = 2) -> [String: Any] {
        let p = tl.progress
        let live = tl.endedAt == nil && p.interruptedAt == nil
        var value = [L("\(p.steps.count) 步", "\(p.steps.count) steps")]
        if let first = p.firstWriteAt { value.append(L("首次落盘 +", "first write +") + Clock.text(first.timeIntervalSince(tl.startedAt))) }
        var items: [[String: Any]] = []
        if live, let c = p.pendingChoice { items.append(choice(c)) }
        items.append(timeline(tl, asked: asked, sentLabel: true))
        if !(live && p.pendingChoice != nil), !p.steps.isEmpty { items.append(steps(tl, limit: stepLimit)) }
        return section(live ? L("Claude 在做", "Claude is working") : L("Claude 做了", "What Claude did"), value: value.joined(separator: " · "), items: items)
    }

    /// ChoiceCard 的文字。
    static func choice(_ c: TurnProgress.Choice) -> [String: Any] {
        var out: [String: Any] = [
            "kind": "choice",
            "choiceKind": c.kind == .plan ? "plan" : "question",
            "title": c.kind == .plan ? L("Claude 在等你批准计划", "Claude is waiting for plan approval") : L("Claude 在等你选择", "Claude is waiting for your choice"),
            "options": c.options,
            "action": c.kind == .plan ? L("回到 Claude Code 里批准", "Approve in Claude Code") : L("回到 Claude Code 里选择", "Answer in Claude Code"),
        ]
        if c.count > 1 { out["countNote"] = L("共 \(c.count) 题", "\(c.count) questions") }
        if let at = c.at { out["at"] = iso(at) }
        if let q = c.question { out["question"] = q }
        return out
    }

    /// TurnBar.segments 改用时刻表达：lintel 按「现在」现算比例。
    static func timeline(_ tl: TurnTimeline, asked: Bool, sentLabel: Bool) -> [String: Any] {
        let d = tl.progress.declaredAt
        let c = tl.endedAt == nil ? tl.progress.pendingChoice?.at : nil
        func seg(_ k: TurnBar.Segment.Kind, _ from: Date?, _ to: Date?, mergeIfEmpty: Bool = false) -> [String: Any] {
            let swatch: String = switch k {
            case .before: "purple"
            case .after: "mint"
            case .waiting: "deepBlue"
            case .turn: "gray"
            }
            var out: [String: Any] = ["name": TurnBar.name(k), "swatch": swatch, "from": iso(from), "to": iso(to)]
            if mergeIfEmpty { out["mergeIfEmpty"] = true }
            return out
        }
        var segs: [[String: Any]] = []
        if !asked {
            segs.append(seg(.turn, nil, c))
        } else if let d {
            // 分不分成前后两段由 lintel 按比例现算（TurnBar.segments 的 `d < end` 是在截到 0…1 的比例上比的，不是按时刻先后）。
            segs.append(seg(.before, nil, d))
            segs.append(seg(.after, d, c, mergeIfEmpty: true))
        } else {
            segs.append(seg(.before, nil, c))
        }
        if let c { segs.append(seg(.waiting, c, nil)) }
        return [
            "kind": "timeline",
            "startedAt": iso(tl.startedAt),
            "endedAt": iso(tl.endedAt),
            "segments": segs,
            "markAt": iso(d),
            "ticks": tl.progress.steps.suffix(120).compactMap(\.at).map { iso($0) },
            "endLabel": tl.progress.interruptedAt != nil ? L("撤回", "Withdrawn") : (tl.endedAt == nil ? L("现在", "Now") : L("结束", "Ended")),
            "sentPrefix": sentLabel ? L("回车 ", "Sent ") : NSNull(),
        ]
    }

    static func steps(_ tl: TurnTimeline, limit: Int) -> [String: Any] {
        let all = tl.progress.steps
        let recent = Array(all.suffix(limit))
        return [
            "kind": "steps",
            "offset": all.count - recent.count,
            "items": recent.map { ["symbol": ToolSymbol.name($0.tool), "text": $0.text, "at": iso($0.at)] },
            "startedAt": iso(tl.startedAt),
            "live": tl.endedAt == nil && tl.progress.interruptedAt == nil,
            "limit": limit,
        ]
    }

    static func ringTone(_ remaining: Double) -> String {
        switch ClaudeStatus.level(remaining: remaining) {
        case .critical: "red"
        case .low: "orange"
        case .normal: "inkPrimary"
        }
    }

    static func islandStats(_ s: SessionState, _ tl: TurnTimeline?, _ store: WillowStore) -> [[String: Any]] {
        let status = ClaudeStatus.snapshot(tl?.progress, settingsModel: store.settingsModel)
        let log = TurnLog.read(sessionId: s.id, directory: store.directory)
        let asked = log.filter { $0.reminded == true && $0.interrupted != true }
        let wrote = asked.filter(\.declared).count
        return [
            ["label": status.map { L("上下文 · \(ClaudeStatus.compact($0.window)) 窗口", "Context · \(ClaudeStatus.compact($0.window))") } ?? L("上下文", "Context"),
             "value": status.map { "\(ClaudeStatus.compact($0.contextUsed)) · \(IslandExpandedContent.percent($0.usedFraction))" } ?? "—",
             "tone": status.map { ringTone($0.remaining) } ?? "inkTertiary"],
            ["label": L("缓存命中", "Cache hits"), "value": status.map { IslandExpandedContent.percent($0.cacheHit) } ?? "—"],
            ["label": L("本轮输出", "Output this turn"), "value": status.map { ClaudeStatus.compact($0.outputTokens) } ?? "—"],
            ["label": L("写了理解", "Readings written"), "value": asked.isEmpty ? "—" : L("\(wrote)/\(asked.count) 轮", "\(wrote)/\(asked.count) turns")],
        ]
    }

    static func title(_ s: SessionState, _ store: WillowStore) -> String {
        store.progress(for: s)?.tag ?? s.tag ?? FocusRule.lastLoggedTag(s, store) ?? L("还没有标签", "No tag yet")
    }

    // MARK: 点击面板（DetailView）

    static func dot(_ s: SessionState, _ store: WillowStore, _ seen: SeenStore) -> String {
        if s.isStale { return "white25" }
        if s.declaration == .unreadable { return "red" }
        if store.progress(for: s)?.pendingChoice != nil { return "blue" }
        if s.declaration == .inProgress { return "white70" }
        if s.flaggedByModel || s.declaration == .undeclared { return "orange" }
        return seen.isUnread(s) ? "white" : "white35"
    }

    static func line(_ label: String, _ text: String, _ tone: String) -> [String: Any] { ["label": label, "text": text, "tone": tone] }

    static func askedLine(system: Bool, prompt: String?) -> [String: Any] {
        system ? line(L("要求", "Asked"), L("系统消息（\(PromptSource.describe(prompt))），不是你说的", "System message (\(PromptSource.describe(prompt))) — not from you"), "inkTertiary")
               : line(L("要求", "Asked"), prompt ?? "—", "inkPrimary")
    }

    /// DetailView.decodeLine：「被打断」「问了没答」「没问」「不知道」是不同的话。
    static func readLine(_ t: TurnLogEntry) -> [String: Any] {
        let label = L("理解", "Read")
        if t.declared { return line(label, t.decode ?? "", t.flaggedByModel ? "orange" : "inkPrimary") }
        if t.interrupted == true { return line(label, L("被打断，没来得及写", "Interrupted before one was written"), "inkTertiary") }
        if t.unverifiable { return line(label, L("中途追加，无法核对", "Sent mid-turn — can’t verify"), "inkTertiary") }
        if t.reminded == true { return line(label, L("问了，Claude 没写理解", "Asked, but Claude wrote no reading"), "orange") }
        if t.reminded == false { return line(label, L("这一轮没问（太短或是系统消息）", "Not asked (too short, or a system message)"), "inkTertiary") }
        return line(label, L("不知道这一轮问没问", "Unknown whether this turn was asked"), "inkTertiary")
    }

    static func chartSwatch(_ o: SessionChart.Outcome?) -> String {
        switch o {
        case .declared: "white85"
        case .flagged: "orange"
        case .silent: "coral"
        case .notAsked: "white28"
        case .interrupted: "white50"
        case .unverifiable: "slate"
        case nil: "white18"
        }
    }

    static func detail(_ s: SessionState, _ store: WillowStore, tl: TurnTimeline?, unseen: SeenStore, seen: SeenStore) -> [String: Any] {
        let entries = TurnLog.read(sessionId: s.id, directory: store.directory)
        let p = store.progress(for: s)
        let status = ClaudeStatus.snapshot(tl?.progress, settingsModel: store.settingsModel)
        var out: [String: Any] = ["listTitle": title(s, store), "dot": dot(s, store, unseen)]
        let ds = dot(s, store, seen)
        if ds != out["dot"] as? String { out["dotSeen"] = ds }

        let times = entries.compactMap(\.at)
        if let first = times.min(), let last = times.max() {
            out["historyNote"] = "\(IslandExpandedContent.clock(first))–\(IslandExpandedContent.clock(last)) · " + L("\(entries.count) 轮", "\(entries.count) turns")
        }
        out["history"] = entries.reversed().map { t -> [String: Any] in
            [
                "id": t.id, "at": iso(t.at), "tag": opt(t.tag),
                "badge": t.interrupted == true ? L("被打断", "Interrupted") : NSNull(),
                "duration": t.duration.flatMap { $0 >= 1 ? DetailView.duration($0) : nil } ?? NSNull(),
                "lines": [askedLine(system: t.isSystemMessage, prompt: t.prompt), readLine(t)],
                "expandable": (t.prompt?.count ?? 0) > 36 || (t.decode?.count ?? 0) > 36,
            ]
        }
        if turnLive(s), let turn = s.record.turnId, !entries.contains(where: { $0.turnId == turn }) {
            var live: [String: Any] = [
                "at": iso(s.record.updatedAt), "tag": opt(p?.tag ?? s.tag), "badge": L("进行中", "Live"), "clockSince": iso(s.record.updatedAt),
                "lines": [
                    askedLine(system: s.record.isSystemMessage, prompt: s.prompt),
                    p?.decode.map { line(L("理解", "Read"), $0, $0.hasPrefix("⚠") ? "orange" : "inkPrimary") }
                        ?? line(L("理解", "Read"), IslandExpandedContent.phase(p), "inkTertiary"),
                ],
            ]
            if let tl {
                if let c = p?.pendingChoice { var x = choice(c); x.removeValue(forKey: "kind"); live["choice"] = x }
                var t = timeline(tl, asked: s.record.reminded != false, sentLabel: false); t.removeValue(forKey: "kind"); live["timeline"] = t
                if !tl.progress.steps.isEmpty { var x = steps(tl, limit: 3); x.removeValue(forKey: "kind"); live["steps"] = x }
            }
            out["live"] = live
        }

        // SessionChart
        let ds2 = entries.compactMap(\.duration).sorted()
        let running = turnLive(s) ? tl?.startedAt : nil
        let headline = ds2.isEmpty
            ? (running == nil ? L("还没有记录", "No records yet") : L("这一轮还在进行", "This turn is still running"))
            : L("\(entries.count) 轮 · 中位 \(DetailView.duration(ds2[ds2.count / 2])) · 对数纵轴", "\(entries.count) turns · median \(DetailView.duration(ds2[ds2.count / 2]))")
        let counts = Dictionary(grouping: entries.compactMap(SessionChart.outcome)) { $0 }.mapValues(\.count)
        out["chart"] = [
            "title": L("各轮时长", "Turn durations"),
            "headline": headline,
            "bars": entries.map { e -> [String: Any] in ["seconds": opt(e.duration), "swatch": chartSwatch(SessionChart.outcome(e))] },
            "runningSince": iso(running),
            "legend": SessionChart.Outcome.allCases.map { ["name": SessionChart.name($0), "swatch": chartSwatch($0), "count": counts[$0] ?? 0] },
        ] as [String: Any]

        // DetailView.statusStrip
        let asked = entries.filter { $0.reminded == true && $0.interrupted != true }
        let wrote = asked.filter(\.declared).count
        let longest = entries.compactMap(\.duration).max()
        var context: [String: Any] = [
            "label": status.map { L("上下文 · \(ClaudeStatus.compact($0.contextUsed))/\(ClaudeStatus.compact($0.window))", "Context · \(ClaudeStatus.compact($0.contextUsed))/\(ClaudeStatus.compact($0.window))") } ?? L("上下文", "Context"),
            "value": status.map { IslandExpandedContent.percent($0.usedFraction) } ?? "—",
            "tone": status.map { ringTone($0.remaining) } ?? "inkTertiary",
        ]
        if let status { context["gauge"] = status.usedFraction }
        var cache: [String: Any] = ["label": L("缓存命中", "Cache hits"), "value": status.map { IslandExpandedContent.percent($0.cacheHit) } ?? "—"]
        if let status { cache["dots"] = ClaudeStatus.dots(cacheHit: status.cacheHit) }
        out["stats"] = [
            context, cache,
            ["label": status.map { L("输出 · \($0.requests) 次请求", "Output · \($0.requests) req") } ?? L("本轮输出", "Output this turn"),
             "value": status.map { ClaudeStatus.compact($0.outputTokens) } ?? "—"],
            ["label": L("写了理解", "Readings written"), "value": asked.isEmpty ? "—" : L("\(wrote)/\(asked.count) 轮", "\(wrote)/\(asked.count) turns")],
            ["label": L("最长一轮", "Longest turn"), "value": longest.map(DetailView.duration) ?? "—"],
        ]
        return out
    }

    // MARK: 写盘

    static func encode(_ obj: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    /// 写一份活动：先写临时文件再改名，lintel 读不到半个文件。内容没变就不写（mtime 不变），心跳另算。
    @discardableResult
    static func write(_ activity: [String: Any], to dir: URL, force: Bool = false) throws -> Bool {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let id = activity["id"] as! String
        let url = dir.appendingPathComponent("\(id).json")
        let data = try encode(activity)
        if !force, let old = try? Data(contentsOf: url), old == data { return false }
        let tmp = dir.appendingPathComponent(".\(id).json.\(getpid()).tmp")
        try data.write(to: tmp)
        if FileManager.default.fileExists(atPath: url.path) {
            _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
        } else {
            try FileManager.default.moveItem(at: tmp, to: url)
        }
        return true
    }
}
