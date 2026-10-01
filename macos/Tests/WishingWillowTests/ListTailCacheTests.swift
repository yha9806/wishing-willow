import Testing
import Foundation
@testable import WishingWillow

/// K10 功耗：清单文件只读尾部、按「大小 + 修改时间」缓存。读出来的必须和整份读一模一样，文件一长就要重读。
@Suite("清单与轮次日志：只读尾部、文件变了才重读")
struct ListTailCacheTests {
    private func file(_ lines: [String]) throws -> (URL, String) {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("willow-tail-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        let url = d.appendingPathComponent("s.list.jsonl")
        try (lines.joined(separator: "\n") + "\n").write(to: url, atomically: false, encoding: .utf8)
        return (d, "s")
    }

    private func snapshot(_ turn: Int, pad: Int) -> String {
        let items: [[String: Any]] = [["id": "L1", "text": "第 \(turn) 轮的事" + String(repeating: "长", count: pad), "status": "在做"]]
        let obj: [String: Any] = ["turnIndex": turn, "turnId": "t\(turn)", "items": items, "changes": ["改了 \(turn)"]]
        return String(decoding: try! JSONSerialization.data(withJSONObject: obj), as: UTF8.self)
    }

    @Test("行比读尾的块还长：最后两份照样读全，和整份读一样")
    func longLinesReadWhole() throws {
        let (d, sid) = try file((1...6).map { snapshot($0, pad: 3000) })
        let old = ConversationList.tailChunk
        ConversationList.tailChunk = 1024
        defer { ConversationList.tailChunk = old }
        guard case .snapshot(let last) = ConversationList.read(sessionId: sid, directory: d) else {
            Issue.record("最后一份没读出来"); return
        }
        #expect(last.turnIndex == 6)
        #expect(last.items.first?.text.hasSuffix(String(repeating: "长", count: 3000)) == true)
        #expect(ConversationList.previous(sessionId: sid, directory: d)?.turnIndex == 5)
    }

    @Test("文件追加了一份：下一次读到的是新的那份")
    func appendIsSeen() throws {
        let (d, sid) = try file([snapshot(1, pad: 10), snapshot(2, pad: 10)])
        guard case .snapshot(let a) = ConversationList.read(sessionId: sid, directory: d) else { Issue.record("没读出"); return }
        #expect(a.turnIndex == 2)
        let h = try FileHandle(forWritingTo: d.appendingPathComponent("s.list.jsonl"))
        try h.seekToEnd()
        try h.write(contentsOf: Data((snapshot(3, pad: 10) + "\n").utf8))
        try h.close()
        guard case .snapshot(let b) = ConversationList.read(sessionId: sid, directory: d) else { Issue.record("没读出"); return }
        #expect(b.turnIndex == 3)
        #expect(ConversationList.previous(sessionId: sid, directory: d)?.turnIndex == 2)
    }

    @Test("只有一份、最后一行坏了、文件不在：和以前一样")
    func edgeCases() throws {
        let (d1, s1) = try file([snapshot(1, pad: 10)])
        guard case .snapshot(let one) = ConversationList.read(sessionId: s1, directory: d1) else { Issue.record("没读出"); return }
        #expect(one.turnIndex == 1)
        #expect(ConversationList.previous(sessionId: s1, directory: d1) == nil)
        let (d2, s2) = try file([snapshot(1, pad: 10), "{坏行"])
        if case .unreadable = ConversationList.read(sessionId: s2, directory: d2) {} else { Issue.record("最后一行坏了应当读不出") }
        if case .none = ConversationList.read(sessionId: "没有这个", directory: d2) {} else { Issue.record("文件不在应当是 none") }
    }

    @Test("轮次日志：文件长了就重读")
    func turnLogSeesAppend() throws {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("willow-log-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        let url = d.appendingPathComponent("s.log.jsonl")
        try "{\"turnId\":\"t1\"}\n".write(to: url, atomically: false, encoding: .utf8)
        #expect(TurnLog.read(sessionId: "s", directory: d).map(\.turnId) == ["t1"])
        let h = try FileHandle(forWritingTo: url)
        try h.seekToEnd()
        try h.write(contentsOf: Data("{\"turnId\":\"t2\"}\n".utf8))
        try h.close()
        #expect(TurnLog.read(sessionId: "s", directory: d).map(\.turnId) == ["t1", "t2"])
    }
}
