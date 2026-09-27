import AppKit
import Foundation

/// 来源模式常驻进程：照旧读 `~/.claude/willow/` 与会话记录（WillowStore 一行不改），每次有变化就把全部会话重新导出，
/// 只写内容真的变了的文件；进行中的一轮每 30 秒重写一次，给 lintel 的心跳（活动里声明 60 秒，超过 90 秒没写 lintel 显示异常）。
/// 不画任何界面：刘海由 lintel 画，两边不同时画刘海（lintel plan 4.2）。
@MainActor
final class ProducerLoop {
    private let store: WillowStore
    private let dir: URL
    private var heartbeat: Timer?
    private var written: Set<String> = []
    /// 演示与测量用：每次写出文件记一行（时刻 + 活动 id + 事件 id），不写原话。
    private let log: Bool

    init(store: WillowStore, home: URL, log: Bool) {
        self.store = store
        self.dir = home.appendingPathComponent("producers/\(ActivityExport.producerId)/activities", isDirectory: true)
        self.log = log
    }

    func start() {
        store.onReload = { [weak self] in self?.export(reason: "reload") }
        store.onLiveChange = { [weak self] in self?.export(reason: "live") }
        store.onDeclarationArrived = { [weak self] _ in self?.export(reason: "declaration") }
        store.onChoiceArrived = { [weak self] _ in self?.export(reason: "choice") }
        store.onWithdraw = { [weak self] _, _ in self?.export(reason: "withdraw") }
        store.start()
        export(reason: "start")
        let t = Timer(timeInterval: 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.export(reason: "heartbeat", heartbeat: true) }
        }
        t.tolerance = 2
        RunLoop.main.add(t, forMode: .common)
        heartbeat = t
    }

    private func export(reason: String, heartbeat: Bool = false) {
        let all = ActivityExport.activities(store)
        var changed: [String] = []
        for (id, a) in all.sorted(by: { $0.key < $1.key }) {
            let force = heartbeat && (a["inProgress"] as? Bool) == true
            do {
                if try ActivityExport.write(a, to: dir, force: force) { changed.append(id) }
            } catch {
                FileHandle.standardError.write(Data("\(Self.stamp()) 写不进 \(dir.path)：\(error)\n".utf8))
            }
        }
        // 状态文件已经不在的会话：它的活动文件是本进程生成的，跟着移走（放进同目录的 .gone/，不直接删）。
        let present = Set(all.keys)
        if let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) {
            for name in names where name.hasSuffix(".json") && !present.contains(String(name.dropLast(5))) && written.contains(String(name.dropLast(5))) {
                let gone = dir.appendingPathComponent(".gone", isDirectory: true)
                try? FileManager.default.createDirectory(at: gone, withIntermediateDirectories: true)
                try? FileManager.default.moveItem(at: dir.appendingPathComponent(name), to: gone.appendingPathComponent("\(Int(Date().timeIntervalSince1970))-\(name)"))
            }
        }
        written.formUnion(present)
        if log, !changed.isEmpty {
            let events = changed.compactMap { all[$0]?["events"] as? [[String: Any]] }.flatMap { $0 }.compactMap { $0["id"] as? String }
            FileHandle.standardError.write(Data("\(Self.stamp()) wrote reason=\(reason) n=\(changed.count) events=\(events.joined(separator: ","))\n".utf8))
        }
    }

    static func stamp() -> String { Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(Date()) }
}
