import Testing
import Foundation
@testable import WishingWillow

/// 整场对话的长清单上面板（ops-private spec 2026-09-24 对话层 V1–V6；lintel 分镜 ⑦④ ⑦⑦ ⑦⑨）。
/// 插件每轮有变化就往 `<会话>.list.jsonl` 追加一份快照；这里只读最后一份，导出成 lintel 活动的 `chain`。
/// 字由这边写好（分组名、右栏的注），lintel 只排版。
@MainActor
@Suite("导出：对话的长清单")
struct ConversationListTests {
    init() { Lang.current = .zh }

    private let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    /// ended：这一轮已经结束、理解写了——右翼是标签，看过就缩回（`labelUntilSeen`）。
    private func dir(ended: Bool = false) throws -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("willow-list-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        let obj: [String: Any] = ["schema": 12, "sessionId": "s", "pid": Int(ProcessInfo.processInfo.processIdentifier),
                                  "cwd": "/x/w", "turnId": "t9", "turnIndex": 9,
                                  "updatedAt": iso.format(Date()), "prompt": "一句够长的请求", "promptField": "prompt",
                                  "origin": "user", "reminded": true,
                                  "decode": ended ? "把三个配置文件对一遍" : NSNull(), "tag": ended ? "核对配置" : NSNull(),
                                  "turnEndedAt": ended ? iso.format(Date()) : NSNull()]
        try JSONSerialization.data(withJSONObject: obj).write(to: d.appendingPathComponent("s.json"))
        return d
    }

    private func item(_ id: String, _ text: String, _ status: String, wait: String? = nil, basis: String = "预测",
                      touched: Int = 8, evidence: String? = nil, approved: Bool = false) -> [String: Any] {
        var x: [String: Any] = ["id": id, "text": text, "status": status, "wait": wait ?? NSNull(), "basis": basis,
                                "sourceTurn": "t1", "since": 1, "touched": touched]
        if let evidence { x["evidence"] = evidence }
        if approved { x["approvedTurn"] = "t5" }
        return x
    }

    private func writeList(_ d: URL, _ snaps: [[String: Any]]) throws {
        let text = try snaps.map { String(data: try JSONSerialization.data(withJSONObject: $0), encoding: .utf8)! }
            .joined(separator: "\n") + "\n"
        try text.write(to: d.appendingPathComponent("s.list.jsonl"), atomically: true, encoding: .utf8)
    }

    private func chain(_ d: URL) -> [String: Any]? {
        let s = WillowStore(directory: d)
        s.reload()
        return ActivityExport.activities(s)["s"]?["chain"] as? [String: Any]
    }

    @Test("最后一份快照：每项带状态、显示的字、右栏的注；撤掉的不出现；预测标「模型说的」")
    func lastSnapshot() throws {
        let d = try dir()
        try writeList(d, [
            ["turnIndex": 3, "items": [item("L1", "旧快照里的事", "在做")], "changes": [], "problems": []],
            ["turnIndex": 8, "items": [
                item("L1", "合并 PR", "做完", evidence: "main 8d68286"),
                item("L2", "重画分镜", "在做", touched: 2),
                item("L3", "装新版", "等你", basis: "ops 9cdaa73", approved: true),
                item("L4", "核对 A4", "等", wait: "IPM 下一条消息"),
                item("L5", "稿件的环", "以后"),
                item("L6", "旧想法", "撤掉"),
            ], "changes": ["新增 L5"], "problems": ["L9 不存在"]],
        ])
        let c = try #require(chain(d))
        let items = try #require(c["items"] as? [[String: Any]])
        #expect(items.map { $0["id"] as? String } == ["L1", "L2", "L3", "L4", "L5"])
        #expect(items.map { $0["state"] as? String } == ["done", "doing", "you", "other", "later"])
        #expect(items[0]["note"] as? String == "main 8d68286")
        #expect(items[1]["note"] as? String == "模型说的")
        #expect(items[1]["idle"] as? Int == 7, "在做 7 轮没动（当前第 9 轮、上次动在第 2 轮）")
        #expect(items[2]["note"] as? String == "ops 9cdaa73")
        #expect(items[2]["approved"] as? Bool == true)
        #expect(items[3]["text"] as? String == "核对 A4 · 等 IPM 下一条消息")
        #expect(c["problems"] as? [String] == ["L9 不存在"])
        let labels = try #require(c["labels"] as? [String: String])
        #expect(labels["you"] == "等你" && labels["other"] == "等别的" && labels["later"] == "以后")
    }

    @Test("有等你的事：「等你 N」常驻——看过就缩回的标签看过后换成它，没有标签就直接是它")
    func waitingStays() throws {
        let d = try dir(ended: true)
        try writeList(d, [["turnIndex": 8, "items": [item("L1", "装新版", "等你"), item("L2", "看 spec", "等你"),
                                                      item("L3", "合并", "做完", evidence: "abc")], "changes": [], "problems": []]])
        let s = WillowStore(directory: d)
        s.reload()
        let a = try #require(ActivityExport.activities(s)["s"])
        let label = a["label"] as? [String: Any]
        let seen = a["labelSeen"] as? [String: Any]
        let staysAfterSeen = label != nil && (a["labelUntilSeen"] as? Bool) == false
        let becomesWaiting = (seen?["text"] as? String) == "等你" && (seen?["count"] as? Int) == 2
        let isWaiting = (label?["text"] as? String) == "等你" && (label?["count"] as? Int) == 2
        #expect(staysAfterSeen || becomesWaiting || isWaiting, "\(String(describing: label)) / \(String(describing: seen))")
        #expect(a["labelUntilSeen"] as? Bool == true, "这一轮结束、理解已写：标签看过就缩回——这正是要测的情形")
        #expect(becomesWaiting)
    }

    @Test("做完没附证据：右栏写没附证据，不写成事实")
    func doneWithoutEvidence() throws {
        let d = try dir()
        try writeList(d, [["turnIndex": 8, "items": [item("L1", "合并 PR", "做完")], "changes": [], "problems": []]])
        let items = try #require(chain(d)?["items"] as? [[String: Any]])
        #expect(items[0]["note"] as? String == "没附证据")
    }

    @Test("没有清单文件：不导出 chain；读不出：导出一句读不出，不当成空清单")
    func missingAndUnreadable() throws {
        let d = try dir()
        #expect(chain(d) == nil)
        try "{ not json\n".write(to: d.appendingPathComponent("s.list.jsonl"), atomically: true, encoding: .utf8)
        let c = try #require(chain(d))
        #expect((c["items"] as? [Any])?.isEmpty == true)
        #expect((c["error"] as? String)?.contains("读不出") == true)
    }
}
