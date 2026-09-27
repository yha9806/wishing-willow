import AppKit

/// 入口：许愿柳的 lintel 来源模式。刘海由 lintel 画，这里只读会话、把它们写成 lintel 活动。
///
/// 2026-09-19 清理：这条分支不再带自己画刘海与菜单栏的界面（原 `--island`、`--present`、`--snapshot`、`--anatomy`、`--selfshot`）。
/// 那一套仍在公开仓 main 上，是 lintel 试用的退路（`tools/trial.sh stop` 打开的就是它）。
/// 「刘海上写什么」的规则搬到了 `Wording/`，导出结果与清理前逐字节一致（见提交说明）。
@main
enum Main {
    @MainActor
    static func main() {
        let args = CommandLine.arguments
        // --lintel-export <目录> [--fixtures] [--with-registry]：导出一次就退出（见 Producer/LintelProducer.swift）。
        if let i = args.firstIndex(of: "--lintel-export") {
            let out = i + 1 < args.count ? args[i + 1] : "lintel-export"
            exit(LintelProducer.exportOnce(home: URL(fileURLWithPath: out, isDirectory: true),
                                           fixtures: args.contains("--fixtures"), withRegistry: args.contains("--with-registry")))
        }
        let env = ProcessInfo.processInfo.environment
        let home = env["LINTEL_HOME"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!.appendingPathComponent("lintel", isDirectory: true)
        // --lintel-register：把许愿柳的登记（事件类型、名字、名词）写进 lintel 的登记表，然后退出。由你运行（`make register`），
        // 常驻进程自己不写登记。和 `lintel register` 等价，但一次带全所有事件类型——手敲漏一个，那种事件一来整份活动就被拒收。
        if args.contains("--lintel-register") {
            do {
                try LintelProducer.writeRegistry(home: home)
                print(L("登记了", "Registered") + " \(ActivityExport.producerId) → \(home.appendingPathComponent("registry.json").path)")
                exit(0)
            } catch {
                FileHandle.standardError.write(Data((L("登记失败：", "Registration failed: ") + "\(error)\n").utf8))
                exit(1)
            }
        }
        // 常驻：照旧读 ~/.claude/willow 与会话记录，有变化就把会话重新导出成活动文件。
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let loop = ProducerLoop(store: WillowStore(), home: home, log: args.contains("--producer-log"))
        loop.start()
        withExtendedLifetime(loop) { app.run() }
    }
}
