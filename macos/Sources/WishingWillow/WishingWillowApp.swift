import AppKit
import SwiftUI

/// 入口。`--snapshot <目录>` 走离屏渲染，不起菜单栏。
@main
enum Main {
    @MainActor
    static func main() {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--snapshot") {
            let out = i + 1 < args.count ? args[i + 1] : "snapshots"
            exit(Snapshot.run(outputDirectory: out))
        }
        // --anatomy <目录>：导出左翼状态的工程标注图（中英各一张），给 README 与设计评审用。
        if let i = args.firstIndex(of: "--anatomy") {
            exit(Anatomy.run(outputDirectory: i + 1 < args.count ? args[i + 1] : "anatomy"))
        }
        // --lintel-export <目录>：作为 lintel 的来源程序导出一次活动文件（见 Producer/LintelProducer.swift）。
        if let i = args.firstIndex(of: "--lintel-export") {
            let out = i + 1 < args.count ? args[i + 1] : "lintel-export"
            exit(LintelProducer.exportOnce(home: URL(fileURLWithPath: out, isDirectory: true),
                                           fixtures: args.contains("--fixtures"), withRegistry: args.contains("--with-registry")))
        }
        if let i = args.firstIndex(of: "--selfshot") {
            SelfShot.run(outputDirectory: i + 1 < args.count ? args[i + 1] : "selfshots")
            return
        }
        // --present <秒>：正常启动、状态项放上真实菜单栏、弹出面板停留几秒后退出。
        // 这是给 screencapture 拍 WindowServer 那一层用的 —— 离屏渲染会吞控件，
        // cacheDisplay 拍不到玻璃与外观，只有真的摆在屏幕上才是用户看到的样子。
        if let i = args.firstIndex(of: "--present") {
            PresentDemo.seconds = i + 1 < args.count ? (Double(args[i + 1]) ?? 6) : 6
            // --real：用本机真实状态而不是样例。截图只留在本地，不进公开仓。
            PresentDemo.real = args.contains("--real")
            PresentDemo.passive = args.contains("--passive")
        }
        // 来源模式（lintel 分支的默认）：不画刘海，只把会话写成 lintel 活动。要许愿柳自己画刘海，加 --island（或演示 --present）。
        if !args.contains("--island") && PresentDemo.seconds == nil {
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            let env = ProcessInfo.processInfo.environment
            let home = env["LINTEL_HOME"].map { URL(fileURLWithPath: $0, isDirectory: true) }
                ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!.appendingPathComponent("lintel", isDirectory: true)
            let loop = ProducerLoop(store: WillowStore(), home: home, log: args.contains("--producer-log"))
            loop.start()
            withExtendedLifetime(loop) { app.run() }
            return
        }
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}

enum PresentDemo {
    nonisolated(unsafe) static var seconds: Double? = nil
    nonisolated(unsafe) static var real = false
    /// --passive：不强制展开、不屏蔽事件——验证「声明到达就展开」这类要按真实事件发生的行为。
    nonisolated(unsafe) static var passive = false
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let store = (PresentDemo.seconds == nil || PresentDemo.real)
        ? WillowStore()
        : WillowStore(directory: SelfShot.fixtureDirectoryForDemo())
    private var island: IslandController?
    private var backdrop: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 样例演示用不落盘的已读记录：先前演示把样例会话标成已读写进了真实的 seen.json，
        // 之后拍收起态时两翼全缩回刘海——拍到的是上一次演示留下的状态。
        // 录 README 素材（--backdrop）虽然读的是 WILLOW_STATE_DIR 里的虚构会话，打开面板会把它们标成已读——不能写进真实的 seen.json。
        let demo = PresentDemo.seconds != nil && (!PresentDemo.real || Backdrop.isOn)
        backdrop = Backdrop.show()
        let c = IslandController(store: store, seen: demo ? SeenStore(ephemeral: true) : SeenStore())
        island = c
        c.start()

        if let hold = PresentDemo.seconds {
            // 前一半停在收起态，后一半展开 —— 两个状态各拍一张。
            if !PresentDemo.passive {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5 + hold / 2) {
                    if CommandLine.arguments.contains("--detail") {
                        c.presentDetail()
                    } else if CommandLine.arguments.contains("--flash") {
                        // --flash：像写出理解那一刻一样主动弹出精简版；加 --flash-hover 时 2 秒后模拟鼠标停上去，长成完整面板。
                        c.presentFlash()
                        if CommandLine.arguments.contains("--flash-hover") {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { c.presentHover(true) }
                        }
                    } else if !CommandLine.arguments.contains("--pill-cycle") && !CommandLine.arguments.contains("--hover-cycle")
                                && !CommandLine.arguments.contains("--dodge-cycle") {
                        c.presentExpanded()
                    }
                }
                // --expand-then-detail：先展开，1.6 秒后再打开面板——走用户真实的「悬停展开 → 点击」路径，
                // 录「展开态换成面板」那一段过渡（用户报过文字叠加）。
                if CommandLine.arguments.contains("--expand-then-detail") {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5 + hold / 2 + 1.6) { c.presentDetail() }
                }
                // --pill-cycle：展开（胶囊吸回岛里）→ 收起（胶囊滴出去）→ 胶囊悬停预览 → 离开 → 岛悬停鼓起 → 复原。
                // 录第二个会话胶囊的出场、收回与悬停动效。
                // --hover-cycle：走真实悬停路径——先鼓一下、0.3 秒后展开；2.5 秒后移开收起。录胶囊并入悬停面板的动效。
                if CommandLine.arguments.contains("--hover-cycle") {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) { c.presentHover(true) }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 6.0) { c.presentHover(false) }
                }
                // --dodge-cycle：让路 → 复原。录「菜单栏滑出来时灵动岛往下让」的样子，不依赖真鼠标。
                if CommandLine.arguments.contains("--dodge-cycle") {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) { c.presentDodge(true) }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 6.0) { c.presentDodge(false) }
                }
                // --flip-cycle：展开后每 2.5 秒翻到下一个在跑的会话（悬停面板底部那一行）。
                // 配 --real --backdrop 逐个拍每个会话的悬停面板，查同一块面板在不同会话、不同状态下长得不一样的地方。
                if CommandLine.arguments.contains("--flip-cycle") {
                    for k in 1...8 {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5 + hold / 2 + 2.5 * Double(k)) { c.presentFlip() }
                    }
                }
                if CommandLine.arguments.contains("--pill-cycle") {
                    let t0 = 3.5
                    DispatchQueue.main.asyncAfter(deadline: .now() + t0) { c.presentExpanded() }
                    DispatchQueue.main.asyncAfter(deadline: .now() + t0 + 2.0) { c.presentCollapse() }
                    DispatchQueue.main.asyncAfter(deadline: .now() + t0 + 4.0) { c.presentPillHover(true) }
                    DispatchQueue.main.asyncAfter(deadline: .now() + t0 + 5.5) { c.presentPillHover(false) }
                    DispatchQueue.main.asyncAfter(deadline: .now() + t0 + 6.5) { c.presentHoverBump(true) }
                    DispatchQueue.main.asyncAfter(deadline: .now() + t0 + 7.5) { c.presentHoverBump(false) }
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5 + hold) {
                NSApp.terminate(nil)
            }
        }
    }
}
