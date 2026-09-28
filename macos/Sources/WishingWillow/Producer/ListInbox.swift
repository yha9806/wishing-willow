import Foundation

/// 作者在 lintel 面板里对清单项点的动作（09-28 spec「清单实时」C）。
///
/// 导出时给每个开着的项附上动作（第一个是面板上的复选框）：做完、撤掉、挪到以后。作者点了，lintel 把动作 id 原样写进
/// `<lintel>/producers/willow/inbox/<uuid>.json`（`kind: action`，`activity` = 会话号）。常驻进程每秒读一次：
/// 只收本来源的会话、认得的动作、项还开着的；执行 = 调插件的 `listctl --by author` 写一行，快照记 via = author，
/// 下一轮插件告诉 Claude「你在面板里改了」。处理过的挪进 `inbox/done/`，旁边写结果；不执行的写明理由。
enum ListInbox {
    enum Verb: String, CaseIterable { case done, drop, later }

    /// 导出到活动里的动作：`L3|done` 这样的 id，标题按界面语言。
    static func actions(item: String, state: String) -> [[String: String]] {
        var out = [["id": "\(item)|done", "title": L("做完", "Done")], ["id": "\(item)|drop", "title": L("撤掉", "Drop")]]
        if state != "later" { out.append(["id": "\(item)|later", "title": L("挪到以后", "Move to later")]) }
        return out
    }

    static func parse(action: String) -> (item: String, verb: Verb)? {
        let p = action.split(separator: "|", omittingEmptySubsequences: false)
        guard p.count == 2, let v = Verb(rawValue: String(p[1])),
              p[0].range(of: #"^L\d+$"#, options: .regularExpression) != nil else { return nil }
        return (String(p[0]), v)
    }

    /// 写进清单的那一行（插件 parseOps 认的写法；中文关键词两种界面语言都认）。
    static func line(item: String, verb: Verb) -> String {
        switch verb {
        case .done: return "\(item) 做完：作者在面板里勾掉"
        case .drop: return "\(item) 撤掉：作者在面板里撤掉"
        case .later: return "\(item) → 以后：作者在面板里挪到以后"
        }
    }

    enum Decision: Equatable {
        case run(session: String, line: String)
        case refuse(String)
    }

    /// 收不收、写哪一行。`items` 是那场会话清单的最后一份快照；nil = 没有清单或读不出。
    static func decide(_ msg: [String: Any], items: [ListSnapshot.Item]?) -> Decision {
        guard msg["kind"] as? String == "action" else { return .refuse("不是面板动作") }
        guard let session = msg["activity"] as? String, session.range(of: #"^[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil
        else { return .refuse("没有会话号") }
        guard let raw = msg["action"] as? String, let (item, verb) = parse(action: raw) else { return .refuse("认不出的动作") }
        guard let items else { return .refuse("这场会话没有清单或读不出") }
        guard let x = items.first(where: { $0.id == item }) else { return .refuse("清单里没有 \(item)") }
        guard x.status != "做完" && x.status != "撤掉" else { return .refuse("\(item) 已经关了（\(x.status)）") }
        if verb == .later && x.status == "以后" { return .refuse("\(item) 本来就是以后") }
        return .run(session: session, line: line(item: item, verb: verb))
    }

    /// 插件的 listctl：先看环境变量（测试用），再找插件缓存里最新的一版。
    static func listctl() -> URL? {
        if let o = ProcessInfo.processInfo.environment["WILLOW_LISTCTL"], !o.isEmpty { return URL(fileURLWithPath: o) }
        let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/plugins/cache/wishing-willow/willow")
        let versions = (try? FileManager.default.contentsOfDirectory(atPath: root.path))?.sorted() ?? []
        for v in versions.reversed() {
            let u = root.appendingPathComponent(v).appendingPathComponent("hooks/listctl.mjs")
            if FileManager.default.fileExists(atPath: u.path) { return u }
        }
        return nil
    }

    /// node：登录项启动时 PATH 很短，先试常见位置。
    static func node() -> URL? {
        if let o = ProcessInfo.processInfo.environment["WILLOW_NODE"], !o.isEmpty { return URL(fileURLWithPath: o) }
        return ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].map(URL.init(fileURLWithPath:))
            .first { FileManager.default.isExecutableFile(atPath: $0.path) }
    }

    /// 读一遍收件，逐个处理。返回处理了几个（测试与日志用）。
    @discardableResult
    static func drain(inbox: URL, stateDir: URL, log: ((String) -> Void)? = nil) -> Int {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: inbox.path) else { return 0 }
        var n = 0
        for name in names.sorted() where name.hasSuffix(".json") && !name.hasPrefix(".") {
            let url = inbox.appendingPathComponent(name)
            let msg = (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            let session = msg["activity"] as? String
            var items: [ListSnapshot.Item]? = nil
            if let session, case .snapshot(let s) = ConversationList.read(sessionId: session, directory: stateDir) { items = s.items }
            var result: [String: Any] = ["at": ISO8601DateFormatter().string(from: Date()), "action": msg["action"] ?? NSNull()]
            switch decide(msg, items: items) {
            case .refuse(let why):
                result["ok"] = false; result["reason"] = why
            case .run(let session, let line):
                let r = run(session: session, line: line, stateDir: stateDir)
                result["ok"] = r.ok; result["line"] = line; result["output"] = r.output
            }
            log?("inbox \(name) → \(result["ok"] as? Bool == true ? "ok" : "refused") \(result["reason"] ?? result["line"] ?? "")")
            let done = inbox.appendingPathComponent("done", isDirectory: true)
            try? fm.createDirectory(at: done, withIntermediateDirectories: true)
            try? fm.moveItem(at: url, to: done.appendingPathComponent(name))
            if let d = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys, .prettyPrinted]) {
                try? d.write(to: done.appendingPathComponent(String(name.dropLast(5)) + ".result.json"))
            }
            n += 1
        }
        return n
    }

    static func run(session: String, line: String, stateDir: URL) -> (ok: Bool, output: String) {
        guard let node = node(), let script = listctl() else { return (false, "找不到 node 或插件的 listctl") }
        let p = Process()
        p.executableURL = node
        p.arguments = [script.path, "--session", session, "--by", "author", line]
        var env = ProcessInfo.processInfo.environment
        env["WILLOW_STATE_DIR"] = stateDir.path
        p.environment = env
        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        do { try p.run() } catch { return (false, "起不了 listctl：\(error)") }
        p.waitUntilExit()
        let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (p.terminationStatus == 0, String(text.prefix(400)))
    }
}
