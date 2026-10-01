import Foundation
import Observation

/// Reads `~/.claude/willow/*.json` and keeps the UI in step with it.
///
/// Read-only by construction: this type opens files and never writes one. If
/// the directory is missing it stays empty rather than creating it — the
/// plugin owns that directory, and a reader that creates it would make "the
/// plugin never ran" indistinguishable from "the plugin ran and found nothing".
/// 一轮的时间线：按回车的时刻、结束（或撤回）的时刻、读到的进度。刻度尺按它画。
struct TurnTimeline: Sendable, Equatable {
    var startedAt: Date
    /// nil = 还在进行。
    var endedAt: Date?
    var progress: TurnProgress
}

@MainActor
@Observable
final class WillowStore {
    private(set) var sessions: [SessionState] = []
    private(set) var lastScan: Date?
    private(set) var directoryExists = false

    let directory: URL
    /// 一轮刚开始时回调。
    ///
    /// 这是「哪个会话是你正在看的那个」唯一不用猜的判据：capture 写下记录，
    /// 意味着**有人刚按了回车**。后台代理跑完一轮不会触发它，所以不会出现
    /// 「你在 A 会话打字、面板弹出 B 的标签」。
    var onTurnStarted: ((SessionState) -> Void)?

    /// 每次扫描之后调用。灵动岛靠它在「有没有活动会话」变化时重新定宽。
    var onReload: (() -> Void)?

    /// 同一轮里，上一次扫描还没有声明、这一次有了——声明刚到达。
    /// 灵动岛在这一刻展开（用户选的方案）：一展开就有内容可读，而不是在按回车时空展开。
    var onDeclarationArrived: ((SessionState) -> Void)?
    private var lastDecoded: [String: (turn: String, decoded: Bool)] = [:]

    /// 实时读到的进行中这一轮，键是「会话|轮次」——换了一轮不串到新一轮上。
    /// 临时的：整轮结束后以插件在 Stop 写下的为准。
    private(set) var liveProgress: [String: TurnProgress] = [:]

    enum WithdrawKind: Sendable, Equatable { case interrupted, queued }
    struct Withdraw: Sendable, Equatable { let kind: WithdrawKind; let at: Date }
    /// 最近的撤回事件（按会话），只显示几秒，过期自动清掉。
    private(set) var recentWithdraw: [String: Withdraw] = [:]
    static let withdrawShown: TimeInterval = 2.5
    var onWithdraw: ((SessionState, WithdrawKind) -> Void)?

    func noteWithdraw(sessionId: String, kind: WithdrawKind) {
        let w = Withdraw(kind: kind, at: Date())
        recentWithdraw[sessionId] = w
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(Self.withdrawShown))
            guard let self, self.recentWithdraw[sessionId] == w else { return }
            self.recentWithdraw[sessionId] = nil
            self.onLiveChange?()
        }
    }

    /// 结束了的一轮留下的时间线（按会话）。只保留到这个会话开始下一轮。
    struct FinishedTurn: Sendable, Equatable { let turn: String; let timeline: TurnTimeline }
    private(set) var finished: [String: FinishedTurn] = [:]
    /// 进行中各轮按回车的时刻。插件在 Stop 时会把 updatedAt 改写成结束时刻，起点只能在进行中记下。
    private var liveStart: [String: Date] = [:]

    /// 一轮结束时上下文占了窗口的几成（lintel 数据条的走势线，分镜 53），按会话、旧 → 新。
    /// 只记这个进程看见之后结束的轮，不回扫聊天记录：几十 MB 的记录整读一遍不值得为一条小折线花。
    struct ContextPoint: Sendable, Equatable { let turn: String; var used: Double }
    private(set) var contextByTurn: [String: [ContextPoint]] = [:]

    private func noteContext(session: String, turn: String, _ p: TurnProgress) {
        guard let u = p.lastUsage, u.context > 0 else { return }
        let used = Double(u.context) / Double(ContextWindow.size(settingsModel: settingsModel, observed: u.context))
        var xs = contextByTurn[session] ?? []
        if let i = xs.firstIndex(where: { $0.turn == turn }) { xs[i].used = used } else { xs.append(ContextPoint(turn: turn, used: used)) }
        contextByTurn[session] = Array(xs.suffix(399))
    }

    /// 走势线的点：结束了的各轮，最后补上进行中这一轮的现值（那一轮还没记）。
    func contextSeries(for s: SessionState) -> [Double] {
        var out = (contextByTurn[s.id] ?? []).map(\.used)
        if let p = progress(for: s), let u = p.lastUsage, u.context > 0, (contextByTurn[s.id] ?? []).last?.turn != s.record.turnId {
            out.append(Double(u.context) / Double(ContextWindow.size(settingsModel: settingsModel, observed: u.context)))
        }
        return out
    }

    /// 这一轮的时间线：进行中（或刚撤回）用实时进度；结束了用结束时留下的那份。
    func timeline(for s: SessionState) -> TurnTimeline? {
        if let p = progress(for: s), let k = liveKey(s) {
            let start = liveStart[k] ?? s.record.updatedAt ?? p.firstWriteAt ?? Date()
            return TurnTimeline(startedAt: start, endedAt: p.interruptedAt, progress: p)
        }
        guard let f = finished[s.id], f.turn == s.record.turnId else { return nil }
        return f.timeline
    }

    private func liveKey(_ s: SessionState) -> String? { s.record.turnId.map { "\(s.id)|\($0)" } }

    private func attachLive(_ s: SessionState, now: Date) -> SessionState {
        let lp = liveKey(s).flatMap { liveProgress[$0] }
        return SessionState(record: s.record, now: now,
                            liveLastEvent: lp?.lastEventAt ?? s.liveLastEvent,
                            liveInterruptedAt: lp?.interruptedAt,
                            liveWaiting: lp?.pendingChoice != nil, transcriptWrittenAt: s.transcriptWrittenAt)
    }

    /// 活的在前；再按最近一次动静排序——状态文件的时间和实时读到的最后一次落盘，取较晚的。
    /// 只看状态文件时间时，正在跑的会话（状态文件一轮内不更新）会排到刚结束的会话后面。
    static func sort(_ xs: [SessionState]) -> [SessionState] {
        xs.sorted { a, b in
            if a.isStale != b.isStale { return !a.isStale }
            return activity(a) > activity(b)
        }
    }

    static func activity(_ s: SessionState) -> Date {
        [s.record.updatedAt, s.liveLastEvent, s.transcriptWrittenAt].compactMap { $0 }.max() ?? .distantPast
    }
    private let follower = TranscriptFollower()
    /// 已经触发过「声明到达」的轮次（会话|轮次）。实时读先到、Stop 后到，只展开一次。
    private var arrivedTurns: Set<String> = []
    private var liveTimer: Timer?
    /// 实时进度有实质变化（声明到了、多了一步、开始落盘）时回调——展开态据此重算高度。
    var onLiveChange: (() -> Void)?

    func progress(for s: SessionState) -> TurnProgress? {
        guard s.declaration == .inProgress || s.declaration == .interrupted, let k = liveKey(s) else { return nil }
        return liveProgress[k]
    }

    private var lastTurnIds: [String: String] = [:]
    private var watcher: DirectoryWatcher?
    private var poll: Timer?

    /// 设置里的模型（如 "opus[1m]"），决定上下文窗口按多大算。启动时读一次。
    let settingsModel: String? = ContextWindow.settingsModel()

    init(directory: URL = WillowStore.defaultDirectory) {
        self.directory = directory
    }

    nonisolated static var defaultDirectory: URL {
        if let override = ProcessInfo.processInfo.environment["WILLOW_STATE_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/willow", isDirectory: true)
    }

    func start() {
        reload()
        watcher = DirectoryWatcher(url: directory) { [weak self] in
            Task { @MainActor in self?.reload() }
        }
        watcher?.start()

        // FSEvents does not fire for a directory that does not exist yet, and the
        // plugin creates it on its first turn. A slow poll covers that gap and the
        // staleness clock, which changes with no file event at all.
        // 15 秒（K10 功耗，原 5 秒）：文件一变 FSEvents 立刻重载，轮询只管这两件慢事。
        let t = Timer(timeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
        t.tolerance = 2
        RunLoop.main.add(t, forMode: .common)
        poll = t

        // 进行中的轮次每秒读一次聊天记录。没有进行中的轮次时什么都不读。
        let lt = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.sessions.contains(where: { $0.declaration == .inProgress }) else { return }
                self.refreshLive()
            }
        }
        lt.tolerance = 0.3
        RunLoop.main.add(lt, forMode: .common)
        liveTimer = lt
    }

    func stop() {
        watcher?.stop()
        watcher = nil
        poll?.invalidate()
        poll = nil
        liveTimer?.invalidate()
        liveTimer = nil
    }

    func reload() {
        let now = Date()
        lastScan = now
        directoryExists = FileManager.default.fileExists(atPath: directory.path)

        guard directoryExists,
              let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path)
        else {
            sessions = []
            return
        }

        var found: [SessionState] = []
        for name in names where name.hasSuffix(".json") {
            let url = directory.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: url),
                  let record = try? JSONDecoder().decode(WillowRecord.self, from: data)
            else { continue }   // 半写入或旧格式：跳过，下一次扫描会看到完整的
            let lp = liveProgress["\(record.sessionId)|\(record.turnId ?? "")"]
            // 「在跑 / 空闲」按状态文件与聊天记录最后一次写入里较晚的算（用户 2026-09-13 定）。
            let written = record.transcriptPath.flatMap {
                (try? FileManager.default.attributesOfItem(atPath: $0))?[.modificationDate] as? Date
            }
            found.append(SessionState(record: record, now: now,
                                      liveLastEvent: lp?.lastEventAt, liveInterruptedAt: lp?.interruptedAt,
                                      transcriptWrittenAt: written))
        }

        // 先排一次、读实时进度，再把实时事件挂回去——陈旧判定与排序都要用到它。
        // 以前要等下一次扫描（5 秒后）才挂上：app 刚启动时，状态文件超过 10 分钟没更新的进行中轮次被误判过期。
        sessions = Self.sort(found)
        refreshLive()
        found = sessions.map { attachLive($0, now: now) }

        // 一轮刚开始 = turnId 变了、还没有解码、而且这一轮确实问了。
        var started: [SessionState] = []
        for s in found {
            guard let turn = s.record.turnId else { continue }
            let changed = lastTurnIds[s.id] != turn
            lastTurnIds[s.id] = turn
            if changed, s.record.decode == nil, s.record.reminded == true, !s.isStale {
                started.append(s)
            }
        }

        sessions = Self.sort(found)
        reconstructFinished()

        // 首次扫描不算「刚开始」——那只是 app 启动时看到的既有状态。
        if primed, let s = started.max(by: { ($0.record.updatedAt ?? .distantPast) < ($1.record.updatedAt ?? .distantPast) }) {
            onTurnStarted?(s)
        }

        var arrived: [SessionState] = []
        for s in found {
            guard let turn = s.record.turnId else { continue }
            let has = s.record.decode?.isEmpty == false
            if let had = lastDecoded[s.id], had.turn == turn, !had.decoded, has, !s.isStale,
               !arrivedTurns.contains("\(s.id)|\(turn)") {
                arrivedTurns.insert("\(s.id)|\(turn)")
                arrived.append(s)
            }
            lastDecoded[s.id] = (turn, has)
        }
        if primed, let s = arrived.max(by: { ($0.record.updatedAt ?? .distantPast) < ($1.record.updatedAt ?? .distantPast) }) {
            onDeclarationArrived?(s)
        }
        primed = true
        onReload?()
    }

    /// 已经补读过的轮次（会话|轮次），每一轮只补读一次。
    private var reconstructTried: Set<String> = []

    /// 结束的一轮如果灵动岛当时没开着（重启、重新编译后才打开），就没留下时间线：悬停面板少一整块「Claude 做了」、
    /// 数据条三格是「—」，同一块面板时有时无（用户 2026-09-13 报告悬停展开的面板有时显示不一致）。
    /// 开着的会话每一轮补读一次：从这一轮的偏移读到文件末尾，一次最多 4 MB。
    private func reconstructFinished() {
        for s in sessions where s.isOpen && s.declaration != .inProgress && s.declaration != .interrupted {
            guard let turn = s.record.turnId, finished[s.id]?.turn != turn else { continue }
            let key = "\(s.id)|\(turn)"
            guard !reconstructTried.contains(key), let path = s.record.transcriptPath,
                  let off = s.record.transcriptOffset else { continue }
            reconstructTried.insert(key)
            guard let p = TranscriptFollower().progress(key: key, path: path, offset: off) else { continue }
            let started = TurnLog.read(sessionId: s.id, directory: directory).last { $0.turnId == turn }?.at
            finished[s.id] = FinishedTurn(turn: turn, timeline: TurnTimeline(
                startedAt: started ?? p.firstWriteAt ?? s.record.updatedAt ?? Date(),
                endedAt: s.record.turnEndedAt ?? p.lastEventAt ?? Date(), progress: p))
            noteContext(session: s.id, turn: turn, p)
        }
    }

    /// 续接会话第一轮没有偏移时，按原话在聊天记录里找到这一轮的开头。找到就记住；
    /// 找不到隔 10 秒再试（文件可能还在抄历史），免得每秒都把几十 MB 读一遍。
    private var resolvedOffsets: [String: Int] = [:]
    private var resolveMisses: [String: Date] = [:]

    private func resolvedOffset(key: String, path: String, prompt: String?) -> Int? {
        if let o = resolvedOffsets[key] { return o }
        if let miss = resolveMisses[key], Date().timeIntervalSince(miss) < 10 { return nil }
        guard let prompt, let o = TranscriptTail.locateTurnStart(path: path, prompt: prompt) else {
            resolveMisses[key] = Date()
            return nil
        }
        resolvedOffsets[key] = o
        return o
    }

    /// 读进行中（以及刚被打断）各轮新增的聊天记录。只读不写。
    func refreshLive() {
        var next: [String: TurnProgress] = [:]
        var changed = false
        var interruptChanged = false
        var withdrawals: [(SessionState, WithdrawKind)] = []
        var choices: [SessionState] = []
        for s in sessions where s.declaration == .inProgress || s.declaration == .interrupted {
            guard let pid = s.record.pid, SessionState.processIsAlive(pid),
                  let path = s.record.transcriptPath, let key = liveKey(s),
                  let off = s.record.transcriptOffset ?? resolvedOffset(key: key, path: path, prompt: s.record.prompt)
            else { continue }
            guard let p = follower.progress(key: key, path: path, offset: off) else { continue }
            let old = liveProgress[key]
            if old?.decode != p.decode || old?.steps.count != p.steps.count
                || old?.firstWriteAt != p.firstWriteAt || old?.thinkingSeen != p.thinkingSeen
                || old?.pendingChoice != p.pendingChoice || old?.lastUsage != p.lastUsage { changed = true }
            if (old?.interruptedAt == nil) != (p.interruptedAt == nil) { interruptChanged = true }
            // 进入或离开「等你选择」也要立刻重建：它决定会话算不算过期。
            if (old?.pendingChoice == nil) != (p.pendingChoice == nil) { interruptChanged = true }
            next[key] = p
            if liveStart[key] == nil { liveStart[key] = s.record.updatedAt ?? p.firstWriteAt ?? Date() }
            if primed {                                             // 启动时已有的事件不闪
                if p.decode != nil, p.interruptedAt == nil, !arrivedTurns.contains(key) {
                    arrivedTurns.insert(key)
                    onDeclarationArrived?(s)
                }
                if p.interruptedAt != nil, old != nil, old?.interruptedAt == nil { withdrawals.append((s, .interrupted)) }
                if p.withdrawnQueued.count > (old?.withdrawnQueued.count ?? p.withdrawnQueued.count) {
                    withdrawals.append((s, .queued))
                }
                if let c = p.pendingChoice, !announcedChoices.contains(c.id) {
                    announcedChoices.insert(c.id)
                    choices.append(s)
                }
            } else {
                if p.decode != nil { arrivedTurns.insert(key) }
                if let c = p.pendingChoice { announcedChoices.insert(c.id) }
            }
        }
        if next.count != liveProgress.count { changed = true }
        // 一轮刚结束：留下它的时间线，展开态的刻度尺还要画这一轮。
        // 结束前最后不到一秒写下的行还没读到——趁跟读器还没忘掉这一轮，补读一次到文件末尾。
        for (key, old) in liveProgress where next[key] == nil {
            let parts = key.split(separator: "|", maxSplits: 1).map(String.init)
            guard parts.count == 2,
                  let s = sessions.first(where: { $0.id == parts[0] && $0.record.turnId == parts[1] }),
                  s.declaration != .inProgress, s.declaration != .interrupted else { continue }
            var p = old
            if let path = s.record.transcriptPath, let off = s.record.transcriptOffset ?? resolvedOffsets[key],
               let tail = follower.progress(key: key, path: path, offset: off) { p = tail }
            let start = liveStart[key] ?? p.firstWriteAt ?? s.record.updatedAt ?? Date()
            finished[s.id] = FinishedTurn(turn: parts[1], timeline: TurnTimeline(
                startedAt: start, endedAt: s.record.turnEndedAt ?? p.lastEventAt ?? Date(), progress: p))
            noteContext(session: parts[0], turn: parts[1], p)
            changed = true
        }
        finished = finished.filter { sid, f in sessions.contains { $0.id == sid && $0.record.turnId == f.turn } }
        contextByTurn = contextByTurn.filter { sid, _ in sessions.contains { $0.id == sid } }
        liveStart = liveStart.filter { next[$0.key] != nil }
        liveProgress = next
        follower.forget(keeping: Set(next.keys))
        let current = Set(sessions.compactMap(liveKey))
        arrivedTurns.formIntersection(current)
        resolvedOffsets = resolvedOffsets.filter { current.contains($0.key) }
        resolveMisses = resolveMisses.filter { current.contains($0.key) }

        // 打断要立刻反映到声明状态上，不等下一次 5 秒的整体扫描。
        if interruptChanged {
            let now = Date()
            sessions = Self.sort(sessions.map { s in
                let lp = liveKey(s).flatMap { next[$0] }
                return SessionState(record: s.record, now: now,
                                    liveLastEvent: lp?.lastEventAt ?? s.liveLastEvent,
                                    liveInterruptedAt: lp?.interruptedAt,
                                    liveWaiting: lp?.pendingChoice != nil, transcriptWrittenAt: s.transcriptWrittenAt)
            })
            changed = true
        }
        for (s, kind) in withdrawals {
            noteWithdraw(sessionId: s.id, kind: kind)
            let fresh = sessions.first { $0.id == s.id } ?? s
            onWithdraw?(fresh, kind)
            changed = true
        }
        for s in choices {
            onChoiceArrived?(sessions.first { $0.id == s.id } ?? s)
            changed = true
        }
        if changed { onLiveChange?() }
    }

    private var primed = false
    /// 已经为之展开过的选择题（tool_use id）。启动时就挂着的记为已宣布，不闪。
    private var announcedChoices: Set<String> = []
    /// 模型停下来等你选择时回调——和声明到达一样展开一次。
    var onChoiceArrived: ((SessionState) -> Void)?
}
