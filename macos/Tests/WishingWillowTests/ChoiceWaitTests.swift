import Testing
import Foundation
@testable import WishingWillow

/// 模型停下来等你做选择（AskUserQuestion 选择题、ExitPlanMode 批准计划）。
///
/// 2026-09-12 盘点本机聊天记录：89 次提问到回答，中位 88 秒、p90 382 秒、最长 1,357 秒。
/// 这段时间里模型什么都不写，灵动岛若只会说「回答中」，你就不知道该回去了；
/// 而且超过 10 分钟没有落盘，会话会被误判过期、从灵动岛上消失。
/// 问题与回答靠 tool_use 的 id 和回答里的 tool_use_id 对上（89/89 对）。
@MainActor
@Suite("等你选择")
struct ChoiceWaitTests {
    init() { Lang.current = .zh }

    private static let ask = #"{"type":"assistant","timestamp":"2026-09-12T10:00:05.000Z","message":{"content":[{"type":"tool_use","id":"toolu_q1","name":"AskUserQuestion","input":{"questions":[{"question":"用哪种方案？","header":"方案","multiSelect":false,"options":[{"label":"A 方案","description":"x"},{"label":"B 方案","description":"y"}]},{"question":"第二题","header":"范围","multiSelect":true,"options":[{"label":"甲","description":""}]}]}}]}}"#
    private static let otherResult = #"{"type":"user","timestamp":"2026-09-12T10:00:06.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_other","content":"ok"}]}}"#
    private static let answer = #"{"type":"user","timestamp":"2026-09-12T10:01:30.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_q1","content":"User has answered your questions"}]}}"#
    private static let plan = #"{"type":"assistant","timestamp":"2026-09-12T10:02:00.000Z","message":{"content":[{"type":"tool_use","id":"toolu_p1","name":"ExitPlanMode","input":{"plan":"\n# 改灵动岛\n\n1. 先写测试","planFilePath":"/x/plan.md"}}]}}"#
    private static let interrupt = #"{"type":"user","timestamp":"2026-09-12T10:03:00.000Z","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}"#

    private func ingest(_ p: inout TurnProgress, _ row: String) {
        p.ingest(try! JSONSerialization.jsonObject(with: Data(row.utf8)) as! [String: Any])
    }

    @Test("选择题挂起→记下第一题的标题、题面、选项与题数；别的工具结果不解除；对上 id 的回答解除；批准计划同理；打断也解除")
    func pendingChoice() {
        var p = TurnProgress()
        ingest(&p, Self.ask)
        let c = p.pendingChoice
        #expect(c?.kind == .question)
        #expect(c?.header == "方案")
        #expect(c?.question == "用哪种方案？")
        #expect(c?.options == ["A 方案", "B 方案"])
        #expect(c?.count == 2)
        #expect(c?.at == WillowRecord.parseISO8601("2026-09-12T10:00:05.000Z"))

        ingest(&p, Self.otherResult)
        #expect(p.pendingChoice != nil)
        ingest(&p, Self.answer)
        #expect(p.pendingChoice == nil)

        ingest(&p, Self.plan)
        #expect(p.pendingChoice?.kind == .plan)
        #expect(p.pendingChoice?.question == "改灵动岛")
        ingest(&p, Self.interrupt)
        #expect(p.pendingChoice == nil)
        #expect(p.interruptedAt != nil)
    }

    @Test("等你选择的会话：超过 10 分钟没落盘也不算过期；看过了照样显示；排在没看过的新声明前面；胶囊显示等你选")
    func waitingSession() throws {
        let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("willow-choice-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        let now = Date()
        let t = d.appendingPathComponent("wait.transcript.jsonl")
        let prev = #"{"type":"assistant","timestamp":"2026-09-12T09:00:00.000Z","message":{"content":[{"type":"text","text":"上一轮。"}]}}"# + "\n"
        let askNow = Self.ask.replacingOccurrences(of: "2026-09-12T10:00:05.000Z", with: iso.format(now.addingTimeInterval(-900)))
        try Data((prev + askNow + "\n").utf8).write(to: t)
        let pid = Int(ProcessInfo.processInfo.processIdentifier)
        func write(_ obj: [String: Any], _ name: String) throws {
            try JSONSerialization.data(withJSONObject: obj).write(to: d.appendingPathComponent(name))
        }
        try write(["schema": 9, "sessionId": "wait", "pid": pid, "cwd": "/x/a", "turnId": "tw",
                   "updatedAt": iso.format(now.addingTimeInterval(-960)), "prompt": "一句够长的请求",
                   "promptField": "prompt", "origin": "user", "reminded": true, "decode": NSNull(),
                   "turnEndedAt": NSNull(), "transcriptPath": t.path, "transcriptOffset": prev.utf8.count], "wait.json")
        try write(["schema": 9, "sessionId": "fresh", "pid": pid, "cwd": "/x/b", "turnId": "tf",
                   "updatedAt": iso.format(now.addingTimeInterval(-5)), "prompt": "另一句请求",
                   "promptField": "prompt", "origin": "user", "reminded": true, "decode": "读成了", "tag": "新标签",
                   "turnEndedAt": iso.format(now.addingTimeInterval(-5))], "fresh.json")

        let store = WillowStore(directory: d)
        store.reload()
        let seen = SeenStore(ephemeral: true)
        let w = try #require(store.sessions.first { $0.id == "wait" })
        #expect(w.isStale == false)
        #expect(store.progress(for: w)?.pendingChoice?.kind == .question)

        seen.markSeen(sessionId: "wait", turnId: "tw")
        #expect(FocusRule.label(w, seen, store)?.text == "等你选择")
        // 等你选择排在没看过的新声明前面：来源这边体现为 rank = waiting，排序本身在 lintel（Ordering.focus）。
        #expect(ActivityExport.rank(w, store) == "waiting")
        #expect(ActivityExport.rank(try #require(store.sessions.first { $0.id == "fresh" }), store) == "none")
        if case .choice = FocusRule.pill(w, seen, store) {} else {
            Issue.record("pill → \(String(describing: FocusRule.pill(w, seen, store)))")
        }
    }
}
