import Testing
import Foundation
@testable import WishingWillow

/// 轻计划 D5：有计划卡在跑时，刘海上那个标签写「K1 3/5 · 等 CI」——第几张卡、做完几步、现在卡在哪。
@Suite("刘海：计划卡的进度")
@MainActor
struct CardProgressTests {
    private func item(_ id: String, _ text: String, _ status: String, wait: String? = nil) -> ListSnapshot.Item {
        .init(id: id, text: text, status: status, wait: wait, basis: nil, evidence: nil, approved: false, touched: nil)
    }

    @Test("做完几步、现在那步在等什么；卡外的项不算")
    func progress() {
        let xs = [item("L1", "K1·① 推送分支", "做完"), item("L2", "K1·② 合进主干", "等", wait: "CI"),
                  item("L3", "K1·③ 装到本机", "以后"), item("L4", "别的事", "在做")]
        #expect(ActivityExport.cardProgress(xs) == "K1 1/3 · 等 CI")
    }

    @Test("没有卡、卡都做完了：没有进度，标签照旧")
    func none() {
        #expect(ActivityExport.cardProgress([item("L1", "别的事", "在做")]) == nil)
        #expect(ActivityExport.cardProgress([item("L1", "K1·① 推送", "做完"), item("L2", "K1·② 合并", "做完")]) == nil)
    }

    @Test("两张卡取还开着的那张里编号最大的；撤掉的步不算进总数")
    func latestOpenCard() {
        let xs = [item("L1", "K1·① 甲", "做完"), item("L2", "K2·① 乙", "做完"), item("L3", "K2·② 丙", "撤掉"),
                  item("L4", "K2·③ 丁", "在做")]
        #expect(ActivityExport.cardProgress(xs) == "K2 1/2 · 在做")
    }

    @Test("现在那一步按卡上的编号取，不按清单顺序；等你、待做各有写法")
    func currentStep() {
        let xs = [item("L1", "K3·② 合并", "以后"), item("L2", "K3·① 你跑命令", "等你")]
        #expect(ActivityExport.cardProgress(xs) == "K3 0/2 · 等你")
        #expect(ActivityExport.cardProgress([item("L1", "K4·① 推送", "以后")]) == "K4 0/1 · 待做")
    }

    @Test("等的东西太长就截短，标签放得进刘海")
    func longWait() {
        let xs = [item("L1", "K1·① 量写出率", "等", wait: "真实使用满四十个轮次再说")]
        #expect(ActivityExport.cardProgress(xs) == "K1 0/1 · 等 真实使用满四十个…")
    }
}
