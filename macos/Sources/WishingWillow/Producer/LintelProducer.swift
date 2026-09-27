import Foundation

/// 许愿柳的 lintel 来源模式。
///
/// `--lintel-export <lintel 目录> [--fixtures] [--with-registry]`：导出一次就退出。
///   --fixtures：导出演示样例（原先 `--present` 演示用的同一批），给 lintel 比对截图用；否则导出 `WILLOW_STATE_DIR` / `~/.claude/willow` 的真实状态。
///   --with-registry：顺手在那个目录写一份登记。只用于样例目录——真实的 lintel 目录由你运行 `lintel register` 登记，来源程序不给自己登记（lintel spec 5.5）。
@MainActor
enum LintelProducer {
    static func exportOnce(home: URL, fixtures: Bool, withRegistry: Bool) -> Int32 {
        let store = fixtures ? WillowStore(directory: DemoFixtures.directory()) : WillowStore()
        store.reload()
        let dir = home.appendingPathComponent("producers/\(ActivityExport.producerId)/activities", isDirectory: true)
        do {
            if withRegistry { try writeRegistry(home: home) }
            let all = ActivityExport.activities(store)
            for (_, a) in all.sorted(by: { $0.key < $1.key }) { try ActivityExport.write(a, to: dir) }
            print("导出 \(all.count) 份活动 → \(dir.path)")
            return 0
        } catch {
            FileHandle.standardError.write(Data("导出失败：\(error)\n".utf8))
            return 1
        }
    }

    static func writeRegistry(home: URL) throws {
        let url = home.appendingPathComponent("registry.json")
        var reg = (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: Any] ?? ["schema": 1, "producers": [String: Any]()]
        var producers = reg["producers"] as? [String: Any] ?? [:]
        producers[ActivityExport.producerId] = ActivityExport.registration
        reg["producers"] = producers
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try ActivityExport.encode(reg).write(to: url)
    }
}
