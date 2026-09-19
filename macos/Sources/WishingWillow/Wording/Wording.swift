import AppKit
import Foundation

// 刘海上「写什么」的规则。2026-09-19 从视图文件里原样搬出（tools/cleanup_2026_09_19.py）：
// 来源模式不再画刘海（lintel 画），只把这些规则算出来的字写进活动文件。类型名不变，导出代码一行不改。

/// 圆心放什么。iPhone Duo 原版的圆心固定是 Wi-Fi 扇形；用户 2026-09-13 选的方案是圆心随状态换符号，
/// 这样左翼只要一个圆加计时，就能说清「在跑 / 等你 / 结束 / 出事」。
enum StatusCenter: Equatable {
    case live        // 在跑：Wi-Fi 扇形，写得越近越满
    case waiting     // Claude 在等你选择或批准
    case done        // 结束，写了理解
    case flagged     // 结束但问了没写，或 Claude 自标不一致
    case broken      // 插件读不到输入
    case withdrawn   // 你撤回了这一轮
    case idle        // 这一轮没问 / 还没开始

    static func of(_ s: SessionState, progress: TurnProgress?, withdrawn: Bool) -> StatusCenter {
        if s.declaration == .unreadable { return .broken }
        if withdrawn || s.declaration == .interrupted { return .withdrawn }
        if progress?.pendingChoice != nil { return .waiting }
        switch s.declaration {
        case .inProgress: return .live
        case .declared: return s.flaggedByModel ? .flagged : .done
        case .undeclared: return .flagged
        case .notAsked, .awaiting, .unverifiable: return .idle
        case .unreadable, .interrupted: return .broken
        }
    }
}

/// 工具调用配 SF Symbol：一眼分得出是在跑命令、读文件还是改文件。
enum ToolSymbol {
    static func name(_ tool: String?) -> String {
        switch tool ?? "" {
        case "Bash": "terminal"
        case "Read": "doc.text"
        case "Edit", "Write", "MultiEdit", "NotebookEdit": "pencil"
        case "Grep", "Glob": "magnifyingglass"
        case "WebFetch", "WebSearch": "globe"
        case "Agent", "Task": "person.2"
        case "AskUserQuestion": "questionmark.bubble"
        case "ExitPlanMode", "TodoWrite": "checklist"
        default: "circle.dotted"
        }
    }
}

enum Clock {
    static func text(_ t: TimeInterval) -> String {
        let s = max(0, Int(t))
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
                         : String(format: "%d:%02d", s / 60, s % 60)
    }

    /// 两翼用的短写法：刚刚 / 12 分 / 3 时。
    static func ago(_ d: Date, now: Date = Date()) -> String {
        let s = Int(now.timeIntervalSince(d))
        if s < 60 { return L("刚刚", "now") }
        if s < 3600 { return L("\(s / 60) 分", "\(s / 60)m") }
        return L("\(s / 3600) 时", "\(s / 3600)h")
    }
}

/// 时间轴分段与各段的名字（原 `TurnBar` 视图的静态部分；颜色与画法在 lintel）。
@MainActor   // 原来是视图结构体，默认在主线程上；保持同样的隔离
enum TurnBar {
    struct Segment: Equatable {
        enum Kind: Equatable, CaseIterable { case before, after, waiting, turn }
        let kind: Kind
        let from: Double
        let to: Double
    }

    static func fraction(_ d: Date?, _ tl: TurnTimeline, now: Date) -> Double? {
        guard let d else { return nil }
        let total = max(now.timeIntervalSince(tl.startedAt), 1)
        return min(1, max(0, d.timeIntervalSince(tl.startedAt) / total))
    }

    static func segments(_ tl: TurnTimeline, now: Date, asked: Bool = true) -> [Segment] {
        let d = fraction(tl.progress.declaredAt, tl, now: now)
        let c = tl.endedAt == nil ? fraction(tl.progress.pendingChoice?.at, tl, now: now) : nil
        let end = c ?? 1
        var out: [Segment] = []
        if !asked {
            out.append(Segment(kind: .turn, from: 0, to: end))
        } else if let d, d < end {
            out.append(Segment(kind: .before, from: 0, to: d))
            out.append(Segment(kind: .after, from: d, to: end))
        } else {
            out.append(Segment(kind: .before, from: 0, to: end))
        }
        if let c { out.append(Segment(kind: .waiting, from: c, to: 1)) }
        return out
    }

    static func name(_ k: Segment.Kind) -> String {
        switch k {
        case .before: L("写出理解前", "Before reading")
        case .after: L("写出理解后", "After reading")
        case .waiting: L("等你回应", "Waiting on you")
        case .turn: L("这一轮", "This turn")
        }
    }
}

/// 展开态的字（原 `IslandExpandedContent` 视图的静态部分）。
@MainActor
enum IslandExpandedContent {
    /// 精简版的一行：左边两个字的小标签，右边正文。
    struct CompactLine: Equatable {
        enum Tone: Equatable { case primary, secondary, warning, accent, quiet }
        let label: String
        let text: String
        let tone: Tone
        let lines: Int
    }

    /// 标签位只放「这一轮在做什么」。「思考中 / 回答中 / 等你选择」这类状态词在右边的阶段位上。
    /// 先前没有标签时退回 FocusRule.label（它在进行中返回的正是状态词），于是「思考中」写了两遍（用户 2026-09-13 悬停时看到）。
    /// 进行中还没写出标签：用上一轮的标签并调暗，标明是沿用的。
    static func earTag(_ s: SessionState, store: WillowStore, seen: SeenStore) -> (text: String, carried: Bool) {
        let p = store.progress(for: s)
        if let t = p?.tag ?? s.tag { return (t, false) }
        if s.declaration == .inProgress || s.declaration == .interrupted || p?.pendingChoice != nil {
            return (FocusRule.lastLoggedTag(s, store) ?? L("还没有标签", "No tag yet"), true)
        }
        if let l = FocusRule.label(s, seen, store), l.text != phaseWord(s, store: store) { return (l.text, l.carried) }
        return (FocusRule.lastLoggedTag(s, store) ?? L("还没有标签", "No tag yet"), true)
    }

    static func phaseWord(_ s: SessionState, store: WillowStore) -> String {
        if store.recentWithdraw[s.id] != nil { return L("撤回", "Withdrawn") }
        switch s.declaration {
        case .unreadable: return L("插件读不到", "Plugin can’t read")
        case .interrupted: return L("被打断", "Interrupted")
        case .awaiting: return L("等待开始", "Waiting to start")
        case .inProgress:
            guard let p = store.progress(for: s) else { return L("回答中", "Answering") }
            if let c = p.pendingChoice { return c.kind == .plan ? L("等你批准", "Awaiting approval") : L("等你选择", "Your turn") }
            if p.decode != nil { return L("实时", "Live") }
            return p.firstWriteAt == nil ? L("思考中", "Thinking") : L("回答中", "Answering")
        case .declared, .undeclared, .notAsked, .unverifiable: return L("已结束", "Ended")
        }
    }

    /// 主动弹出时放什么。等你选择：题面（最多两行）加一行「回 Claude Code 里作答」；
    /// 否则：你的要求一行、Claude 的理解最多两行（标了 ⚠ 用橙色，还没写出就说还没写出）。进度、步骤、数据条、翻页都不放。
    static func compactLines(_ s: SessionState, store: WillowStore) -> [CompactLine] {
        let p = store.progress(for: s)
        if let c = p?.pendingChoice {
            let ask = [c.question, c.header].compactMap { $0 }.first { !$0.isEmpty } ?? L("Claude 在等你选择", "Claude is waiting for your choice")
            return [CompactLine(label: c.kind == .plan ? L("批准", "Approve") : L("等你", "Your turn"), text: oneLine(ask), tone: .accent, lines: 2),
                    CompactLine(label: "", text: L("回 Claude Code 里作答", "Answer it in Claude Code"), tone: .quiet, lines: 1)]
        }
        let asked = s.record.isSystemMessage ? L("系统消息，不是你说的", "System message — not from you") : (s.prompt.map(oneLine) ?? "—")
        var read: String? = p?.decode
        if case .declared(let d) = s.declaration { read = d }
        let line2: CompactLine
        if let read {
            line2 = CompactLine(label: L("理解", "Read as"), text: oneLine(read), tone: read.hasPrefix("⚠") ? .warning : .primary, lines: 2)
        } else {
            line2 = CompactLine(label: L("理解", "Read as"), text: L("还没写出", "Not written yet"), tone: .quiet, lines: 1)
        }
        return [CompactLine(label: L("要求", "Asked"), text: asked, tone: .secondary, lines: 1), line2]
    }

    /// 只放两行的原话：换行压成空格。带换行的要求先前第一行后面空一行、正文被挤掉（2026-09-13 实拍）。
    static func oneLine(_ s: String) -> String {
        s.replacingOccurrences(of: "\\s*\\n+\\s*", with: " ", options: .regularExpression)
    }

    static func phase(_ p: TurnProgress?) -> String {
        guard let p else { return L("Claude 正在回答", "Claude is answering") }
        if p.firstWriteAt == nil { return L("思考中", "Thinking") }
        return p.steps.isEmpty ? L("开始回答，还没写出理解", "Started answering, no reading yet") : L("在执行，还没写出理解", "Working, no reading yet")
    }

    static func clock(_ d: Date) -> String {
        d.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
    }

    static func percent(_ f: Double) -> String { "\(Int((f * 100).rounded()))%" }
}

/// 胶囊里的字（原 `SessionPill` 视图的静态部分）。
@MainActor   // 原来是视图结构体，默认在主线程上；保持同样的隔离
enum SessionPill {
    /// 胶囊里写的字；在跑、等你选且知道起点时写计时，返回 nil。
    static func title(_ pill: FocusRule.Pill) -> String? {
        switch pill {
        case .broken: L("读不到", "Can’t read")
        case .choice(let plan, let since): since == nil ? (plan ? L("等批准", "Approve") : L("等你选", "Your turn")) : nil
        case .withdraw: L("撤回", "Withdrawn")
        case .running(let since): since == nil ? L("回答中", "Answering") : nil
        case .fresh: L("新声明", "New reading")
        case .silent: L("没写", "No reading")
        }
    }
}

/// 面板用到的时刻与时长写法（原 `DetailView` 视图的静态部分）。
@MainActor   // 原来是视图结构体，默认在主线程上；保持同样的隔离
enum DetailView {
    /// 关掉的时刻：插件写下的 `endedAt`；没有（进程没了、没跑到 SessionEnd）就用最后一次动静。
    static func closedAt(_ s: SessionState) -> Date { s.record.endedAt ?? WillowStore.activity(s) }

    static func duration(_ d: TimeInterval) -> String {
        let s = Int(d.rounded())
        if s < 60 { return L("\(s) 秒", "\(s)s") }
        let m = s / 60, r = s % 60
        if m < 60 { return r == 0 ? L("\(m) 分", "\(m)m") : L("\(m) 分 \(r) 秒", "\(m)m \(r)s") }
        return L("\(m / 60) 小时 \(m % 60) 分", "\(m / 60)h \(m % 60)m")
    }
}

/// 各轮的结局分类（原 `SessionChart` 视图的静态部分）。
@MainActor   // 原来是视图结构体，默认在主线程上；保持同样的隔离
enum SessionChart {
    enum Outcome: CaseIterable { case declared, flagged, silent, notAsked, interrupted, unverifiable }

    static func outcome(_ e: TurnLogEntry) -> Outcome? {
        if e.interrupted == true { return .interrupted }
        if e.declared { return e.flaggedByModel ? .flagged : .declared }
        if e.unverifiable { return .unverifiable }
        if e.reminded == true { return .silent }
        if e.reminded == false { return .notAsked }
        return nil
    }

    static func name(_ o: Outcome) -> String {
        switch o {
        case .declared: L("写了理解", "Reading")
        case .flagged: L("自标不一致", "Flagged")
        case .silent: L("问了没写", "No reading")
        case .notAsked: L("没问", "Not asked")
        case .interrupted: L("被打断", "Withdrawn")
        case .unverifiable: L("无法核对", "Can’t verify")
        }
    }
}
