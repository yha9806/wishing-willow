import Testing
import Foundation
@testable import WishingWillow

/// 真实数据上屏幕抓到的（2026-09-12 20:46）：app 刚启动时，状态文件超过 10 分钟没更新的进行中轮次
/// 被误判过期；排序只看状态文件时间，正在跑的会话排在后面；声明到达时展开的是排第一的会话。
@MainActor
@Suite("会话排序、钉住与续接")
struct StoreOrderingTests {
    init() { Lang.current = .zh }

    private let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    private func makeDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("willow-order-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private func write(_ obj: [String: Any], _ url: URL) throws {
        try JSONSerialization.data(withJSONObject: obj).write(to: url)
    }

    /// 进行中、状态文件 20 分钟没动、但聊天记录 5 秒前还在写的会话；和一个 2 分钟前结束的会话。
    private func fixture() throws -> WillowStore {
        let d = try makeDir()
        let t = d.appendingPathComponent("live.transcript.jsonl")
        let prev = #"{"type":"assistant","timestamp":"2026-09-12T10:00:00.000Z","message":{"content":[{"type":"text","text":"上一轮。"}]}}"# + "\n"
        let now = Date()
        let live = "{\"type\":\"assistant\",\"timestamp\":\"\(iso.format(now.addingTimeInterval(-5)))\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Bash\",\"input\":{\"description\":\"Run tests\"}}]}}\n"
        try Data((prev + live).utf8).write(to: t)
        let pid = Int(ProcessInfo.processInfo.processIdentifier)
        try write(["schema": 9, "sessionId": "live", "pid": pid, "cwd": "/x/a", "turnId": "tx",
                   "updatedAt": iso.format(now.addingTimeInterval(-1200)), "prompt": "一句够长的请求",
                   "promptField": "prompt", "origin": "user", "reminded": true, "decode": NSNull(),
                   "turnEndedAt": NSNull(), "transcriptPath": t.path, "transcriptOffset": prev.utf8.count],
                  d.appendingPathComponent("live.json"))
        try write(["schema": 9, "sessionId": "done", "pid": pid, "cwd": "/x/b", "turnId": "ty",
                   "updatedAt": iso.format(now.addingTimeInterval(-120)), "prompt": "另一句请求",
                   "promptField": "prompt", "origin": "user", "reminded": true, "decode": "读成了", "tag": "某标签",
                   "turnEndedAt": iso.format(now.addingTimeInterval(-120))],
                  d.appendingPathComponent("done.json"))
        return WillowStore(directory: d)
    }

    @Test("第一次扫描就用上实时事件：长轮次不被误判过期，正在跑的会话排第一")
    func firstReload() throws {
        let store = try fixture()
        store.reload()
        #expect(store.sessions.first?.id == "live")
        #expect(store.sessions.first(where: { $0.id == "live" })?.isStale == false)
    }

    @Test("偏移为空（续接会话第一轮）也能实时读到这一轮")
    func nullOffset() throws {
        let d = try makeDir()
        let tr = d.appendingPathComponent("resumed.transcript.jsonl")
        let now = Date()
        let p = "你直接使用配音不行吗？"
        let rows = [
            "{\"type\":\"user\",\"timestamp\":\"2026-09-11T18:00:00.000Z\",\"message\":{\"content\":\"前一天的请求\"}}",
            "{\"type\":\"assistant\",\"timestamp\":\"2026-09-11T18:00:05.000Z\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"我读成了：前一天的旧声明\"}]}}",
            "{\"type\":\"user\",\"timestamp\":\"\(iso.format(now.addingTimeInterval(-20)))\",\"message\":{\"content\":\"\(p)\"}}",
            "{\"type\":\"assistant\",\"timestamp\":\"\(iso.format(now.addingTimeInterval(-3)))\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"我读成了：这一轮的声明\\n标签：找开源配音\"}]}}",
        ]
        try Data((rows.joined(separator: "\n") + "\n").utf8).write(to: tr)
        try write(["schema": 9, "sessionId": "resumed", "pid": Int(ProcessInfo.processInfo.processIdentifier),
                   "cwd": "/x/c", "turnId": "tr", "updatedAt": iso.format(now.addingTimeInterval(-20)),
                   "prompt": p, "promptField": "prompt", "origin": "user", "reminded": true,
                   "decode": NSNull(), "turnEndedAt": NSNull(), "transcriptPath": tr.path],
                  d.appendingPathComponent("resumed.json"))
        let store = WillowStore(directory: d)
        store.reload()
        let s = store.sessions.first { $0.id == "resumed" }
        #expect(s.flatMap { store.progress(for: $0) }?.decode == "这一轮的声明")
    }
}
