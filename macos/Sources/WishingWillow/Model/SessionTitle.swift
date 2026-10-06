import Foundation

/// 这场对话的名字：Claude 桌面端起的标题，会话记录里的 `custom-title` 行（每轮重写一次，取最后一条）。
/// 09-27 grill 4：侧栏里的对话名原是最近一轮的标签，每轮都变，说的是这一轮在干什么，不是这场对话是什么。
/// 读不到就是 nil，lintel 退回标签——不自己编名字。
enum SessionTitle {
    /// 只读文件末尾这么多字节：标题每轮都重写，最后一条总在末尾附近。
    static let tailBytes = 512 * 1024

    static func read(path: String) -> String? {
        guard let h = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? h.close() }
        guard let size = try? h.seekToEnd() else { return nil }
        let start = size > UInt64(tailBytes) ? size - UInt64(tailBytes) : 0
        try? h.seek(toOffset: start)
        guard let data = try? h.readToEnd() else { return nil }
        return latest(in: String(decoding: data, as: UTF8.self))
    }

    /// 从一段 JSONL 里找最后一条 custom-title。第一行可能被截断，读不成 JSON 的行跳过。
    static func latest(in text: String) -> String? {
        for line in text.split(separator: "\n").reversed() where line.contains("\"custom-title\"") {
            guard let o = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  o["type"] as? String == "custom-title",
                  let t = (o["customTitle"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { continue }
            return t
        }
        return nil
    }
}

/// 按文件大小缓存：记录没长就不重读（导出每几秒一次）。
@MainActor
final class SessionTitleCache {
    static let shared = SessionTitleCache()
    private var cache: [String: (size: Int64, title: String?)] = [:]

    func title(path: String?) -> String? {
        guard let path else { return nil }
        let size = FileStamp.of(path)?.size ?? 0
        if let c = cache[path], c.size == size { return c.title }
        let t = SessionTitle.read(path: path)
        cache[path] = (size, t)
        return t
    }
}
