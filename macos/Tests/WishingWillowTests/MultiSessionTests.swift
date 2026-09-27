import Testing
import Foundation
@testable import WishingWillow

/// 并行会话：Apple HIG 的做法是一个活动贴着摄像头占两翼，第二个活动分离成一个小胶囊。
/// 要钉住的是：胶囊显示的是「另一个会话里有话说的那个」。（排队那一条随刘海界面移到 lintel `OrderingTests.arrivalQueue`，2026-09-19。）
@MainActor
@Suite("并行会话：排队与第二个会话")
struct MultiSessionTests {
    init() { Lang.current = .zh }

    private let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    private func store(_ records: [[String: Any]]) throws -> WillowStore {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("willow-multi-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        let pid = Int(ProcessInfo.processInfo.processIdentifier)
        for (i, r) in records.enumerated() {
            var obj: [String: Any] = ["schema": 9, "pid": pid, "cwd": "/x/w\(i)", "turnId": "t\(i)",
                                      "updatedAt": iso.format(Date().addingTimeInterval(Double(-10 * (i + 1)))),
                                      "prompt": "一句够长的请求", "promptField": "prompt", "origin": "user",
                                      "reminded": true, "decode": NSNull(), "turnEndedAt": NSNull()]
            obj.merge(r) { $1 }
            try JSONSerialization.data(withJSONObject: obj)
                .write(to: d.appendingPathComponent("\(obj["sessionId"]!).json"))
        }
        let s = WillowStore(directory: d)
        s.reload()
        return s
    }

    private var ended: String { iso.format(Date().addingTimeInterval(-5)) }

    @Test("胶囊内容：正在跑→计时；没看过的声明→标签（自标 ⚠ 单独记）；问了没写→没写")
    func pill() throws {
        let seen = SeenStore(ephemeral: true)
        let s = try store([
            ["sessionId": "run"],
            ["sessionId": "warn", "decode": "⚠ 读成了别的", "tag": "改动效", "turnEndedAt": ended],
            ["sessionId": "silent", "turnEndedAt": ended],
        ])
        func pill(_ id: String) -> FocusRule.Pill? {
            FocusRule.pill(s.sessions.first { $0.id == id }!, seen, s)
        }
        if case .running = pill("run") {} else { Issue.record("run → \(String(describing: pill("run")))") }
        #expect(pill("warn") == .fresh(tag: "改动效", flagged: true))
        #expect(pill("silent") == .silent)
    }

}
