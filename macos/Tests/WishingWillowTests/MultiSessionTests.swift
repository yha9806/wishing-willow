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

    @Test("第二个会话：排除主会话；插件坏了 > 正在跑 > 没看过的新声明；看过且空闲的不占胶囊")
    func secondary() throws {
        let seen = SeenStore(ephemeral: true)
        let s = try store([
            ["sessionId": "main", "decode": "读成了", "tag": "主会话", "turnEndedAt": ended],
            ["sessionId": "fresh", "decode": "读成了", "tag": "新声明", "turnEndedAt": ended],
            ["sessionId": "run"],
        ])
        let main = s.sessions.first { $0.id == "main" }
        #expect(FocusRule.secondary(s, seen, primary: main)?.id == "run")
        #expect(FocusRule.secondary(s, seen, primary: s.sessions.first { $0.id == "run" })?.id == "main")

        let quiet = try store([
            ["sessionId": "main", "decode": "读成了", "tag": "主会话", "turnEndedAt": ended],
            ["sessionId": "idle", "decode": "读成了", "tag": "看过了", "turnEndedAt": ended, "turnId": "ti"],
        ])
        seen.markSeen(sessionId: "idle", turnId: "ti")
        #expect(FocusRule.secondary(quiet, seen, primary: quiet.sessions.first { $0.id == "main" }) == nil)
        #expect(FocusRule.secondary(quiet, seen, primary: nil)?.id == "main")
    }

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

    @Test("主会话无话可说而另一个在跑：把在跑的提成主会话——不留一个空刘海再挂一个胶囊")
    func pairPromotes() throws {
        let seen = SeenStore(ephemeral: true)
        let s = try store([
            ["sessionId": "done", "decode": "读成了", "tag": "看过了", "turnEndedAt": ended],
            ["sessionId": "run"],
        ])
        seen.markSeen(sessionId: "done", turnId: "t0")
        seen.markSeen(sessionId: "run", turnId: "t1")
        #expect(FocusRule.focus(s, seen)?.id == "done")
        let p = FocusRule.pair(s, seen, pinned: nil)
        #expect(p.primary?.id == "run")
        #expect(p.secondary == nil)
        // 钉住的会话不被提换：你悬停展开的那个就是展开的那个。
        #expect(FocusRule.pair(s, seen, pinned: "done").primary?.id == "done")
    }
}
