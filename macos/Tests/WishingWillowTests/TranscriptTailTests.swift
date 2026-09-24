import Testing
import Foundation
@testable import WishingWillow

/// app 在一轮进行中实时读聊天记录。声明的解析规则有两份实现（插件 JS、这里 Swift），
/// 用插件的回放用例做对照钉住——两边对同一轮必须给出相同的 decode 与 tag。
@MainActor
@Suite("实时读这一轮")
struct TranscriptTailTests {
    init() { Lang.current = .zh }

    static let casesDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // WishingWillowTests
        .deletingLastPathComponent()   // Tests
        .deletingLastPathComponent()   // macos
        .deletingLastPathComponent()   // 仓库根
        .appendingPathComponent("tests/replay/cases")

    private func parse(_ text: String) -> TurnProgress {
        var p = TurnProgress()
        for line in text.split(separator: "\n") {
            if let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] { p.ingest(obj) }
        }
        return p
    }

    private func file(_ c: String, _ f: String) throws -> String {
        try String(contentsOf: Self.casesDir.appendingPathComponent(c).appendingPathComponent(f), encoding: .utf8)
    }

    private func expectation(_ c: String, _ key: String) throws -> [String: Any] {
        let d = try Data(contentsOf: Self.casesDir.appendingPathComponent(c).appendingPathComponent("expect.json"))
        let obj = try JSONSerialization.jsonObject(with: d) as! [String: Any]
        return obj[key] as! [String: Any]
    }

    /// 单文件的用例：取最后一条真实用户消息之后的行（等价于插件在提交时记下的偏移）。
    private func afterLastUser(_ text: String) -> String {
        let lines = text.split(separator: "\n").map(String.init)
        var last = -1
        for (i, l) in lines.enumerated() {
            guard let o = try? JSONSerialization.jsonObject(with: Data(l.utf8)) as? [String: Any],
                  (o["type"] as? String) == "user", (o["isSidechain"] as? Bool) != true else { continue }
            let c = (o["message"] as? [String: Any])?["content"]
            if c is String { last = i; continue }
            if let arr = c as? [[String: Any]], !arr.contains(where: { ($0["type"] as? String) == "tool_result" }) { last = i }
        }
        return lines.dropFirst(last + 1).joined(separator: "\n")
    }

    @Test("声明解析与插件一致：同一批回放用例给出相同的 decode 与 tag")
    func matchesPlugin() throws {
        let table: [(String, String, String)] = [
            ("10-decode-before-tools", afterLastUser(try file("10-decode-before-tools", "transcript.jsonl")), "state_file"),
            ("11-stale-decode-not-reused", afterLastUser(try file("11-stale-decode-not-reused", "transcript.jsonl")), "state_file"),
            ("15-huge-turn-offset", try file("15-huge-turn-offset", "transcript.turn.jsonl"), "state_file"),
            ("18-envelope-mid-turn", try file("18-envelope-mid-turn", "transcript.part1.jsonl")
                + "\n" + (try file("18-envelope-mid-turn", "transcript.part2.jsonl")), "state_file"),
            ("19-interrupted-turn", try file("19-interrupted-turn", "transcript.part-a.jsonl"), "log_last"),
        ]
        for (name, text, key) in table {
            let want = try expectation(name, key)
            let got = parse(text)
            #expect(got.decode == want["decode"] as? String, "\(name) decode")
            #expect(got.tag == want["tag"] as? String, "\(name) tag")
        }
    }

    @Test("代码块里引用的声明不算")
    func quoted() {
        let row = #"{"type":"assistant","isSidechain":false,"timestamp":"2026-09-12T19:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"**示例：**\n\n```\n你批准的：继续往下做。\n我读成了：先把今天那件事做掉。\n```\n\n多出来半句。"}]}}"#
        #expect(parse(row).decode == nil)
    }

    @Test("工具调用变成人话步骤；思考只记有没有；子代理里的不算")
    func steps() {
        let rows = [
            #"{"type":"assistant","timestamp":"2026-09-12T19:00:00.000Z","message":{"content":[{"type":"thinking","thinking":""}]}}"#,
            #"{"type":"assistant","timestamp":"2026-09-12T19:00:05.000Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls","description":"Check state files"}}]}}"#,
            #"{"type":"assistant","timestamp":"2026-09-12T19:00:06.000Z","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/a/b/extract.mjs"}}]}}"#,
            #"{"type":"assistant","timestamp":"2026-09-12T19:00:07.000Z","message":{"content":[{"type":"tool_use","name":"WebFetch","input":{"url":"https://github.com/x/y","prompt":"p"}}]}}"#,
            #"{"type":"assistant","isSidechain":true,"timestamp":"2026-09-12T19:00:08.000Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"description":"子代理里的"}}]}}"#,
        ].joined(separator: "\n")
        let p = parse(rows)
        #expect(p.thinkingSeen)
        #expect(p.steps.map(\.text) == ["Check state files", "读 extract.mjs", "取 github.com"])
        #expect(TranscriptTail.describe(tool: "mcp__computer-use__request_access", input: [:]) == "request_access")
    }

    @Test("撤回：认出打断标记与撤回的排队消息；系统通知被移除不算")
    func withdrawals() {
        let rows = [
            #"{"type":"assistant","timestamp":"2026-09-12T19:00:03.000Z","message":{"content":[{"type":"thinking","thinking":""}]}}"#,
            #"{"type":"queue-operation","operation":"enqueue","timestamp":"2026-09-12T19:00:05.000Z","content":"顺便把 README 也改了"}"#,
            #"{"type":"queue-operation","operation":"remove","timestamp":"2026-09-12T19:00:06.000Z","content":"顺便把 README 也改了"}"#,
            #"{"type":"queue-operation","operation":"remove","timestamp":"2026-09-12T19:00:07.000Z","content":"<task-notification>\n<task-id>x</task-id>"}"#,
            #"{"type":"user","isSidechain":false,"timestamp":"2026-09-12T19:00:09.000Z","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#,
        ].joined(separator: "\n")
        let p = parse(rows)
        #expect(p.withdrawnQueued == ["顺便把 README 也改了"])
        #expect(p.interruptedAt != nil)
    }

    @Test("续接会话第一轮没有偏移：从末尾往回找与原话一致的最后一条用户消息，更早的同一句不算")
    func locateByPrompt() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("willow-locate-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("r.jsonl")
        let p = "把这个目录整个扫一遍，先不要改。"
        func u(_ t: String) -> String {
            "{\"type\":\"user\",\"isSidechain\":false,\"timestamp\":\"2026-09-11T10:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"\(t)\"}}"
        }
        func a(_ d: String) -> String {
            "{\"type\":\"assistant\",\"timestamp\":\"2026-09-11T10:00:05.000Z\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"我读成了：\(d)\\n标签：x\"}]}}"
        }
        let text = [u(p), a("更早同一句的解码"), u("继续"), a("旧的解码"), u(p), a("新的解码")].joined(separator: "\n") + "\n"
        try Data(text.utf8).write(to: path)
        let off = TranscriptTail.locateTurnStart(path: path.path, prompt: p)
        #expect(off != nil)
        #expect(TranscriptFollower().progress(key: "k", path: path.path, offset: off ?? 0)?.decode == "新的解码")
    }

    @Test("边写边读：半行等读到换行再解析；偏移之前的上一轮不算")
    func follower() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("willow-tail-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("t.jsonl")
        let prev = #"{"type":"assistant","timestamp":"2026-09-12T18:00:00.000Z","message":{"content":[{"type":"text","text":"我读成了：上一轮的\n标签：上一轮"}]}}"# + "\n"
        try Data(prev.utf8).write(to: path)
        let offset = prev.utf8.count
        let decl = #"{"type":"assistant","timestamp":"2026-09-12T19:00:10.000Z","message":{"content":[{"type":"text","text":"你批准的：x\n我读成了：本轮的解码\n标签：本轮标签"}]}}"# + "\n"
        let bytes = Array(decl.utf8)
        let cut = bytes.count / 2
        let h = try FileHandle(forWritingTo: path)
        _ = try h.seekToEnd()
        try h.write(contentsOf: Data(bytes[..<cut]))
        let f = TranscriptFollower()
        #expect(f.progress(key: "s|t", path: path.path, offset: offset)?.decode == nil)
        try h.write(contentsOf: Data(bytes[cut...]))
        try h.close()
        let p = f.progress(key: "s|t", path: path.path, offset: offset)
        #expect(p?.decode == "本轮的解码")
        #expect(p?.tag == "本轮标签")
    }

    @Test("压缩后重写进来的旧消息不算步数：比这一段第一行早一分钟以上的不算，同一个 uuid 只算一次（09-24 实测一次压缩 3,836 行）")
    func compactionCopies() {
        func tool(_ uuid: String, _ ts: String, _ path: String) -> String {
            #"{"type":"assistant","uuid":"\#(uuid)","timestamp":"\#(ts)","message":{"content":[{"type":"tool_use","id":"\#(uuid)","name":"Read","input":{"file_path":"\#(path)"}}]}}"#
        }
        let rows = [
            #"{"type":"user","uuid":"u1","timestamp":"2026-09-20T10:00:00.000Z","message":{"content":"合成的一轮"}}"#,
            tool("t1", "2026-09-20T10:00:05.000Z", "/tmp/fake/a.json"),
            #"{"type":"system","subtype":"compact_boundary","uuid":"cb","timestamp":"2026-09-20T10:05:00.000Z"}"#,
            tool("o1", "2026-09-20T09:00:05.000Z", "/tmp/fake/old-1.json"),   // 一小时前的旧消息，原样重写进来
            tool("o2", "2026-09-20T09:00:06.000Z", "/tmp/fake/old-2.json"),
            tool("t1", "2026-09-20T10:00:05.000Z", "/tmp/fake/a.json"),       // 本轮自己的一条也被重写了一次
            tool("t2", "2026-09-20T10:06:00.000Z", "/tmp/fake/b.json"),
        ]
        let p = parse(rows.joined(separator: "\n"))
        #expect(p.steps.count == 2)
        #expect(p.steps.map(\.text).joined().contains("old") == false)
    }
}
