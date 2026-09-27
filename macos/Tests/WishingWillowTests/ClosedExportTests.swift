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
}
