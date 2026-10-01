import Foundation

/// 按「文件大小 + 修改时间」缓存读一个文件得到的结果（K10 功耗，2026-10-01）。
///
/// 来源进程每次导出都把每个会话的清单和轮次日志整份重读、逐行切开：真实目录上 40 个会话，导出一次约 0.8 秒，
/// 而重载每几秒就来一次（一个会话的清单就有 4.6 MB）。实测这个进程占单核约一半。文件没变就用上一次的结果；
/// 只缓存「读文件」这一步，按时间算的东西（陈旧、计时）照旧每次重算。读不到属性的文件不缓存，照常读。
final class FileCache<Value>: @unchecked Sendable {
    private struct Entry {
        let size: UInt64
        let mtime: Date
        let value: Value
    }

    private var entries: [String: Entry] = [:]
    private let lock = NSLock()

    func value(at url: URL, load: (URL) -> Value) -> Value {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attrs?[.size] as? NSNumber)?.uint64Value
        let mtime = attrs?[.modificationDate] as? Date
        if let size, let mtime {
            lock.lock()
            let hit = entries[url.path]
            lock.unlock()
            if let hit, hit.size == size, hit.mtime == mtime { return hit.value }
        }
        let v = load(url)
        if let size, let mtime {
            lock.lock()
            entries[url.path] = Entry(size: size, mtime: mtime, value: v)
            lock.unlock()
        }
        return v
    }
}
