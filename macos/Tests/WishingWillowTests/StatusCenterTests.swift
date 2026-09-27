import Testing
import Foundation
@testable import WishingWillow

/// 左翼圆心放哪个状态：导出写进活动的 `status.center` 由它定（圆心按用户 2026-09-13 选的方案随状态换符号）。
/// 原在 DuoGlyphTests；2026-09-19 界面移除后，画法与几何的两条测试移植到 lintel，这一条测的是导出逻辑，留在这里。
@MainActor
@Suite("圆心状态")
struct StatusCenterTests {
    init() { Lang.current = .zh }

    private func state(_ json: String, interruptedAt: Date? = nil) throws -> SessionState {
        SessionState(record: try JSONDecoder().decode(WillowRecord.self, from: Data(json.utf8)), now: .now,
                     liveInterruptedAt: interruptedAt)
    }

    private let base = #""schema":9,"sessionId":"s","cwd":"/x/a","turnId":"t1","origin":"user","promptField":"prompt""#

    @Test("圆心：在跑=扇形；等你选=问号；写了理解=对勾；自标不一致或问了没写=感叹号(橙)；读不到=感叹号(红)；撤回=回退；没问=横线")
    func centerSymbol() throws {
        let running = try state("{\(base),\"prompt\":\"一句够长的请求\",\"reminded\":true,\"decode\":null,\"turnEndedAt\":null}")
        #expect(StatusCenter.of(running, progress: nil, withdrawn: false) == .live)

        var waiting = TurnProgress()
        waiting.pendingChoice = TurnProgress.Choice(id: "q", kind: .question, at: .now, header: nil, question: nil, options: [], count: 1)
        #expect(StatusCenter.of(running, progress: waiting, withdrawn: false) == .waiting)
        #expect(StatusCenter.of(running, progress: nil, withdrawn: true) == .withdrawn)

        let declared = try state("{\(base),\"prompt\":\"一句够长的请求\",\"reminded\":true,\"decode\":\"读成了\",\"turnEndedAt\":\"2026-09-13T01:00:00.000Z\"}")
        #expect(StatusCenter.of(declared, progress: nil, withdrawn: false) == .done)

        let flagged = try state("{\(base),\"prompt\":\"一句够长的请求\",\"reminded\":true,\"decode\":\"⚠ 读偏了\",\"turnEndedAt\":\"2026-09-13T01:00:00.000Z\"}")
        #expect(StatusCenter.of(flagged, progress: nil, withdrawn: false) == .flagged)

        let silent = try state("{\(base),\"prompt\":\"一句够长的请求\",\"reminded\":true,\"decode\":null,\"turnEndedAt\":\"2026-09-13T01:00:00.000Z\"}")
        #expect(StatusCenter.of(silent, progress: nil, withdrawn: false) == .flagged)

        let notAsked = try state("{\(base),\"prompt\":\"好的\",\"reminded\":false,\"decode\":null,\"turnEndedAt\":\"2026-09-13T01:00:00.000Z\"}")
        #expect(StatusCenter.of(notAsked, progress: nil, withdrawn: false) == .idle)

        let broken = try state(#"{"schema":9,"sessionId":"s","cwd":"/x/a","turnId":"t1","prompt":null,"promptField":null}"#)
        #expect(broken.declaration == .unreadable)
        #expect(StatusCenter.of(broken, progress: nil, withdrawn: false) == .broken)

        let interrupted = try state("{\(base),\"prompt\":\"一句够长的请求\",\"reminded\":true,\"decode\":null,\"turnEndedAt\":null}",
                                    interruptedAt: .now)
        #expect(StatusCenter.of(interrupted, progress: nil, withdrawn: false) == .withdrawn)
    }
}
