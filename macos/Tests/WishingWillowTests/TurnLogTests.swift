import Testing
import Foundation
@testable import WishingWillow

@Suite("轮次日志的用时")
struct TurnLogTests {
    private func entry(_ json: String) throws -> TurnLogEntry {
        try JSONDecoder().decode(TurnLogEntry.self, from: Data(json.utf8))
    }

    @Test("结束早于开始 → 用时按 0，不出负数（10-09 一条斜杠命令记成 −0.19 秒，刘海把整场对话的活动拒收）")
    func endBeforeStart() throws {
        let e = try entry(#"{"at":"2026-10-09T19:24:31.157Z","endedAt":"2026-10-09T19:24:30.968Z","prompt":"/合成命令"}"#)
        // 各轮时长图的柱直接取这个值（ActivityExport 的 "seconds": opt(e.duration)）。
        #expect(e.duration == 0)
    }

    @Test("正常的一轮照常；缺一个时刻仍是取不到")
    func normalAndMissing() throws {
        #expect(try entry(#"{"at":"2026-10-09T19:24:31.000Z","endedAt":"2026-10-09T19:24:42.500Z"}"#).duration == 11.5)
        #expect(try entry(#"{"at":"2026-10-09T19:24:31.000Z"}"#).duration == nil)
    }
}
