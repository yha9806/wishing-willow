import Foundation

/// 常亮层显示「哪一个会话」的规则，菜单栏和灵动岛共用一份。
///
/// 两处各写一份，早晚会漂成两套 —— 这个项目要抓的正是这种事。
/// 全部按事实排序，没有一条按内容挑：插件坏了最优先，然后是「没看过且模型标了 ⚠」，
/// 然后是「没看过」，否则最近更新的那个。「已读」压过 ⚠：警报的任务是让你去看，
/// 你看过了它就该闭嘴。
@MainActor
enum FocusRule {

    /// 胶囊里放什么。宽度只够一个符号加两三个字，所以是枚举，不是一句话。
    enum Pill: Equatable {
        case broken
        case choice(plan: Bool, since: Date?)
        case withdraw(interrupted: Bool)
        case running(since: Date?)
        case fresh(tag: String?, flagged: Bool)
        case silent
    }

    static func pill(_ s: SessionState, _ seen: SeenStore, _ store: WillowStore) -> Pill? {
        if s.declaration == .unreadable { return .broken }
        if let c = store.progress(for: s)?.pendingChoice { return .choice(plan: c.kind == .plan, since: c.at) }
        if let w = store.recentWithdraw[s.id] { return .withdraw(interrupted: w.kind == .interrupted) }
        if s.declaration == .inProgress { return .running(since: s.record.updatedAt) }
        guard seen.isUnread(s) else { return nil }
        if s.declaration == .undeclared { return .silent }
        if case .declared = s.declaration { return .fresh(tag: s.tag, flagged: s.flaggedByModel) }
        return nil
    }

    struct Label { let text: String; let carried: Bool }

    /// 只在有话说的时候占宽度。
    ///
    /// 这一轮没问（「好的 继续吧」）时，本轮没有标签，但任务通常还是上一轮那个。
    /// 用该会话**上一个真实写下的标签**，并标记为沿用，读方把它调暗 ——
    /// 不能把上一轮的解码冒充成这一轮的，也不该退回一个被截断的工作区名。
    static func label(_ s: SessionState, _ seen: SeenStore, _ store: WillowStore) -> Label? {
        if s.declaration == .unreadable { return Label(text: L("读不到输入", "Can’t read"), carried: false) }
        if let c = store.progress(for: s)?.pendingChoice {        // 看过也照样显示：它在等你
            return Label(text: c.kind == .plan ? L("等你批准", "Approve") : L("等你选择", "Your turn"), carried: false)
        }
        if let w = store.recentWithdraw[s.id] {
            return Label(text: w.kind == .interrupted ? L("已撤回", "Withdrawn") : L("撤回排队", "Unqueued"), carried: true)
        }
        if s.declaration == .interrupted { return nil }       // 撤回提示过后缩回刘海
        // 回答中：声明还没有，就老实说在回答。先前退回工作区名，截断成「twitter-cont…」，没有信息。
        if s.declaration == .inProgress {
            let p = store.progress(for: s)
            if let t = p?.tag { return Label(text: t, carried: false) }      // 声明刚写出——临时标签
            if p?.decode != nil { return Label(text: L("有新声明", "New reading"), carried: false) }
            // 这一轮没问（「继续吧」、后台任务通知）：不会有新标签，任务通常还是上一轮那个——沿用、调暗。
            if s.record.reminded == false, let t = lastLoggedTag(s, store) { return Label(text: t, carried: true) }
            if let p, p.firstWriteAt == nil { return Label(text: L("思考中", "Thinking"), carried: true) }
            return Label(text: L("回答中", "Answering"), carried: true)
        }
        guard seen.isUnread(s) else { return nil }          // 看过了 → 两翼缩回刘海，不遮东西
        // 中途追加的一轮：核对不了，不是出错。灰色（沿用态），不占橙色（用户 2026-09-13 定）。
        if s.declaration == .unverifiable { return Label(text: L("无法核对", "Can’t verify"), carried: true) }
        if s.declaration == .undeclared { return Label(text: L("没写声明", "No reading"), carried: false) }
        if let t = s.tag { return Label(text: t, carried: false) }
        if s.declaration == .notAsked, let t = lastLoggedTag(s, store) {
            return Label(text: t, carried: true)
        }
        if case .declared = s.declaration { return Label(text: L("有新声明", "New reading"), carried: false) }
        return nil                                          // 绝不退回工作区名
    }

    static func lastLoggedTag(_ s: SessionState, _ store: WillowStore) -> String? {
        TurnLog.read(sessionId: s.id, directory: store.directory)
            .last { ($0.tag ?? "").isEmpty == false }?.tag
    }
}
