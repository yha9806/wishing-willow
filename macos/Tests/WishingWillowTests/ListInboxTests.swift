import Testing
import Foundation
@testable import WishingWillow

/// 作者在 lintel 面板里对清单项点的动作（09-28 spec「清单实时」C）：导出哪些动作、收件收不收、写哪一行，
/// 以及用仓库里的插件 listctl 真跑一遍：清单文件多一份 via = author 的快照，收件挪进 done/。
@MainActor
@Suite("面板动作：收件到清单")
struct ListInboxTests {
    init() { Lang.current = .zh }

    private func item(_ id: String, _ status: String) -> ListSnapshot.Item {
        .init(id: id, text: "合成事项 \(id)", status: status, wait: nil, basis: nil, evidence: nil, approved: false, touched: nil)
    }

    @Test("开着的项导出三个动作，第一个是做完；以后的项不给「挪到以后」")
    func actions() {
        #expect(ListInbox.actions(item: "L3", state: "doing").map { $0["id"] } == ["L3|done", "L3|drop", "L3|later"])
        #expect(ListInbox.actions(item: "L3", state: "later").map { $0["id"] } == ["L3|done", "L3|drop"])
        #expect(ListInbox.actions(item: "L3", state: "you").first?["title"] == "做完")
    }

    @Test("判定：开着的项照做；关了的、没有的、认不出的、别的种类都不做并写明理由")
    func decide() {
        let items = [item("L1", "等你"), item("L2", "做完"), item("L3", "以后")]
        func msg(_ a: String, kind: String = "action", session: String = "sess-1") -> [String: Any] {
            ["kind": kind, "activity": session, "action": a]
        }
        #expect(ListInbox.decide(msg("L1|done"), items: items) == .run(session: "sess-1", line: "L1 做完：作者在面板里勾掉"))
        #expect(ListInbox.decide(msg("L1|drop"), items: items) == .run(session: "sess-1", line: "L1 撤掉：作者在面板里撤掉"))
        #expect(ListInbox.decide(msg("L1|later"), items: items) == .run(session: "sess-1", line: "L1 → 以后：作者在面板里挪到以后"))
        #expect(ListInbox.decide(msg("L2|done"), items: items) == .refuse("L2 已经关了（做完）"))
        #expect(ListInbox.decide(msg("L3|later"), items: items) == .refuse("L3 本来就是以后"))
        #expect(ListInbox.decide(msg("L9|done"), items: items) == .refuse("清单里没有 L9"))
        #expect(ListInbox.decide(msg("L1|rm -rf"), items: items) == .refuse("认不出的动作"))
        #expect(ListInbox.decide(msg("L1|done", kind: "drop"), items: items) == .refuse("不是面板动作"))
        #expect(ListInbox.decide(msg("L1|done", session: "../x"), items: items) == .refuse("没有会话号"))
        #expect(ListInbox.decide(msg("L1|done"), items: nil) == .refuse("这场会话没有清单或读不出"))
    }

    @Test("端到端：收件里一个做完 → 插件 listctl --by author 写进清单，收件挪进 done/ 并写结果")
    func drain() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("willow-inbox-\(UUID().uuidString)")
        let state = root.appendingPathComponent("state"), inbox = root.appendingPathComponent("inbox")
        try fm.createDirectory(at: state, withIntermediateDirectories: true)
        try fm.createDirectory(at: inbox, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let sid = "test-inbox-1"
        let st: [String: Any] = ["schema": 16, "sessionId": sid, "turnId": "p1", "turnIndex": 0, "updatedAt": "2026-09-28T10:00:00.000Z"]
        try JSONSerialization.data(withJSONObject: st).write(to: state.appendingPathComponent("\(sid).json"))
        let snap: [String: Any] = ["at": "2026-09-28T10:00:00.000Z", "turnId": "p1", "turnIndex": 0, "changes": [], "problems": [], "rows": [],
                                   "items": [["id": "L1", "text": "合成事项甲", "status": "等你", "wait": NSNull(), "basis": "预测", "since": 0, "touched": 0]]]
        try (String(data: JSONSerialization.data(withJSONObject: snap), encoding: .utf8)! + "\n")
            .write(to: state.appendingPathComponent("\(sid).list.jsonl"), atomically: true, encoding: .utf8)
        let msg: [String: Any] = ["schema": 1, "kind": "action", "activity": sid, "action": "L1|done", "at": "2026-09-28T10:01:00Z", "from": "lintel"]
        try JSONSerialization.data(withJSONObject: msg).write(to: inbox.appendingPathComponent("a1.json"))

        // 用仓库里的插件，不用本机装的那份。
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        setenv("WILLOW_LISTCTL", repo.appendingPathComponent("plugin/hooks/listctl.mjs").path, 1)
        defer { unsetenv("WILLOW_LISTCTL") }
        #expect(ListInbox.drain(inbox: inbox, stateDir: state) == 1)

        let lines = try String(contentsOf: state.appendingPathComponent("\(sid).list.jsonl"), encoding: .utf8).split(separator: "\n")
        #expect(lines.count == 2)
        let last = try JSONSerialization.jsonObject(with: Data(lines.last!.utf8)) as! [String: Any]
        #expect(last["via"] as? String == "author")
        let l1 = (last["items"] as! [[String: Any]]).first { $0["id"] as? String == "L1" }
        #expect(l1?["status"] as? String == "做完")
        #expect(!fm.fileExists(atPath: inbox.appendingPathComponent("a1.json").path))
        let result = try JSONSerialization.jsonObject(with: Data(contentsOf: inbox.appendingPathComponent("done/a1.result.json"))) as! [String: Any]
        #expect(result["ok"] as? Bool == true)
    }
}
