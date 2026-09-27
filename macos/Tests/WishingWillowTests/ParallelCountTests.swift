import Testing
import Foundation
@testable import WishingWillow

/// 多任务并行时的计数与文案。用户 2026-09-13：3 个以上并行时界面仍写「+1」「另有 1 个」。
/// 查实：计数没错（主会话、胶囊之外还剩 1 个），但读法对不上；另有 2 个开着但空闲的会话哪儿都没显示。
/// 同日再改口径：用户说「在跑、空闲、共多少」和 Claude Code 本身不符——对照 Claude Code 会话列表的 isRunning，
/// 在跑 = 这一轮没结束，不是「最近 10 分钟有动静」。
@MainActor
@Suite("并行计数")
struct ParallelCountTests {
    init() { Lang.current = .zh }

    @Test("在跑 = 进程开着且这一轮没结束（跑了 20 分钟没写记录也算）；刚答完的算空闲；一轮开着但一小时没动静算空闲；结束的、进程没了的都不算")
    func counts() throws {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("willow-par-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        let me = Int(ProcessInfo.processInfo.processIdentifier)
        func write(_ id: String, pid: Int, ago: TimeInterval, turnOpen: Bool, ended: Bool = false, extra: [String: Any] = [:]) throws {
            var obj: [String: Any] = ["schema": 10, "sessionId": id, "pid": pid, "cwd": "/x/\(id)", "turnId": "t-\(id)",
                                      "updatedAt": iso.format(Date().addingTimeInterval(-ago)),
                                      "prompt": "一句够长的请求", "promptField": "prompt", "origin": "user",
                                      "reminded": true, "tag": "标签\(id)"]
            if turnOpen {
                obj["decode"] = NSNull()
                obj["turnEndedAt"] = NSNull()
            } else {
                obj["decode"] = "读成了"
                obj["turnEndedAt"] = iso.format(Date().addingTimeInterval(-ago))
            }
            if ended { obj["endedAt"] = iso.format(Date()) }
            obj.merge(extra) { $1 }
            try JSONSerialization.data(withJSONObject: obj).write(to: d.appendingPathComponent("\(id).json"))
        }
        try write("answering", pid: me, ago: 20, turnOpen: true)
        try write("longTool", pid: me, ago: 1200, turnOpen: true)      // 跑长工具 20 分钟没写状态
        try write("justDone", pid: me, ago: 60, turnOpen: false)       // 一分钟前刚答完
        try write("oldDone", pid: me, ago: 3600, turnOpen: false)
        try write("stuck", pid: me, ago: 7200, turnOpen: true)         // Stop 钩子没跑到
        try write("gone", pid: me, ago: 20, turnOpen: true, ended: true)
        try write("dead", pid: 99_999_999, ago: 20, turnOpen: true)
        // 这一轮没问（「继续吧」这类短句）、后台任务通知触发的一轮：轮次照样开着，Claude Code 算在跑
        try write("shortAsk", pid: me, ago: 30, turnOpen: true, extra: ["reminded": false])
        try write("sysNote", pid: me, ago: 30, turnOpen: true, extra: ["reminded": false, "origin": "system"])

        let store = WillowStore(directory: d)
        store.reload()
        let open = store.sessions.filter(\.isOpen)
        let openRunning = open.filter(\.isRunning).count
        let openIdle = open.filter { !$0.isRunning }.count
        #expect(openRunning == 4)
        #expect(openIdle == 3)
        let running = Set(store.sessions.filter(\.isRunning).map(\.id))
        #expect(running == ["answering", "longTool", "shortAsk", "sysNote"])
        // 在跑的会话就算超过 10 分钟没写记录，岛上也照样显示
        let longTool = try #require(store.sessions.first { $0.id == "longTool" })
        #expect(longTool.isStale == false)
    }

}
