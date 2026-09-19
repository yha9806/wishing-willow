import Testing
import Foundation
@testable import WishingWillow

/// 用户 2026-09-13 定的两处修正，加菜单栏让路。
/// ① 中途追加：你在 Claude 干活时发的消息，Claude Code 在同一轮里交给 Claude；之后写的理解夹在工具调用之间，
///    桌面端聊天记录不存——找不到不等于没写 → 灰色「无法核对」，不是橙色「没写声明」。排队消息被送达也不再算撤回。
/// ② 在跑判定：状态文件之外，也看聊天记录最后一次写入。
/// （原 ③ 菜单栏让路、胶囊顶边对齐、点开面板显示谁：画刘海的部分 2026-09-19 随界面移除，测试已移植到 lintel `MechanicsTests`。）
@MainActor
@Suite("中途追加与在跑判定")
struct MidTurnAndDodgeTests {
    init() { Lang.current = .zh }

    private let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    private func dir() throws -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("willow-midturn-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private func record(_ extra: [String: Any], id: String, ago: TimeInterval = 20) -> [String: Any] {
        var obj: [String: Any] = ["schema": 10, "sessionId": id, "pid": Int(ProcessInfo.processInfo.processIdentifier),
                                  "cwd": "/x/\(id)", "turnId": "t-\(id)",
                                  "updatedAt": iso.format(Date().addingTimeInterval(-ago)),
                                  "prompt": "提交吧，然后 README 改用收起态直接点开录素材。", "promptField": "prompt",
                                  "origin": "user", "reminded": true, "decode": NSNull(), "tag": NSNull(),
                                  "turnEndedAt": iso.format(Date().addingTimeInterval(-ago)), "midTurn": false]
        obj.merge(extra) { $1 }
        return obj
    }

    private func write(_ obj: [String: Any], _ name: String, in d: URL) throws {
        try JSONSerialization.data(withJSONObject: obj).write(to: d.appendingPathComponent(name))
    }

    @Test("中途追加的一轮找不到理解 → 无法核对（灰、沿用态）；不是中途追加的照旧是没写声明")
    func unverifiable() throws {
        let d = try dir()
        try write(record(["midTurn": true], id: "mid"), "mid.json", in: d)
        try write(record([:], id: "plain"), "plain.json", in: d)
        let store = WillowStore(directory: d)
        store.reload()
        let seen = SeenStore(ephemeral: true)
        let mid = try #require(store.sessions.first { $0.id == "mid" })
        let plain = try #require(store.sessions.first { $0.id == "plain" })
        #expect(mid.declaration == .unverifiable)
        #expect(plain.declaration == .undeclared)
        let label = try #require(FocusRule.label(mid, seen, store))
        #expect(label.text == "无法核对")
        #expect(label.carried == true)
        #expect(StatusCenter.of(mid, progress: nil, withdrawn: false) == .idle)
        #expect(FocusRule.pill(mid, seen, store) == nil)
        #expect(FocusRule.pill(plain, seen, store) == .silent)
    }

    @Test("轮次日志：中途追加或被接走、又没有理解 → 无法核对；有理解照常；真打断仍是被打断；普通的没写仍是没写")
    func logOutcome() throws {
        func entry(_ json: String) throws -> TurnLogEntry {
            try JSONDecoder().decode(TurnLogEntry.self, from: Data(json.utf8))
        }
        let superseded = try entry(#"{"prompt":"修面板截断","reminded":true,"decode":null,"interrupted":false,"supersededAt":"2026-09-13T10:57:44.000Z","midTurn":false}"#)
        let midTurn = try entry(#"{"prompt":"提交吧","reminded":true,"decode":null,"interrupted":false,"supersededAt":null,"midTurn":true}"#)
        let midDeclared = try entry(#"{"prompt":"提交吧","reminded":true,"decode":"提交并推送","interrupted":false,"midTurn":true}"#)
        let interrupted = try entry(#"{"prompt":"修面板截断","reminded":true,"decode":null,"interrupted":true}"#)
        let silent = try entry(#"{"prompt":"修面板截断","reminded":true,"decode":null,"interrupted":false}"#)
        #expect(SessionChart.outcome(superseded) == .unverifiable)
        #expect(SessionChart.outcome(midTurn) == .unverifiable)
        #expect(SessionChart.outcome(midDeclared) == .declared)
        #expect(SessionChart.outcome(interrupted) == .interrupted)
        #expect(SessionChart.outcome(silent) == .silent)
    }

    @Test("排队消息被送达（先有 queued_command 附件）不算撤回；只有 remove 的才是撤回")
    func queuedDelivery() throws {
        var p = TurnProgress()
        let rows = [
            #"{"type":"queue-operation","operation":"enqueue","timestamp":"2026-09-13T10:57:11.303Z","content":"提交吧"}"#,
            #"{"type":"attachment","timestamp":"2026-09-13T10:57:11.303Z","attachment":{"type":"queued_command","prompt":"提交吧","commandMode":"prompt"}}"#,
            #"{"type":"queue-operation","operation":"remove","timestamp":"2026-09-13T10:57:44.926Z","content":"提交吧"}"#,
            #"{"type":"queue-operation","operation":"enqueue","timestamp":"2026-09-13T10:58:00.000Z","content":"算了不用了"}"#,
            #"{"type":"queue-operation","operation":"remove","timestamp":"2026-09-13T10:58:03.000Z","content":"算了不用了"}"#,
        ]
        for r in rows {
            let obj = try JSONSerialization.jsonObject(with: Data(r.utf8)) as? [String: Any]
            p.ingest(obj ?? [:])
        }
        #expect(p.withdrawnQueued == ["算了不用了"])
    }

    @Test("岛上显示谁：状态文件 20 分钟没更新、聊天记录刚写过 → 还显示；聊天记录也 20 分钟没动 → 不显示。这一轮已结束，两次都算空闲、不算在跑")
    func transcriptActivity() throws {
        let d = try dir()
        let t = d.appendingPathComponent("busy.transcript.jsonl")
        try Data("{}\n".utf8).write(to: t)
        try write(record(["transcriptPath": t.path, "decode": "读成了", "tag": "剧本审阅"], id: "busy", ago: 1200), "busy.json", in: d)
        let store = WillowStore(directory: d)
        store.reload()
        #expect(FocusRule.live(store).count == 1)
        #expect(FocusRule.parallel(store).running == 0)
        #expect(FocusRule.parallel(store).idle == 1)

        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-1200)], ofItemAtPath: t.path)
        store.reload()
        #expect(FocusRule.live(store).isEmpty)
        #expect(FocusRule.parallel(store).running == 0)
        #expect(FocusRule.parallel(store).idle == 1)
    }

    @Test("主动弹出的精简版只放两行：要求一行、理解最多两行；标 ⚠ 用橙色；原话换行压成空格；还没写出就说还没写出")
    func compactFlashLines() throws {
        let d = try dir()
        try write(record(["prompt": "把目录下的脚本\n都过一遍", "decode": "⚠ 先改代码再说", "tag": "改脚本"], id: "flag"), "flag.json", in: d)
        try write(record(["decode": NSNull(), "turnEndedAt": NSNull()], id: "open"), "open.json", in: d)
        let store = WillowStore(directory: d)
        store.reload()
        let flag = try #require(store.sessions.first { $0.id == "flag" })
        let lines = IslandExpandedContent.compactLines(flag, store: store)
        #expect(lines.count == 2)
        #expect(lines[0] == .init(label: "要求", text: "把目录下的脚本 都过一遍", tone: .secondary, lines: 1))
        #expect(lines[1] == .init(label: "理解", text: "⚠ 先改代码再说", tone: .warning, lines: 2))
        let open = try #require(store.sessions.first { $0.id == "open" })
        let openLines = IslandExpandedContent.compactLines(open, store: store)
        #expect(openLines.count == 2)
        #expect(openLines[1].text == "还没写出")
    }

    @Test("悬停翻页：底部那一行按在跑顺序循环到下一个会话，全都看过、胶囊规则挑不出第二个时也翻得到，三次走遍再回到开头；只有一个会话时没有这一行")
    func flipThrough() throws {
        let d = try dir()
        for (id, ago) in [("a", 10.0), ("b", 20.0), ("c", 30.0)] {
            try write(record(["decode": "读成了", "tag": "标签\(id)"], id: id, ago: ago), "\(id).json", in: d)
        }
        let store = WillowStore(directory: d)
        store.reload()
        let seen = SeenStore(ephemeral: true)
        for s in store.sessions { seen.markSeen(s) }
        let l = FocusRule.live(store)
        #expect(l.count == 3)
        #expect(FocusRule.secondary(store, seen, primary: l[0]) == nil)
        var visited = [l[0].id]
        var cur = l[0]
        for _ in 0..<3 {
            let next = try #require(FocusRule.flipTarget(store, after: cur))
            visited.append(next.id)
            cur = next
        }
        #expect(Set(visited.prefix(3)) == Set(l.map(\.id)))
        #expect(visited.last == l[0].id)

        let one = try dir()
        try write(record(["decode": "读成了"], id: "solo"), "solo.json", in: one)
        let single = WillowStore(directory: one)
        single.reload()
        #expect(FocusRule.flipTarget(single, after: single.sessions.first) == nil)
    }

    @Test("悬停面板一致：灵动岛没开着时结束的一轮，打开后从聊天记录补出时间线；开着又没问的一轮算进行中（结束后才是没问）")
    func reconstructAndOpenTurn() throws {
        let d = try dir()
        let t = d.appendingPathComponent("done.transcript.jsonl")
        let rows = [
            #"{"type":"assistant","timestamp":"2026-09-13T13:00:05.000Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls","description":"Check state files"}}]}}"#,
            #"{"type":"assistant","timestamp":"2026-09-13T13:00:06.000Z","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/a/b/extract.mjs"}}]}}"#,
        ]
        try Data((rows.joined(separator: "\n") + "\n").utf8).write(to: t)
        try write(record(["transcriptPath": t.path, "transcriptOffset": 0, "decode": "读成了", "tag": "查状态"], id: "done"), "done.json", in: d)
        try write(record(["reminded": false, "decode": NSNull(), "turnEndedAt": NSNull()], id: "cont"), "cont.json", in: d)
        let store = WillowStore(directory: d)
        store.reload()
        let done = try #require(store.sessions.first { $0.id == "done" })
        let tl = try #require(store.timeline(for: done))
        #expect(tl.progress.steps.count == 2)
        let cont = try #require(store.sessions.first { $0.id == "cont" })
        #expect(cont.declaration == .inProgress)
        #expect(cont.isRunning)
        #expect(IslandExpandedContent.oneLine("推送到 GitHub 吧 接下来的问题：\n\n1. 动画") == "推送到 GitHub 吧 接下来的问题： 1. 动画")
        // 没问理解的一轮：进度条整条是中性的「这一轮」，不画紫色「写出理解前」
        let t0 = Date(timeIntervalSince1970: 1_789_300_000)
        let quiet = TurnTimeline(startedAt: t0, endedAt: t0.addingTimeInterval(6), progress: TurnProgress())
        #expect(TurnBar.segments(quiet, now: t0.addingTimeInterval(6), asked: false) == [.init(kind: .turn, from: 0, to: 1)])
        #expect(TurnBar.segments(quiet, now: t0.addingTimeInterval(6)) == [.init(kind: .before, from: 0, to: 1)])
        #expect(TurnBar.name(.turn) == "这一轮")
    }

    @Test("第四行「我补上的」插在理解和标签之间：理解与标签照样读得到，补上的那行不会被当成理解")
    func fillLineParsing() {
        let msg = "你批准的：查一下有没有相关论文\n我读成了：逐项检索有没有撞车\n我补上的：「相关 paper」定为撞车与经典先例；没查会刊收不收\n标签：查撞车文献\n\n正文从这里开始"
        let hit = TranscriptTail.scanMessage(msg)
        #expect(hit?.decode == "逐项检索有没有撞车")
        #expect(hit?.tag == "查撞车文献")
    }
}
