import Testing
import Foundation
@testable import WishingWillow

/// F9（lintel 负担报告 2026-09-18）：一轮没写完就被关掉的会话，导出成「正在跑」——计时从几天前一直往上走、胶囊在闪、
/// 带 60 秒心跳，来源进程于是每 30 秒把这些已关闭会话的文件全部重写一遍（实测 21 份）。会话进程不在了，这一轮就不会再进行。
@MainActor
@Suite("导出：已关闭的会话不再算在跑")
struct ClosedExportTests {
    init() { Lang.current = .zh }

    private let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    private func store(pid: Int) throws -> WillowStore {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("willow-closed-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        let obj: [String: Any] = ["schema": 9, "sessionId": "s", "pid": pid, "cwd": "/x/w", "turnId": "t1",
                                  "updatedAt": iso.format(Date().addingTimeInterval(-3 * 86_400)),
                                  "prompt": "一句够长的请求", "promptField": "prompt", "origin": "user",
                                  "reminded": true, "decode": NSNull(), "turnEndedAt": NSNull()]
        try JSONSerialization.data(withJSONObject: obj).write(to: d.appendingPathComponent("s.json"))
        let s = WillowStore(directory: d)
        s.reload()
        return s
    }

    @Test("进程已经不在：不算进行中、没有心跳、没有走的计时、没有闪的胶囊；进程还在：照旧")
    func closedMidTurn() throws {
        let dead = try store(pid: 99_999_999)
        let a = ActivityExport.activities(dead)["s"]!
        #expect(a["open"] as? Bool == false)
        #expect(a["inProgress"] as? Bool == false)
        #expect(a["heartbeatSeconds"] == nil)
        let st = a["status"] as? [String: Any]
        #expect(st?["center"] as? String != "live")
        #expect((st?["clock"] as? [String: Any])?["style"] as? String != "live")
        #expect(a["pill"] is NSNull)
        let detail = a["detail"] as? [String: Any]
        #expect(detail?["live"] == nil)
        #expect((detail?["chart"] as? [String: Any])?["runningSince"] is NSNull)

        let alive = try store(pid: Int(ProcessInfo.processInfo.processIdentifier))
        let b = ActivityExport.activities(alive)["s"]!
        #expect(b["inProgress"] as? Bool == true)
        #expect(b["heartbeatSeconds"] as? Int == 60)
        #expect(((b["status"] as? [String: Any])?["clock"] as? [String: Any])?["style"] as? String == "live")
    }

    @Test("系统消息开始的一轮标 quiet，宿主画成一行细条；你说的一轮不标（09-28 面板 grill 第三轮 R3）")
    func quietSystemTurns() throws {
        let s = try store(pid: 99_999_999)
        let t0 = Date().addingTimeInterval(-3 * 86_400 - 600)
        let rows: [[String: Any]] = [
            ["turnId": "a", "at": iso.format(t0), "endedAt": iso.format(t0.addingTimeInterval(60)), "reminded": false,
             "origin": "system", "prompt": "<task-notification>合成的后台任务完成</task-notification>"],
            ["turnId": "b", "at": iso.format(t0.addingTimeInterval(120)), "endedAt": iso.format(t0.addingTimeInterval(200)),
             "reminded": true, "origin": "user", "prompt": "把合成仓库里三个配置文件对一遍", "decode": "对齐三个合成配置", "tag": "对配置"],
        ]
        let log = rows.map { String(data: try! JSONSerialization.data(withJSONObject: $0), encoding: .utf8)! }.joined(separator: "\n") + "\n"
        try log.write(to: s.directory.appendingPathComponent("s.log.jsonl"), atomically: true, encoding: .utf8)
        s.reload()
        let history = try #require((ActivityExport.activities(s)["s"]?["detail"] as? [String: Any])?["history"] as? [[String: Any]])
        let byId = Dictionary(uniqueKeysWithValues: history.compactMap { h in (h["id"] as? String).map { ($0, h) } })
        let sys = try #require(history.first { ($0["lines"] as? [[String: Any]])?.first?["text"] as? String == "系统消息（后台任务通知），不是你说的" })
        #expect(sys["quiet"] as? Bool == true)
        #expect(history.filter { $0["quiet"] as? Bool == true }.count == 1, "\(byId.keys)")
    }
}
