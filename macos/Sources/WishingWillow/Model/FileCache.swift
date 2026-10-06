import Foundation

/// 按「文件大小 + 修改时间」缓存读一个文件得到的结果（K10 功耗，2026-10-01）。
///
/// 来源进程每次导出都把每个会话的清单和轮次日志整份重读、逐行切开：真实目录上 40 个会话，导出一次约 0.8 秒，
/// 而重载每几秒就来一次（一个会话的清单就有 4.6 MB）。实测这个进程占单核约一半。文件没变就用上一次的结果；
/// 只缓存「读文件」这一步，按时间算的东西（陈旧、计时）照旧每次重算。读不到属性的文件不缓存，照常读。
final class FileCache<Value>: @unchecked Sendable {
    private struct Entry {
        let stamp: FileStamp
        let value: Value
    }

    private var entries: [String: Entry] = [:]
    private let lock = NSLock()

    func value(at url: URL, load: (URL) -> Value) -> Value {
        let stamp = FileStamp.of(url.path)
        if let stamp {
            lock.lock()
            let hit = entries[url.path]
            lock.unlock()
            if let hit, hit.stamp == stamp { return hit.value }
        }
        let v = load(url)
        if let stamp {
            lock.lock()
            entries[url.path] = Entry(stamp: stamp, value: v)
            lock.unlock()
        }
        return v
    }
}

/// 文件的大小 + 修改时间（秒、纳秒），用一次 lstat 取。
///
/// 先前到处用 FileManager.attributesOfItem，它还会把扩展属性逐个读出来（listxattr + getxattr）：
/// 2026-10-06 采样，来源进程的系统调用里这两样排在读文件前面（K10 第二轮）。与 attributesOfItem 一样不跟符号链接。
struct FileStamp: Equatable, Sendable {
    let size: Int64
    let sec: Int
    let nsec: Int

    /// 换算次序照 Foundation 的 attributesOfItem（先换到 2001 纪元再加纳秒）：换个次序浮点舍入不同，
    /// 导出的毫秒会差 1（2026-10-06 改前改后对照，119 份里 2 份因此不一致）。
    var modified: Date {
        Date(timeIntervalSinceReferenceDate: (TimeInterval(sec) - Date.timeIntervalBetween1970AndReferenceDate) + TimeInterval(nsec) / 1_000_000_000.0)
    }

    static func of(_ path: String) -> FileStamp? {
        var st = stat()
        guard lstat(path, &st) == 0 else { return nil }
        return FileStamp(size: Int64(st.st_size), sec: st.st_mtimespec.tv_sec, nsec: st.st_mtimespec.tv_nsec)
    }
}
