import Testing
import Foundation
@testable import WishingWillow

/// 09-27：一场会话贴了三四万字的原话，body 与 popup 的 text 超过 lintel 的正文上限 20000，整份活动被拒收，
/// 这场会话从刘海上消失。写盘前统一截短，末尾写明原来多长。
@MainActor
@Suite("导出：超长原话截短，不让整份活动被拒")
struct LongTextTests {
    init() { Lang.current = .zh }

    private let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    /// lintel 的正文上限（Validation.Limit.line）。写成本地常量，这条测试在改之前的代码上也编译得过、能验红。
    private let limit = 20_000

    private func strings(_ v: Any) -> [String] {
        switch v {
        case let s as String: return [s]
        case let d as [String: Any]: return d.values.flatMap(strings)
        case let a as [Any]: return a.flatMap(strings)
        default: return []
        }
    }

    @Test("写出的文件里每个字符串都不超过 20000 字；截过的末尾写明原长；短的原样不动")
    func longPromptFits() throws {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("willow-long-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        let prompt = String(repeating: "合成的长原话。", count: 5_000)   // 35000 字
        let obj: [String: Any] = ["schema": 13, "sessionId": "s", "pid": Int(ProcessInfo.processInfo.processIdentifier), "cwd": "/x/w",
                                  "turnId": "t1", "updatedAt": iso.format(Date()), "prompt": prompt, "promptField": "prompt",
                                  "origin": "user", "reminded": true, "decode": "读成了一句", "tag": "读长原话",
                                  "turnEndedAt": iso.format(Date())]
        try JSONSerialization.data(withJSONObject: obj).write(to: d.appendingPathComponent("s.json"))
        let store = WillowStore(directory: d)
        store.reload()
        let acts = ActivityExport.activities(store)
        let a = try #require(acts.values.first)
        #expect(strings(a).contains { $0.count > limit }, "夹具要真的造出超长字段，不然这条测不到东西")

        let out = d.appendingPathComponent("out")
        try ActivityExport.write(a, to: out)
        let file = try #require(try FileManager.default.contentsOfDirectory(at: out, includingPropertiesForKeys: nil).first { $0.pathExtension == "json" })
        let back = try JSONSerialization.jsonObject(with: Data(contentsOf: file))
        let all = strings(back)
        #expect(all.allSatisfy { $0.count <= limit }, "最长 \(all.map(\.count).max() ?? 0)")
        #expect(all.contains { $0.hasSuffix("（原文 35000 字，截到这里）") })
        #expect(all.contains("读成了一句"))
    }
}
