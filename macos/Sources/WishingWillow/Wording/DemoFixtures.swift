import Foundation

/// `--lintel-export --fixtures` 用的固定样例（原 `Snapshot` / `SelfShot` 的「01-declared-but-drifting」一幕，2026-09-19 原样搬出）。
/// lintel 的截图比对工具靠它产出同一批活动。
@MainActor
enum DemoFixtures {
    static func directory() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("willow-selfshot-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for (name, json) in files {
            try? Data(json.utf8).write(to: dir.appendingPathComponent(name))
        }
        try? Data(sampleLog.utf8).write(to: dir.appendingPathComponent("sess-a.log.jsonl"))
        return dir
    }

    private static var files: [(String, String)] {
        let drifting = record(
            id: "sess-a", cwd: "/Users/me/dev/atlas", turn: 4,
            prompt: "场景之一不是唯一，同样也不局限于此场景。我们要大范围地找到这个问题里面的逻辑是什么，然后找到可以复用的解决方案。",
            promptField: .some("prompt"),
            decode: "⚠ 去那个仓库里逐文件审计检查表与 spec，找漂移的具体证据",
            tag: "审计仓库")

        let undeclared = record(
            id: "sess-b", cwd: "/Users/me/dev/ledger", turn: 2,
            prompt: "把这个目录下所有脚本的错误处理都过一遍，告诉我哪些地方会静默失败，先不要改。",
            promptField: .some("prompt"), decode: nil)

        let broken = record(
            id: "sess-c", cwd: "/Users/me/dev/tiles", turn: 1,
            prompt: nil, promptField: .some(nil), decode: nil)

        let stale = record(
            id: "sess-d", cwd: "/Users/me/dev/archive", turn: 9,
            prompt: "先别动，我看一下昨天那版是怎么写的。",
            promptField: .some("prompt"), decode: "只读，不改任何文件", tag: "读旧版本",
            stamp: Date.ISO8601FormatStyle(includingFractionalSeconds: true)
                .format(.now.addingTimeInterval(-3600)))
        return [("a.json", drifting), ("b.json", undeclared), ("d.json", stale)]
    }

    private static var now: String {
        Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(.now)
    }

    private static var pid: Int32 { ProcessInfo.processInfo.processIdentifier }

    private static func record(
        id: String, cwd: String, turn: Int,
        prompt: String?, promptField: String??, decode: String?, tag: String? = nil, stamp: String? = nil
    ) -> String {
        func q(_ s: String?) -> String {
            guard let s else { return "null" }
            let escaped = s
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
            return "\"\(escaped)\""
        }
        // promptField: nil = 键不存在；.some(nil) = 键在但为 null
        let field: String
        switch promptField {
        case .none: field = ""
        case .some(let v): field = ",\"promptField\":\(q(v))"
        }
        return """
        {"schema":2,"sessionId":"\(id)","pid":\(pid),"cwd":"\(cwd)","turnId":"\(id)-turn",\
        "turnIndex":\(turn),"updatedAt":"\(stamp ?? now)","prompt":\(q(prompt))\(field),"reminded":true,\
        "decode":\(q(decode)),"tag":\(q(tag)),"endedAt":null}
        """
    }

    /// 三轮样例：一轮两栏不一致、一轮问了没答、一轮压根没问。
    /// 这三种在窗口里必须长得不一样 —— 合成一句「无声明」就是在制造
    /// 这个产品本该打破的那种沉默。
    static var sampleLog: String {
        let rows = [
            #"{"turnId":"t0","at":"2026-09-12T16:10:00.000Z","endedAt":null,"interrupted":true,"reminded":true,"origin":"user","prompt":"我测试了一下 效果还行，还有这个我输入的新指令冒出了黄色文字。","decode":"先确认黄色文字是什么、为什么出现。","tag":"查黄色文字"}"#,
            #"{"turnId":"t1","at":"2026-09-12T16:21:51.000Z","endedAt":"2026-09-12T16:26:40.000Z","reminded":true,"prompt":"继续吧，接下来怎么做？另外那个档案馆的外联要放进去吗？","decode":"⚠ 先把披露时限文件做掉，然后回答档案馆那条线该放在哪。","tag":"做披露文件"}"#,
            #"{"turnId":"t2","at":"2026-09-12T16:27:54.000Z","endedAt":"2026-09-12T16:28:02.000Z","reminded":false,"prompt":"好的 继续吧","decode":null,"tag":null}"#,
            #"{"turnId":"t2b","at":"2026-09-12T16:29:00.000Z","endedAt":"2026-09-12T16:29:04.000Z","interrupted":false,"reminded":false,"origin":"system","prompt":"<task-notification>\n<task-id>af705</task-id>","decode":null,"tag":null}"#,
            #"{"turnId":"t3","at":"2026-09-12T16:31:10.000Z","endedAt":"2026-09-12T16:33:05.000Z","reminded":true,"prompt":"把这个目录下所有脚本的错误处理过一遍，先不要改。","decode":null,"tag":null}"#,
        ]
        return rows.joined(separator: "\n") + "\n"
    }
}
