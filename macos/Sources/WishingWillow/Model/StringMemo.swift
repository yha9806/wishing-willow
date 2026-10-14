import Foundation

/// 字符串到字符串的纯函数结果缓存（K11 功耗，2026-10-14）。
///
/// 只给「同一个输入永远得到同一个输出」的函数用。条数到上限就整个清掉重来：会话里的原话与清单会一直增加，
/// 不清就只增不减；清掉的代价只是下一次导出重算一遍。
final class StringMemo: @unchecked Sendable {
    private var entries: [String: String] = [:]
    private let lock = NSLock()
    private let limit: Int

    init(limit: Int = 4096) { self.limit = limit }

    func value(_ key: String, compute: (String) -> String) -> String {
        lock.lock()
        let hit = entries[key]
        lock.unlock()
        if let hit { return hit }
        let v = compute(key)
        lock.lock()
        if entries.count >= limit { entries.removeAll(keepingCapacity: true) }
        entries[key] = v
        lock.unlock()
        return v
    }
}
