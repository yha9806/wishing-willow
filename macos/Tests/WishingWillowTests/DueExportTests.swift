import Testing
import Foundation
@testable import WishingWillow

/// 导出：到了日子的「等别的」「以后」项带 `due`（ops-private spec 2026-10-06「刘海上露出到了日子的项」D1）。
/// 字这边写好（「已过 N 天」），lintel 只看有没有 `due`，不知道 14 天这条规则。
/// 只用带年份的日期（2020 年永远已过、2099 年永远没到），不随跑测试那天变；也不调新加的函数，改之前的代码上照样编译、能验红。
@MainActor
@Suite("导出：到了日子的项")
struct DueExportTests {
    init() { Lang.current = .zh }

    private let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    private func dir(_ items: [[String: Any]]) throws -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("willow-due-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        let obj: [String: Any] = ["schema": 12, "sessionId": "s", "pid": Int(ProcessInfo.processInfo.processIdentifier),
                                  "cwd": "/x/w", "turnId": "t9", "turnIndex": 9,
                                  "updatedAt": iso.format(Date()), "prompt": "一句够长的请求", "promptField": "prompt",
                                  "origin": "user", "reminded": true, "decode": NSNull(), "tag": NSNull(), "turnEndedAt": NSNull()]
        try JSONSerialization.data(withJSONObject: obj).write(to: d.appendingPathComponent("s.json"))
        let snap: [String: Any] = ["turnIndex": 8, "items": items, "changes": [], "problems": []]
        let line = String(data: try JSONSerialization.data(withJSONObject: snap), encoding: .utf8)! + "\n"
        try line.write(to: d.appendingPathComponent("s.list.jsonl"), atomically: true, encoding: .utf8)
        return d
    }

    private func item(_ id: String, _ text: String, _ status: String, wait: String? = nil) -> [String: Any] {
        ["id": id, "text": text, "status": status, "wait": wait ?? NSNull(), "basis": "预测", "sourceTurn": "t1", "since": 1, "touched": 8]
    }

    private func items(_ d: URL) throws -> [String: [String: Any]] {
        let s = WillowStore(directory: d)
        s.reload()
        let c = try #require(ActivityExport.activities(s)["s"]?["chain"] as? [String: Any])
        let xs = try #require(c["items"] as? [[String: Any]])
        return Dictionary(uniqueKeysWithValues: xs.map { ($0["id"] as! String, $0) })
    }

    @Test("已过的「以后」「等别的」带 due：天数是负的，字写「已过 N 天」")
    func overdue() throws {
        let x = try items(dir([
            item("L1", "交合成报告，2020-01-15 前", "以后"),
            item("L2", "合成回执，对方 2020-02-01 回", "等", wait: "合成回信"),
        ]))
        for id in ["L1", "L2"] {
            let due = try #require(x[id]?["due"] as? [String: Any], "\(id) 应带 due")
            let days = try #require(due["days"] as? Int)
            #expect(days < -2000, "\(id)：2020 年的日子早过了")
            #expect((due["text"] as? String) == "已过 \(-days) 天")
        }
    }

    @Test("没到日子、认不出日期、等你、在做、做完：都不带 due")
    func noDue() throws {
        let x = try items(dir([
            item("L1", "交合成年报，2099-12-31 前", "以后"),
            item("L2", "合成事项没写日子", "等", wait: "合成回信"),
            item("L3", "合成确认，2020-01-15 前", "等你"),
            item("L4", "合成在做，2020-01-15 前", "在做"),
            item("L5", "合成做完，2020-01-15 前", "做完"),
            item("L6", "ABCD-26-0517 合成返修", "以后"),
        ]))
        #expect(x.count == 6)
        for (id, v) in x { #expect(v["due"] == nil, "\(id) 不该带 due") }
    }

    // 下面两条调新加的函数，改之前的代码上编译不过，不算验红；它们能不能红，靠变异检验（spec 实现状态）。
    private func noon(_ y: Int, _ m: Int, _ d: Int) -> Date {
        Calendar.current.date(from: DateComponents(year: y, month: m, day: d, hour: 12))!
    }

    @Test("窗口：第 14 天带、第 15 天不带；等你不带")
    func window() {
        let today = noon(2026, 10, 6)
        #expect(ActivityExport.due("10 月 20 日前交合成说明", state: "later", today: today)?["days"] as? Int == 14)
        #expect(ActivityExport.due("10 月 20 日前交合成说明", state: "later", today: today)?["text"] as? String == "还有 14 天")
        #expect(ActivityExport.due("10-21 前交合成说明", state: "later", today: today) == nil)
        #expect(ActivityExport.due("合成回执，对方 10-06 回", state: "other", today: today)?["text"] as? String == "今天")
        #expect(ActivityExport.due("合成确认，09-18 答应", state: "you", today: today) == nil)
    }

    @Test("换了一天重算：同一个标题，昨天算的「今天」今天是「已过 1 天」")
    func nextDay() {
        let t = "合成回执，对方 10-06 回"
        #expect(ActivityExport.dueDays(t, today: noon(2026, 10, 6)) == 0)
        #expect(ActivityExport.dueDays(t, today: noon(2026, 10, 7)) == -1)
    }
}
