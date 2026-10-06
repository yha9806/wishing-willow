import Testing
import Foundation
@testable import WishingWillow

/// 导出一次要多久（K10 功耗）：只在设了 WILLOW_BENCH_DIR 时跑，读那个目录、不写任何东西。
/// 用法：WILLOW_BENCH_DIR=~/.claude/willow swift test -c release --filter ExportCostBench
@Suite("导出开销（只在设了 WILLOW_BENCH_DIR 时跑）")
@MainActor
struct ExportCostBench {
    @Test("同一份状态目录上连续导出，报每次的毫秒数")
    func exportCost() {
        guard let dir = ProcessInfo.processInfo.environment["WILLOW_BENCH_DIR"] else { return }
        let store = WillowStore(directory: URL(fileURLWithPath: (dir as NSString).expandingTildeInPath, isDirectory: true))
        store.reload()
        _ = ActivityExport.activities(store)   // 预热
        let runs = 20
        let t0 = Date()
        for _ in 0..<runs { _ = ActivityExport.activities(store) }
        let ms = Date().timeIntervalSince(t0) * 1000 / Double(runs)
        // 重载（目录监视每次触发都跑一遍）：同一份目录、文件没变时的耗时。
        let t1 = Date()
        for _ in 0..<runs { store.reload() }
        let reloadMs = Date().timeIntervalSince(t1) * 1000 / Double(runs)
        print(String(format: "BENCH sessions=%d export_ms=%.1f reload_ms=%.1f", store.sessions.count, ms, reloadMs))
        #expect(store.sessions.count > 0)
    }
}
