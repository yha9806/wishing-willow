import Testing
import Foundation
@testable import WishingWillow

/// 面板左栏（用户 2026-09-17）：点开面板，关掉很久的会话一直列在那里。本机 40 个状态文件里 5 个进程还活着，
/// 列表 4 行封顶，第 5 个开着的会话要往下滚才看得见，下面再接 35 行灰的。
/// 改为：开着的平铺；关掉的按工作区合并、默认折叠。文件一个不删——按事实分段，不按时间阈值藏。
@MainActor
@Suite("面板左栏：开着的平铺，关掉的按工作区折叠")
struct SessionSectionsTests {
    init() { Lang.current = .zh }

    private let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    /// 一定不存在的进程号（macOS 的进程号上限远小于它）。
    private let deadPid = 2_000_000

    private func store(_ records: [[String: Any]]) throws -> WillowStore {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("willow-sections-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        for r in records {
            var obj: [String: Any] = ["schema": 10, "pid": Int(ProcessInfo.processInfo.processIdentifier),
                                      "turnId": "t", "prompt": "一句够长的请求", "promptField": "prompt",
                                      "origin": "user", "reminded": true, "decode": "读成了",
                                      "turnEndedAt": iso.format(Date().addingTimeInterval(-60)), "endedAt": NSNull()]
            obj.merge(r) { $1 }
            try JSONSerialization.data(withJSONObject: obj)
                .write(to: d.appendingPathComponent("\(obj["sessionId"]!).json"))
        }
        let s = WillowStore(directory: d)
        s.reload()
        return s
    }

    private func ago(_ seconds: TimeInterval) -> String { iso.format(Date().addingTimeInterval(-seconds)) }

    @Test("开着的在上面；进程没了、或插件写了 endedAt 的收进已关闭；一个都不丢")
    func split() throws {
        let s = try store([
            ["sessionId": "open", "cwd": "/x/a", "updatedAt": ago(60)],
            ["sessionId": "ended", "cwd": "/x/b", "updatedAt": ago(120), "endedAt": ago(30)],
            ["sessionId": "dead", "cwd": "/x/c", "updatedAt": ago(180), "pid": deadPid],
        ])
        let (open, closed) = DetailView.sections(s.sessions, keep: [])
        #expect(open.map(\.id) == ["open"])
        #expect(Set(closed.flatMap(\.sessions).map(\.id)) == ["ended", "dead"])
        #expect(open.count + closed.flatMap(\.sessions).count == s.sessions.count)
    }

    @Test("同一路径合并成一组；组按最近一次动静排、组内新的在前；关闭时刻优先取 endedAt；同名不同路径不合并")
    func grouping() throws {
        let s = try store([
            ["sessionId": "a-old", "cwd": "/x/alpha", "updatedAt": ago(3 * 3600), "pid": deadPid],
            ["sessionId": "a-new", "cwd": "/x/alpha", "updatedAt": ago(3600), "pid": deadPid],
            // 最后一轮在 5 小时前，但半小时前才关——按关的时刻排在最前。
            ["sessionId": "b", "cwd": "/y/beta", "updatedAt": ago(5 * 3600), "endedAt": ago(1800)],
            ["sessionId": "z", "cwd": "/z/alpha", "updatedAt": ago(2 * 3600), "pid": deadPid],
        ])
        let (_, closed) = DetailView.sections(s.sessions, keep: [])
        #expect(closed.map(\.id) == ["/y/beta", "/x/alpha", "/z/alpha"])
        #expect(closed.first { $0.id == "/x/alpha" }?.sessions.map(\.id) == ["a-new", "a-old"])
        #expect(closed.filter { $0.workspace == "alpha" }.count == 2)
    }

    @Test("面板开着时，上面那段里的会话关掉了：留在原处，不从你正看着的地方消失")
    func keep() throws {
        let s = try store([
            ["sessionId": "open", "cwd": "/x/a", "updatedAt": ago(60)],
            ["sessionId": "just-closed", "cwd": "/x/b", "updatedAt": ago(90), "endedAt": ago(5)],
        ])
        #expect(DetailView.sections(s.sessions, keep: []).open.map(\.id) == ["open"])   // 对照：不留就收进已关闭
        let (open, closed) = DetailView.sections(s.sessions, keep: ["just-closed"])
        #expect(Set(open.map(\.id)) == ["open", "just-closed"])
        #expect(closed.isEmpty)
    }
}
