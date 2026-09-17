import SwiftUI
import Charts

/// 点击灵动岛之后的面板——灵动岛本身再长大一档，不是另开一个窗口。
///
/// 历次用户实测后的改动：标准窗口「跳脱」→ 改为岛本身长大；同名会话分不清 → 带会话号；时长「1,911 秒」→ 分秒。
/// 2026-09-12 夜：用户判定图纸装饰（点阵、加重四角、引线、圈号）不符合 Apple 风格，改为 Apple 的做法——
/// 圆角连续的分组底、「标签 … 值」的行、Swift Charts 画柱状图、底部一条数据条。
/// 打开面板时内容等形状长到位再淡入、不用模糊（模糊渐显让行与行糊成一片，用户看到的是「文字叠加」）。
/// 每一轮点一下展开全文。
struct DetailView: View {
    let store: WillowStore
    let seen: SeenStore
    var notchWidth: CGFloat = 185
    var notchHeight: CGFloat = 32
    var onClose: (() -> Void)? = nil
    /// 打开时显示哪个会话：灵动岛上正显示的那个。先前不传，面板总是打开列表第一个（用户 2026-09-13 报「点进去不是对应的内容」）。
    var focus: String? = nil
    @State private var picked: String?
    @State private var shown = Offscreen.isRendering
    @State private var openRows: Set<String> = []
    /// 「已关闭」那一行展开了没有。默认折叠（用户 2026-09-17）。
    @State private var showClosed = Self.demoClosed
    /// 已关闭里展开了的工作区组。
    @State private var openGroups: Set<String> = []
    /// 在上面那段里点过的会话：面板开着时它关掉了，也留在原处。
    @State private var keptOpen: Set<String> = []

    /// 含两侧凹肩的形状尺寸；内容宽 = 宽 − 2 × 19。
    /// 高度先前是 480：左栏 4 行会话 + 图表正好占满，加「已关闭」一行（26 + 间距 8）就把底部数据条挤出去 32pt（2026-09-17 实拍）。
    static let size = CGSize(width: 620, height: 514)
    /// 内容等形状基本长到位再出现（开形状的弹簧：宽 0.34 秒、高 0.5 秒）。
    private static let revealAfter = 0.22
    /// 正文对齐线：行内标签宽 32 + 间距 8。时刻、进度条、步骤都对齐到这里。
    /// 先前是 34：时刻「17:31」放不下，被挤成两行（2026-09-13 截图）。
    private static let keyline: CGFloat = 40

    private var sessions: [SessionState] { store.sessions }
    private var current: SessionState? { Self.current(sessions, picked: picked, focus: focus) }

    /// 面板里选中哪个会话：在面板里点过的 → 打开时灵动岛上显示的 → 列表第一个（那个会话已经不在时）。
    static func current(_ sessions: [SessionState], picked: String?, focus: String?) -> SessionState? {
        for id in [picked, focus].compactMap({ $0 }) {
            if let s = sessions.first(where: { $0.id == id }) { return s }
        }
        return sessions.first
    }

    /// 已关闭的会话按工作区合并成的一组。`id` 是完整路径：同名不同路径的工作区不合并。
    struct ClosedGroup: Identifiable, Equatable {
        let id: String
        let workspace: String
        let sessions: [SessionState]     // 新 → 旧
        let lastActive: Date
    }

    /// 左栏分两段（用户 2026-09-17）：开着的平铺；关掉的按工作区合并、默认折叠。
    /// 按事实分，不按时间阈值藏：一个开了三天偶尔用的会话不该被藏，刚关掉一分钟的也不该还挂在上面。
    /// 「关掉」= 插件写了 `endedAt`，或者进程没了（`isOpen` 的反面）。文件一个不删，只是不摆在上面。
    /// `keep`：面板开着时上面那段里的会话中途关了，留在原处——不从你正看着的地方消失。
    static func sections(_ sessions: [SessionState], keep: Set<String>) -> (open: [SessionState], closed: [ClosedGroup]) {
        let open = sessions.filter { $0.isOpen || keep.contains($0.id) }
        let closed = sessions.filter { !$0.isOpen && !keep.contains($0.id) }
        let groups = Dictionary(grouping: closed) { $0.record.cwd ?? $0.workspace }.map { key, xs in
            let sorted = xs.sorted { closedAt($0) > closedAt($1) }
            return ClosedGroup(id: key, workspace: sorted[0].workspace, sessions: sorted, lastActive: closedAt(sorted[0]))
        }
        return (open, groups.sorted { $0.lastActive != $1.lastActive ? $0.lastActive > $1.lastActive : $0.id < $1.id })
    }

    /// 关掉的时刻：插件写下的 `endedAt`；没有（进程没了、没跑到 SessionEnd）就用最后一次动静。
    static func closedAt(_ s: SessionState) -> Date { s.record.endedAt ?? WillowStore.activity(s) }

    var body: some View {
        let entries = current.map { TurnLog.read(sessionId: $0.id, directory: store.directory) } ?? []
        let tl = current.flatMap { store.timeline(for: $0) }
        let running = current?.declaration == .inProgress ? tl?.startedAt : nil
        let status = ClaudeStatus.snapshot(tl?.progress, settingsModel: store.settingsModel)
        let par = FocusRule.parallel(store)
        let split = Self.sections(sessions, keep: keptOpen.union([focus].compactMap { $0 }))
        // 一个开着的都没有时，折叠起来左栏就只剩一行字——直接摊开。
        let closedShown = !split.closed.isEmpty && (showClosed || split.open.isEmpty)
        VStack(alignment: .leading, spacing: 0) {
            ears.reveal(0, shown, after: Self.revealAfter)
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader(title: L("会话", "Sessions"), value: L("\(par.running) 在跑 · \(par.idle) 空闲", "\(par.running) running · \(par.idle) idle"))
                    // 和图表放在一起，这一栏装得下 4 行（2026-09-17 实拍量过）；再多在段内滚动。
                    sessionList(split.open).frame(height: min(CGFloat(split.open.count) * 42, 168), alignment: .top)
                    if !split.closed.isEmpty {
                        closedToggle(split.closed, expanded: closedShown, fixed: split.open.isEmpty)
                    }
                    // 展开已关闭时，下半栏换成已关闭的列表：图表说的是选中的那个会话，挑会话的时候先让位。
                    if closedShown {
                        closedList(split.closed).frame(maxHeight: .infinity, alignment: .top)
                    } else {
                        SessionChart(entries: entries, runningSince: running)
                            .frame(maxHeight: .infinity)
                            .padding(.top, 4)
                    }
                }
                .frame(width: 204)
                .reveal(1, shown, after: Self.revealAfter)

                VStack(alignment: .leading, spacing: 6) {
                    SectionHeader(title: L("轮次", "Turns"), value: rangeNote(entries))
                    turnList(entries)
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .reveal(2, shown, after: Self.revealAfter)
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            statusStrip(entries, status)
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 16)
                .reveal(3, shown, after: Self.revealAfter)
        }
        .foregroundStyle(Ink.primary)
        .environment(\.colorScheme, .dark)
        .onAppear {
            DispatchQueue.main.async { shown = true }
            let closed = Self.sections(sessions, keep: []).closed.filter { $0.sessions.count > 1 }
            // 一个开着的都没有时右边显示的是已关闭的会话：打开时把它所在的组展开，不然左边找不到它（2026-09-17 实拍）。
            // 只在打开时展开一次，之后照样能收起。
            if !sessions.contains(where: \.isOpen), let id = current?.id,
               let g = closed.first(where: { $0.sessions.contains { $0.id == id } }) {
                openGroups.insert(g.id)
            }
            if Self.demoClosed, let g = closed.first { openGroups.insert(g.id) }
        }
    }

    // MARK: 刘海两侧

    private var ears: some View {
        HStack(spacing: 0) {
            HStack(spacing: 6) {
                Text(L("最近的轮次", "Recent turns")).font(.system(size: 12, weight: .semibold))
                DemoMark()
                Spacer(minLength: 0)
            }
            .padding(.leading, 16).padding(.trailing, 10)
            .frame(maxWidth: .infinity)

            Color.clear.frame(width: notchWidth)

            HStack(spacing: 6) {
                if let s = current {
                    Text(s.workspace)
                        .font(.system(size: 11)).foregroundStyle(Ink.tertiary)
                        .lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 4)
                if let onClose {
                    Button(action: onClose) {
                        Text(L("收起", "Close"))
                            .font(.system(size: 11, weight: .medium))
                            .padding(.horizontal, 10).padding(.vertical, 3)
                            .background(Color.white.opacity(0.12), in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.leading, 10).padding(.trailing, 16)
            .frame(maxWidth: .infinity)
        }
        .frame(height: notchHeight)
    }

    // MARK: 会话

    /// 同名工作区才显示会话号前四位——只在同一段里比，已关闭的同名会话不算。
    private func sessionList(_ list: [SessionState]) -> some View {
        let counts = Dictionary(list.map { ($0.workspace, 1) }, uniquingKeysWith: +)
        let dupes = Set(counts.filter { $0.value > 1 }.keys)
        return scrollable {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(list) { s in
                    let sub = !s.isOpen ? "\(s.workspace) · " + L("已关闭", "closed")
                        : s.record.updatedAt.map { "\(s.workspace) · \(Self.ago($0))" } ?? s.workspace
                    sessionRow(s, sub: sub, showsId: dupes.contains(s.workspace)) { keptOpen.insert(s.id) }
                }
            }
        }
    }

    /// 标题用标签——工作区名说的是「在哪」，不是「在做什么」。
    private func sessionRow(_ s: SessionState, sub: String, showsId: Bool, onPick: @escaping () -> Void = {}) -> some View {
        let selected = s.id == current?.id
        // 进行中的一轮：状态文件里还没有标签（整轮结束才写），实时读到的先用上。
        let title = store.progress(for: s)?.tag ?? s.tag ?? FocusRule.lastLoggedTag(s, store) ?? L("还没有标签", "No tag yet")
        return HStack(alignment: .center, spacing: 8) {
            Circle().fill(dotColor(s)).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(s.isStale ? Ink.tertiary : Ink.primary)
                    .lineLimit(1)
                Text(sub)
                    .font(.system(size: 10.5))
                    .foregroundStyle(Ink.tertiary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 0)
            if showsId {
                Text(String(s.id.prefix(4))).font(Ink.number(9.5)).foregroundStyle(Ink.tertiary)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(selected ? Color.white.opacity(0.1) : Color.clear))
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.snappy(duration: 0.2)) { picked = s.id; onPick() } }
    }

    // MARK: 已关闭

    /// `--present … --detail --detail-closed`：打开时已关闭已展开、第一个多会话的组也展开，拍展开态用。
    private static var demoClosed: Bool { PresentDemo.seconds != nil && CommandLine.arguments.contains("--detail-closed") }

    /// 固定在开着的那段下面，不跟着滚——开着的会话多到要滚动时，这一行也总看得见。
    /// `fixed`：一个开着的都没有，已关闭就是全部，不给收起。
    private func closedToggle(_ groups: [ClosedGroup], expanded: Bool, fixed: Bool) -> some View {
        let n = groups.reduce(0) { $0 + $1.sessions.count }
        return HStack(spacing: 6) {
            Text(L("已关闭", "Closed")).font(.system(size: 11, weight: .medium)).foregroundStyle(Ink.secondary)
            Text("\(n)").font(Ink.number(11)).foregroundStyle(Ink.tertiary)
            Spacer(minLength: 0)
            if !fixed {
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Ink.tertiary)
                    .rotationEffect(.degrees(expanded ? 180 : 0))
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 26)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Ink.fill))
        .contentShape(Rectangle())
        .onTapGesture {
            guard !fixed else { return }
            withAnimation(.snappy(duration: 0.25)) { showClosed.toggle() }
        }
    }

    /// 按工作区合并（用户 2026-09-17）。只有一个会话的工作区不再套一层，直接是会话行。
    private func closedList(_ groups: [ClosedGroup]) -> some View {
        scrollable {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(groups) { g in
                    if g.sessions.count == 1, let s = g.sessions.first {
                        sessionRow(s, sub: "\(g.workspace) · \(Self.ago(Self.closedAt(s)))", showsId: false)
                    } else {
                        groupRow(g)
                        if openGroups.contains(g.id) {
                            ForEach(g.sessions) { s in
                                sessionRow(s, sub: Self.ago(Self.closedAt(s)), showsId: true)
                                    .padding(.leading, 15)
                            }
                        }
                    }
                }
            }
        }
    }

    /// 箭头占圆点的位置，工作区名和会话行的标题对齐。
    private func groupRow(_ g: ClosedGroup) -> some View {
        let open = openGroups.contains(g.id)
        return HStack(alignment: .center, spacing: 8) {
            Image(systemName: "chevron.right")
                .font(.system(size: 8, weight: .semibold))
                .foregroundStyle(Ink.tertiary)
                .rotationEffect(.degrees(open ? 90 : 0))
                .frame(width: 7)
            VStack(alignment: .leading, spacing: 1) {
                Text(g.workspace)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Ink.tertiary)
                    .lineLimit(1).truncationMode(.middle)
                Text(L("\(g.sessions.count) 个会话 · \(Self.ago(g.lastActive))", "\(g.sessions.count) sessions · \(Self.ago(g.lastActive))"))
                    .font(.system(size: 10.5))
                    .foregroundStyle(Ink.tertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(.snappy(duration: 0.2)) {
                if open { openGroups.remove(g.id) } else { openGroups.insert(g.id) }
            }
        }
    }

    private func dotColor(_ s: SessionState) -> Color {
        if s.isStale { return Color.white.opacity(0.25) }
        if s.declaration == .unreadable { return .red }
        if store.progress(for: s)?.pendingChoice != nil { return ChoiceCard.accent }
        if s.declaration == .inProgress { return Color.white.opacity(0.7) }
        if s.flaggedByModel || s.declaration == .undeclared { return .orange }
        return seen.isUnread(s) ? .white : Color.white.opacity(0.35)
    }

    // MARK: 轮次

    private func rangeNote(_ entries: [TurnLogEntry]) -> String? {
        let times = entries.compactMap(\.at)
        guard let first = times.min(), let last = times.max() else { return nil }
        return "\(IslandExpandedContent.clock(first))–\(IslandExpandedContent.clock(last)) · " + L("\(entries.count) 轮", "\(entries.count) turns")
    }

    private func turnList(_ entries: [TurnLogEntry]) -> some View {
        let history = Array(entries.reversed())
        // 进行中的这一轮还没进日志（日志在整轮结束才写）——从状态里补一行，免得看起来像漏记。
        let live: SessionState? = {
            guard let s = current, s.declaration == .inProgress, let turn = s.record.turnId,
                  !entries.contains(where: { $0.turnId == turn }) else { return nil }
            return s
        }()
        return scrollable {
            VStack(alignment: .leading, spacing: 0) {
                if let s = live { liveRow(s) }
                if history.isEmpty && live == nil {
                    Text(L("这个会话还没有记录下来的轮次。", "No turns recorded for this session yet."))
                        .font(.system(size: 12)).foregroundStyle(Ink.tertiary).padding(.top, 6)
                }
                ForEach(history) { t in turnRow(t) }
            }
        }
    }

    private func liveRow(_ s: SessionState) -> some View {
        let p = store.progress(for: s)
        return VStack(alignment: .leading, spacing: 5) {
            rowHeader(time: s.record.updatedAt, tag: p?.tag ?? s.tag, badge: L("进行中", "Live"), expandable: false, open: true) {
                if let start = s.record.updatedAt { LiveClock(since: start, size: 11, opacity: 0.45) }
            }
            if s.record.isSystemMessage {
                line(L("要求", "Asked"), L("系统消息（\(PromptSource.describe(s.prompt))），不是你说的", "System message (\(PromptSource.describe(s.prompt))) — not from you"), Ink.tertiary, open: true)
            } else {
                line(L("要求", "Asked"), s.prompt ?? "—", Ink.primary, open: true)
            }
            if let d = p?.decode {
                line(L("理解", "Read"), d, d.hasPrefix("⚠") ? .orange : Ink.primary, open: true)
            } else {
                line(L("理解", "Read"), IslandExpandedContent.phase(p), Ink.tertiary, open: true)
            }
            if let tl = store.timeline(for: s) {
                VStack(alignment: .leading, spacing: 8) {
                    if let c = p?.pendingChoice { ChoiceCard(choice: c) }
                    TurnBar(timeline: tl, showsSentLabel: false, asked: current?.record.reminded != false)
                    if !tl.progress.steps.isEmpty { StepList(timeline: tl, limit: 3) }
                }
                .padding(.leading, Self.keyline)
                .padding(.top, 4)
            }
        }
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) { Rectangle().fill(Ink.separator).frame(height: Ink.hair) }
    }

    private func turnRow(_ t: TurnLogEntry) -> some View {
        let open = openRows.contains(t.id)
        let expandable = (t.prompt?.count ?? 0) > 36 || (t.decode?.count ?? 0) > 36
        return VStack(alignment: .leading, spacing: 4) {
            rowHeader(time: t.at, tag: t.tag, badge: t.interrupted == true ? L("被打断", "Interrupted") : nil,
                      expandable: expandable, open: open) {
                if let d = t.duration, d >= 1 {
                    Text(Self.duration(d)).font(Ink.number(11)).foregroundStyle(Ink.tertiary)
                }
            }
            if t.isSystemMessage {
                line(L("要求", "Asked"), L("系统消息（\(PromptSource.describe(t.prompt))），不是你说的", "System message (\(PromptSource.describe(t.prompt))) — not from you"), Ink.tertiary, open: open)
            } else {
                line(L("要求", "Asked"), t.prompt ?? "—", Ink.primary, open: open)
            }
            decodeLine(t, open: open)
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .onTapGesture {
            guard expandable else { return }
            withAnimation(.snappy(duration: 0.28)) {
                if open { openRows.remove(t.id) } else { openRows.insert(t.id) }
            }
        }
        .overlay(alignment: .bottom) { Rectangle().fill(Ink.separator).frame(height: Ink.hair) }
    }

    /// 每轮的标题行：时刻 · 标签 · 徽标 … 右侧用时（或走动的计时）· 展开箭头。
    private func rowHeader(time: Date?, tag: String?, badge: String?, expandable: Bool, open: Bool,
                           @ViewBuilder trailing: () -> some View) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            if let time {
                Text(time, format: .dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
                    .font(Ink.number(11)).foregroundStyle(Ink.tertiary)
                    .lineLimit(1)
                    .fixedSize()
                    .frame(width: Self.keyline - 4, alignment: .leading)
            }
            if let tag {
                Text(tag).font(.system(size: 12, weight: .semibold)).foregroundStyle(Ink.primary).lineLimit(1)
            }
            if let badge { Badge(text: badge) }
            Spacer(minLength: 6)
            trailing()
            if expandable {
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Ink.tertiary)
                    .rotationEffect(.degrees(open ? 180 : 0))
                    .padding(.leading, 4)
            }
        }
    }

    /// 「被打断」「问了没答」「没问」「不知道」必须是不同的话——合成一句「无声明」就是在制造沉默。
    @ViewBuilder
    private func decodeLine(_ t: TurnLogEntry, open: Bool) -> some View {
        if t.declared {
            line(L("理解", "Read"), t.decode ?? "", t.flaggedByModel ? .orange : Ink.primary, open: open)
        } else if t.interrupted == true {
            line(L("理解", "Read"), L("被打断，没来得及写", "Interrupted before one was written"), Ink.tertiary, open: open)
        } else if t.unverifiable {
            line(L("理解", "Read"), L("中途追加，无法核对", "Sent mid-turn — can’t verify"), Ink.tertiary, open: open)
        } else if t.reminded == true {
            line(L("理解", "Read"), L("问了，Claude 没写理解", "Asked, but Claude wrote no reading"), .orange, open: open)
        } else if t.reminded == false {
            line(L("理解", "Read"), L("这一轮没问（太短或是系统消息）", "Not asked (too short, or a system message)"), Ink.tertiary, open: open)
        } else {
            line(L("理解", "Read"), L("不知道这一轮问没问", "Unknown whether this turn was asked"), Ink.tertiary, open: open)
        }
    }

    private func line(_ label: String, _ text: String, _ color: Color, open: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(Ink.tertiary)
                .frame(width: Self.keyline - 8, alignment: .leading)
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(color)
                .lineLimit(open ? nil : 2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: 数据条

    /// 大面板里把 Claude Code 状态拆开写（iPhone Duo 在大屏上也拆回三个独立图标）。
    private func statusStrip(_ entries: [TurnLogEntry], _ status: ClaudeStatus.Snapshot?) -> some View {
        let asked = entries.filter { $0.reminded == true && $0.interrupted != true }
        let wrote = asked.filter(\.declared).count
        let longest = entries.compactMap(\.duration).max()
        return HStack(spacing: 0) {
            StatCell(label: status.map { L("上下文 · \(ClaudeStatus.compact($0.contextUsed))/\(ClaudeStatus.compact($0.window))", "Context · \(ClaudeStatus.compact($0.contextUsed))/\(ClaudeStatus.compact($0.window))") } ?? L("上下文", "Context"),
                     value: status.map { IslandExpandedContent.percent($0.usedFraction) } ?? "—",
                     tint: status.map { DuoGlyph.ringColor($0.remaining) } ?? Ink.tertiary) {
                if let status { ContextGauge(used: status.usedFraction) }
            }
            StatDivider()
            StatCell(label: L("缓存命中", "Cache hits"), value: status.map { IslandExpandedContent.percent($0.cacheHit) } ?? "—") {
                if let status { CacheDots(hit: status.cacheHit) }
            }
            StatDivider()
            StatCell(label: status.map { L("输出 · \($0.requests) 次请求", "Output · \($0.requests) req") } ?? L("本轮输出", "Output this turn"),
                     value: status.map { ClaudeStatus.compact($0.outputTokens) } ?? "—")
            StatDivider()
            StatCell(label: L("写了理解", "Readings written"), value: asked.isEmpty ? "—" : L("\(wrote)/\(asked.count) 轮", "\(wrote)/\(asked.count) turns"))
            StatDivider()
            StatCell(label: L("最长一轮", "Longest turn"), value: longest.map(Self.duration) ?? "—")
        }
        .fixedSize(horizontal: false, vertical: true)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Ink.fill))
    }

    // MARK: 小件

    /// ScrollView 在离屏渲染里不布局（整块消失），快照走等价的平铺。
    @ViewBuilder
    private func scrollable(@ViewBuilder _ content: () -> some View) -> some View {
        if Offscreen.isRendering { content() } else { ScrollView { content() }.scrollIndicators(.hidden) }
    }

    static func duration(_ d: TimeInterval) -> String {
        let s = Int(d.rounded())
        if s < 60 { return L("\(s) 秒", "\(s)s") }
        let m = s / 60, r = s % 60
        if m < 60 { return r == 0 ? L("\(m) 分", "\(m)m") : L("\(m) 分 \(r) 秒", "\(m)m \(r)s") }
        return L("\(m / 60) 小时 \(m % 60) 分", "\(m / 60)h \(m % 60)m")
    }

    static func ago(_ date: Date) -> String {
        let s = Int(Date().timeIntervalSince(date))
        if s < 60 { return L("刚刚", "just now") }
        if s < 3600 { return L("\(s / 60) 分钟前", "\(s / 60)m ago") }
        if s < 86400 { return L("\(s / 3600) 小时前", "\(s / 3600)h ago") }
        return L("\(s / 86400) 天前", "\(s / 86400)d ago")
    }
}

/// 这个会话最近各轮的时长，用 Swift Charts 画：每轮一根柱，对数纵轴（1 秒 / 1 分 / 1 时三条参考线），颜色是结果。
/// 按 HIG 的图表做法：上方一句能单独读懂的摘要（几轮、中位时长），图例贴着图、带计数。
struct SessionChart: View {
    let entries: [TurnLogEntry]      // 旧 → 新
    var runningSince: Date? = nil

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

    static func color(_ o: Outcome?) -> Color {
        switch o {
        case .declared: Color.white.opacity(0.85)
        case .flagged: .orange
        case .silent: Color(red: 1, green: 0.42, blue: 0.36)
        case .notAsked: Color.white.opacity(0.28)
        case .interrupted: Color.white.opacity(0.5)
        case .unverifiable: Color(red: 0.55, green: 0.62, blue: 0.72)   // 灰蓝：不是错，也不是没问
        case nil: Color.white.opacity(0.18)
        }
    }

    /// 对数纵轴从 1 秒到 1 小时；时长不知道的轮次画到 1 秒（最矮），不假装知道。
    static func seconds(_ d: TimeInterval?) -> Double { min(3600, max(1, d ?? 1)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(L("各轮时长", "Turn durations")).font(.system(size: 11, weight: .semibold)).foregroundStyle(Ink.secondary)
                Text(headline).font(Ink.number(10.5)).foregroundStyle(Ink.tertiary).lineLimit(1)
            }
            chart.frame(minHeight: 60, maxHeight: .infinity)
            legend
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Ink.fill))
    }

    private var headline: String {
        let ds = entries.compactMap(\.duration).sorted()
        if ds.isEmpty { return runningSince == nil ? L("还没有记录", "No records yet") : L("这一轮还在进行", "This turn is still running") }
        return L("\(entries.count) 轮 · 中位 \(DetailView.duration(ds[ds.count / 2])) · 对数纵轴", "\(entries.count) turns · median \(DetailView.duration(ds[ds.count / 2]))")
    }

    private var slots: Int { entries.count + (runningSince == nil ? 0 : 1) }

    private var chart: some View {
        TimelineView(.periodic(from: .now, by: runningSince == nil ? 60 : 1)) { ctx in
            let barWidth: CGFloat = slots > 12 ? 5 : 9
            Chart {
                ForEach(Array(entries.enumerated()), id: \.offset) { i, e in
                    BarMark(x: .value(L("轮", "Turn"), Double(i)),
                            yStart: .value(L("秒", "Seconds"), 1.0), yEnd: .value(L("秒", "Seconds"), Self.seconds(e.duration)),
                            width: .fixed(barWidth))
                        .foregroundStyle(Self.color(Self.outcome(e)))
                        .cornerRadius(2)
                }
                if let since = runningSince {
                    BarMark(x: .value(L("轮", "Turn"), Double(entries.count)),
                            yStart: .value(L("秒", "Seconds"), 1.0), yEnd: .value(L("秒", "Seconds"), Self.seconds(ctx.date.timeIntervalSince(since))),
                            width: .fixed(barWidth))
                        .foregroundStyle(Color.white.opacity(0.25))
                        .cornerRadius(2)
                }
            }
            .chartYScale(domain: 1...3600, type: .log)
            .chartXScale(domain: -0.6...(Double(max(slots, 8)) - 0.4))
            .chartXAxis(.hidden)
            .chartYAxis {
                AxisMarks(position: .trailing, values: [1.0, 60.0, 3600.0]) { v in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5)).foregroundStyle(Ink.separator)
                    AxisValueLabel {
                        if let d = v.as(Double.self) {
                            Text(d < 2 ? L("1秒", "1s") : (d < 100 ? L("1分", "1m") : L("1时", "1h")))
                                .font(.system(size: 9))
                                .foregroundStyle(Ink.tertiary)
                        }
                    }
                }
            }
        }
    }

    private var legend: some View {
        let counts = Dictionary(grouping: entries.compactMap(Self.outcome)) { $0 }.mapValues(\.count)
        let all = Outcome.allCases
        return Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 4) {
            ForEach(0..<((all.count + 1) / 2), id: \.self) { r in
                GridRow {
                    item(all[r * 2], counts)
                    if r * 2 + 1 < all.count {
                        item(all[r * 2 + 1], counts)
                    } else {
                        Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                    }
                }
            }
        }
    }

    private func item(_ o: Outcome, _ counts: [Outcome: Int]) -> some View {
        let n = counts[o] ?? 0
        return HStack(spacing: 5) {
            RoundedRectangle(cornerRadius: 1.5, style: .continuous).fill(Self.color(o)).frame(width: 7, height: 7)
            Text(Self.name(o)).font(.system(size: 10)).foregroundStyle(n > 0 ? Ink.secondary : Ink.tertiary).lineLimit(1).minimumScaleFactor(0.85)
            Spacer(minLength: 2)
            Text("\(n)").font(Ink.number(10, .semibold)).foregroundStyle(n > 0 ? Ink.primary : Ink.quaternary)
        }
    }
}
