import Foundation

/// 清单标题里的日期离今天几天（ops-private spec 2026-10-06「刘海上露出到了日子的项」D2）。
/// 规则照插件 `plugin/hooks/_list.mjs` 的 `datedDays`（那一行 spec D2–D5），两边读同一份用例 `tests/list/dated-cases.json`，
/// 哪边改了规则另一边就红。日期每次从标题现算，不进清单数据：没写年份的按「离今天最近」解，冻在写快照那天会和那一行算出不同的年份。
///
/// 照 JS 的写法逐条搬：数字写 `[0-9]`（JS 的 `\d` 只认半角，ICU 的 `\d` 连全角数字也认）；空白写 `ws`（JS 的 `\s` 比 ICU 多 \v 与 ﻿）；
/// 位置按 UTF-16 算（NSString），遮住带年份的那段时补同样长的空格，和 JS 的 `' '.repeat(x.length)` 一样长。
enum DueDate {
    /// 14 天内到的、或已经过了的，算「到了日子」（那一行 spec D1）。
    static let window = 14

    private static let ws = "[\\t\\n\\x{0B}\\f\\r\\p{Z}\\x{FEFF}]"
    private static func re(_ p: String, _ o: NSRegularExpression.Options = []) -> NSRegularExpression {
        try! NSRegularExpression(pattern: p, options: o)
    }
    /// 「（依据：…」起到末尾是依据，不当标题里的日期。
    private static let basisTail = re("[（(]\(ws)*(?:依据|basis)\(ws)*[：:][\\s\\S]*$", .caseInsensitive)
    /// 带年份的：2027-07-31、2027 年 7 月 31 日、2026 年 10 月底。
    private static let withYear: [(NSRegularExpression, @Sendable ([Int]) -> Int?)] = [
        (re("(?<![0-9])([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?![0-9])"), { dayNo($0[0], $0[1], $0[2]) }),
        (re("(?<![0-9])([0-9]{4})\(ws)*年\(ws)*([0-9]{1,2})\(ws)*月\(ws)*([0-9]{1,2})\(ws)*[日号]"), { dayNo($0[0], $0[1], $0[2]) }),
        (re("(?<![0-9])([0-9]{4})\(ws)*年\(ws)*([0-9]{1,2})\(ws)*月底"), { monthEnd($0[0], $0[1]) }),
    ]
    /// 不带年份的：09-18（月、日都两位；前后紧挨数字、字母、- : / 的不认）、10 月 15 日、10 月底。给出 [月, 日]，日为 0 表示月底。
    private static let noYear: [(NSRegularExpression, @Sendable ([Int]) -> (Int, Int))] = [
        (re("(?<![0-9A-Za-z\\-:/.])([0-9]{2})-([0-9]{2})(?![0-9\\-:/])"), { ($0[0], $0[1]) }),
        (re("(?<![0-9])([0-9]{1,2})\(ws)*月\(ws)*([0-9]{1,2})\(ws)*[日号]"), { ($0[0], $0[1]) }),
        (re("(?<![0-9])([0-9]{1,2})\(ws)*月底"), { ($0[0], 0) }),
    ]

    /// 日期要挨着提示词才算（ops-private spec 2026-10-06「只认截止日期，久过期的让位」D9），照 JS 的 CUE_SKIP / CUE_AFTER / CUE_BEFORE 逐条搬。
    /// 版本日期（「08-14 定稿」）不算；「交了」「发过」「课后」是过去的事，不算；「合约」「旧约」的约不算。
    private static let cueSkip = re("^\(ws)*(?:[0-9]{1,2}[:：][0-9]{2}|[0-9]{1,2}\(ws)*点)?\(ws)*(?:(?:UTC|BST|GMT|CST)(?![A-Za-z]))?\(ws)*(?:上午|下午|晚上|早上|中午|晚|早)?\(ws)*的?\(ws)*", .caseInsensitive)
    private static let cueAfter = re("^(?:前|之前|以前|截止|截至|到期|答应|说好|(?:提交|交|发|付|见|回)(?![了过])|课(?!后)|上课|会议|开会|冻结|终检|复查|能否|(?:deadline|due)(?![A-Za-z]))", .caseInsensitive)
    private static let cueBefore = re("(?:截止|截至|最晚|不晚于|默认|建议|定时|(?:^|[^\\p{Script=Han}]|[大预])约|周[一二三四五六日天]|星期[一二三四五六日天]|(?<![A-Za-z])(?:due|by|before|until|promised|deadline))[\(ws):：]*$", .caseInsensitive)

    /// s 里 r 这一段日期挨不挨着提示词。位置按 UTF-16，和 JS 的 m.index 一样。
    private static func cued(_ s: NSString, _ r: NSRange) -> Bool {
        let after = s.substring(from: r.location + r.length) as NSString
        let skip = cueSkip.firstMatch(in: after as String, range: NSRange(location: 0, length: after.length))?.range.length ?? 0
        let rest = after.substring(from: skip)
        if cueAfter.firstMatch(in: rest, range: NSRange(location: 0, length: (rest as NSString).length)) != nil { return true }
        let before = s.substring(to: r.location)
        return cueBefore.firstMatch(in: before, range: NSRange(location: 0, length: (before as NSString).length)) != nil
    }

    /// 天号：1970-01-01 起第几天（公历，纯算术，不受时区与夏令时影响）。月、日不合法（02-30、13-14）是 nil。
    static func dayNo(_ y: Int, _ m: Int, _ d: Int) -> Int? {
        guard (1...12).contains(m), d >= 1, d <= daysIn(y, m) else { return nil }
        return civil(y, m, d)
    }

    static func monthEnd(_ y: Int, _ m: Int) -> Int? {
        (1...12).contains(m) ? civil(y, m, daysIn(y, m)) : nil
    }

    private static func daysIn(_ y: Int, _ m: Int) -> Int {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
        return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    }

    /// Howard Hinnant 的 days_from_civil。
    private static func civil(_ y0: Int, _ m: Int, _ d: Int) -> Int {
        let y = m <= 2 ? y0 - 1 : y0
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    /// 今天按给的日历（平时是本机时区）取年月日（那一行 spec D5）。
    static func days(_ text: String, today: Date = Date(), calendar: Calendar = .current) -> Int? {
        let c = calendar.dateComponents([.year, .month, .day], from: today)
        guard let y = c.year, let m = c.month, let d = c.day, let t = dayNo(y, m, d) else { return nil }
        return days(text, todayNo: t, year: y)
    }

    /// 测试用：今天写成 YYYY-MM-DD。
    static func days(_ text: String, today: String) -> Int? {
        let p = today.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3, let t = dayNo(p[0], p[1], p[2]) else { return nil }
        return days(text, todayNo: t, year: p[0])
    }

    /// 挨着提示词的日期里取最晚的（早的多半是「哪天说的」，晚的多半是截止）；认不出是 nil。
    private static func days(_ text: String, todayNo t: Int, year y: Int) -> Int? {
        let s = NSMutableString(string: text)
        basisTail.replaceMatches(in: s, range: NSRange(location: 0, length: s.length), withTemplate: "")
        var found: [Int] = []
        for (r, f) in withYear {
            let ms = r.matches(in: s as String, range: NSRange(location: 0, length: s.length))
            for m in ms where cued(s, m.range) { if let n = f(groups(m, s)) { found.append(n) } }
            // 带年份的认过了，遮住，不让后面再从里面切出「07-31」「10 月底」。
            for m in ms.reversed() { s.replaceCharacters(in: m.range, with: String(repeating: " ", count: m.range.length)) }
        }
        for (r, f) in noYear {
            for m in r.matches(in: s as String, range: NSRange(location: 0, length: s.length)) where cued(s, m.range) {
                let (mo, d) = f(groups(m, s))
                // 去年、今年、明年里取离今天最近的；一样近取晚的；某一年没有这一天就不算那一年。
                var best: Int?
                for yy in [y - 1, y, y + 1] {
                    guard let n = d == 0 ? monthEnd(yy, mo) : dayNo(yy, mo, d) else { continue }
                    if let b = best {
                        if abs(n - t) < abs(b - t) || (abs(n - t) == abs(b - t) && n > b) { best = n }
                    } else {
                        best = n
                    }
                }
                if let best { found.append(best) }
            }
        }
        return found.max().map { $0 - t }
    }

    private static func groups(_ m: NSTextCheckingResult, _ s: NSString) -> [Int] {
        (1..<m.numberOfRanges).map { Int(s.substring(with: m.range(at: $0))) ?? -1 }
    }

    /// 「已过 18 天」「今天」「还有 9 天」（那一行 spec D7 的写法）。
    static func text(_ days: Int) -> String {
        if days < 0 { return L("已过 \(-days) 天", "\(-days) day\(days == -1 ? "" : "s") ago") }
        if days == 0 { return L("今天", "today") }
        return L("还有 \(days) 天", "in \(days) day\(days == 1 ? "" : "s")")
    }
}
