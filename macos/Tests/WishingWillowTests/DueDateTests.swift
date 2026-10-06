import Testing
import Foundation
@testable import WishingWillow

/// 标题里的日期离今天几天（ops-private spec 2026-10-06「刘海上露出到了日子的项」D2）。
/// 用例和插件共用一份 `tests/list/dated-cases.json`：插件的 `datedDays` 与这里必须逐条算出一样的天数。
@MainActor
@Suite("到了日子：标题里的日期")
struct DueDateTests {
    init() { Lang.current = .zh }

    struct Case: Decodable {
        var name: String
        var text: String
        var today: String
        var days: Int?
    }

    static func shared() throws -> [Case] {
        // 本文件在 macos/Tests/WishingWillowTests/，用例在仓库根的 tests/list/。
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("tests/list/dated-cases.json")
        return try JSONDecoder().decode([Case].self, from: Data(contentsOf: url))
    }

    @Test("和插件共用的用例逐条一样（同一个标题、同一个今天）")
    func sharedCases() throws {
        let cases = try Self.shared()
        #expect(cases.count >= 30, "用例文件读到了")
        for c in cases {
            #expect(DueDate.days(c.text, today: c.today) == c.days, "\(c.name)：\(c.text)")
        }
    }

    @Test("今天传 Date：按给的日历取年月日，不按 UTC")
    func todayFromDate() throws {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = try #require(TimeZone(identifier: "Asia/Shanghai"))
        // 上海 10 月 6 日早上 7 点 = UTC 10 月 5 日 23 点：按 UTC 会差一天。
        let d = try #require(cal.date(from: DateComponents(year: 2026, month: 10, day: 6, hour: 7)))
        #expect(DueDate.days("合成回执，对方 10-06 回", today: d, calendar: cal) == 0)
        #expect(DueDate.days("合成事项没写日子", today: d, calendar: cal) == nil)
    }

    @Test("天数怎么写：已过、今天、还有（那一行 spec D7 的写法）")
    func wording() {
        #expect(DueDate.text(-18) == "已过 18 天")
        #expect(DueDate.text(0) == "今天")
        #expect(DueDate.text(9) == "还有 9 天")
        Lang.current = .en
        defer { Lang.current = .zh }
        #expect(DueDate.text(-18) == "18 days ago")
        #expect(DueDate.text(-1) == "1 day ago")
        #expect(DueDate.text(0) == "today")
        #expect(DueDate.text(1) == "in 1 day")
        #expect(DueDate.text(9) == "in 9 days")
    }
}
