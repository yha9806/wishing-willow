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

    @Test("最后一份快照：每项带状态、显示的字、注；撤掉的不出现；预测不带注")
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
        #expect(items[1]["note"] == nil, "预测不写字：有证据的写证据，没写的就是还没有证据")
        #expect(items[4]["note"] == nil)
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

    private func activity(_ d: URL) throws -> [String: Any] {
        let s = WillowStore(directory: d)
        s.reload()
        return try #require(ActivityExport.activities(s)["s"])
    }

    private func listEvents(_ a: [String: Any]) -> [[String: Any]] {
        (a["events"] as? [[String: Any]] ?? []).filter { $0["type"] as? String == "list" }
    }

    @Test("主动弹出只放变化（V3）：这一轮新出现等你、打回、撤掉、认可时发 list 事件，弹卡只列这几项")
    func popupOnTriggers() throws {
        let d = try dir(ended: true)
        try writeList(d, [
            ["turnId": "t8", "turnIndex": 8, "items": [item("L1", "改引言", "在做"), item("L2", "合并 PR", "做完", evidence: "abc"),
                                                       item("L4", "旧想法", "以后")], "changes": [], "problems": []],
            ["turnId": "t9", "turnIndex": 9, "at": iso.format(Date()), "items": [
                item("L1", "改引言", "做完", evidence: "def"),
                item("L2", "合并 PR", "在做"),
                item("L3", "看新 spec", "等你"),
                item("L4", "旧想法", "撤掉"),
            ], "changes": ["L1 做完", "L2 在做", "新增 L3", "L4 撤掉"], "problems": []],
        ])
        let a = try activity(d)
        #expect(listEvents(a).count == 1)
        let popup = try #require(a["popup"] as? [[String: Any]])
        #expect(popup.map { $0["label"] as? String } == ["打回", "等你", "撤掉"], "单纯做完一项（L1）不弹")
        #expect((popup[1]["text"] as? String)?.contains("看新 spec") == true)
        #expect(popup.allSatisfy { $0["lines"] as? Int == 2 }, "弹卡的一项写两行：09-24 实拍一行时事项被截成「…」")
    }

    @Test("只是做完一步：不发 list 事件，弹卡照旧")
    func noPopupWithoutTrigger() throws {
        let d = try dir(ended: true)
        try writeList(d, [
            ["turnId": "t8", "turnIndex": 8, "items": [item("L1", "改引言", "在做")], "changes": [], "problems": []],
            ["turnId": "t9", "turnIndex": 9, "items": [item("L1", "改引言", "做完", evidence: "def")], "changes": ["L1 做完"], "problems": []],
        ])
        let a = try activity(d)
        #expect(listEvents(a).isEmpty)
        #expect(!((a["popup"] as? [[String: Any]]) ?? []).contains { $0["label"] as? String == "等你" })
    }

    @Test("快照是更早一轮的：这一轮没有清单变化，不弹")
    func staleSnapshotNoPopup() throws {
        let d = try dir(ended: true)
        try writeList(d, [["turnId": "t1", "turnIndex": 1, "items": [item("L1", "看新 spec", "等你")], "changes": ["新增 L1"], "problems": []]])
        #expect(listEvents(try activity(d)).isEmpty)
    }

    @Test("注超过 lintel 的上限（64 字）就截短：一条长证据曾让整份活动被 lintel 拒收、会话从刘海上消失（09-24）")
    func longNoteIsCut() throws {
        let d = try dir()
        let long = String(repeating: "证", count: 95)
        try writeList(d, [["turnIndex": 8, "items": [item("L1", "合并", "做完", evidence: long),
                                                      item("L2", "看 spec", "等你", basis: long)], "changes": [], "problems": []]])
        let items = try #require(chain(d)?["items"] as? [[String: Any]])
        for x in items {
            let n = try #require(x["note"] as? String)
            #expect(n.count <= 64 && n.hasSuffix("…"))
        }
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

    @Test("这一轮在跑：进度挂在「在做」里最近动过的那项，一样近取后加的；没有在做的就不挂")
    func activeDoing() {
        func item(_ id: String, _ status: String, _ touched: Int?) -> ListSnapshot.Item {
            .init(id: id, text: id, status: status, wait: nil, basis: nil, evidence: nil, approved: false, touched: touched)
        }
        #expect(ActivityExport.activeDoing([item("L1", "在做", 3), item("L2", "在做", 5), item("L3", "等你", 9)]) == "L2")
        #expect(ActivityExport.activeDoing([item("L1", "在做", 5), item("L2", "在做", 5)]) == "L2")
        #expect(ActivityExport.activeDoing([item("L1", "等你", 5), item("L2", "做完", 6)]) == nil)
    }

    @Test("进度的注：第几步、几分钟；不到一分钟写刚开始")
    func progressNote() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(ActivityExport.progressNote(steps: 12, since: now.addingTimeInterval(-190), now: now) == "第 12 步 · 3 分钟")
        #expect(ActivityExport.progressNote(steps: 2, since: now.addingTimeInterval(-20), now: now) == "第 2 步 · 刚开始")
        #expect(ActivityExport.progressNote(steps: 0, since: nil, now: now) == "第 0 步 · 刚开始")
    }
}
