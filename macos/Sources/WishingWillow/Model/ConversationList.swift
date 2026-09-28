import Foundation

/// 整场对话的长清单：插件（hooks/_list.mjs）每轮有变化就往 `<会话>.list.jsonl` 追加一份快照，这里只读最后一份。
/// 读不出不当成空清单：空清单在面板上读起来就是「没有开着的事」。
struct ListSnapshot {
    struct Item {
        var id: String
        var text: String
        var status: String
        var wait: String?
        var basis: String?
        var evidence: String?
        /// 最近一次转状态时写的那句（「L1 → 等你：…」冒号后面）。状态变过以后，它才是「现在要你做什么」。
        var note: String? = nil
        var approved: Bool
        var touched: Int?
        /// 挡着什么：它一落地就能放开的项或外部的事（09-28 spec 清单与下一步的分工 D1）。
        var blocks: [String] = []
    }

    var turnIndex: Int?
    var turnId: String?
    var at: String?
    var items: [Item]
    var changes: [String]
    var problems: [String]
}

enum ConversationList {
    enum Result {
        case none
        case unreadable(String)
        case snapshot(ListSnapshot)
    }

    static func read(sessionId: String, directory: URL) -> Result {
        let url = directory.appendingPathComponent("\(sessionId).list.jsonl")
        guard FileManager.default.fileExists(atPath: url.path) else { return .none }
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return .unreadable(L("文件打不开", "cannot open the file")) }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true)
        guard let last = lines.last.flatMap(parse) else { return .unreadable(L("最后一行不是快照", "the last line is not a snapshot")) }
        return .snapshot(last)
    }

    /// 最后一份之前的那一份（比出这一轮变了什么用）；没有或读不出是 nil。
    static func previous(sessionId: String, directory: URL) -> ListSnapshot? {
        let url = directory.appendingPathComponent("\(sessionId).list.jsonl")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true)
        return lines.count >= 2 ? parse(lines[lines.count - 2]) : nil
    }

    static func parse(_ line: Substring) -> ListSnapshot? {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let rows = obj["items"] as? [[String: Any]] else { return nil }
        let items = rows.compactMap { r -> ListSnapshot.Item? in
            guard let id = r["id"] as? String, let text = r["text"] as? String, let status = r["status"] as? String else { return nil }
            return .init(id: id, text: text, status: status, wait: r["wait"] as? String, basis: r["basis"] as? String,
                         evidence: r["evidence"] as? String, note: r["note"] as? String, approved: r["approvedTurn"] is String,
                         touched: r["touched"] as? Int, blocks: r["blocks"] as? [String] ?? [])
        }
        return .init(turnIndex: obj["turnIndex"] as? Int, turnId: obj["turnId"] as? String, at: obj["at"] as? String, items: items,
                     changes: obj["changes"] as? [String] ?? [], problems: obj["problems"] as? [String] ?? [])
    }

    /// 主动弹出只在三种情况下弹（spec V3，作者 09-24 认可）：新出现等你、有事项被打回或撤掉、你认可了一项。
    /// 单纯又做完一步不弹。返回 (种类, 那一项)，按清单次序。
    static func triggers(previous prev: ListSnapshot?, last: ListSnapshot) -> [(String, ListSnapshot.Item)] {
        last.items.compactMap { x in
            let p = prev?.items.first { $0.id == x.id }
            if x.status == "等你", p?.status != "等你" { return (L("等你", "Waiting"), x) }
            if x.status == "撤掉", let p, p.status != "撤掉" { return (L("撤掉", "Dropped"), x) }
            if let p, p.status == "做完", x.status != "做完", x.status != "撤掉" { return (L("打回", "Reopened"), x) }
            if x.approved, !(p?.approved ?? false) { return (L("认可", "Approved"), x) }
            return nil
        }
    }
}
