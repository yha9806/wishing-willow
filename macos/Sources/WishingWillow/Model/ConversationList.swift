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
        var approved: Bool
        var touched: Int?
    }

    var turnIndex: Int?
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
        guard let last = text.split(separator: "\n", omittingEmptySubsequences: true).last,
              let obj = try? JSONSerialization.jsonObject(with: Data(last.utf8)) as? [String: Any],
              let rows = obj["items"] as? [[String: Any]]
        else { return .unreadable(L("最后一行不是快照", "the last line is not a snapshot")) }
        let items = rows.compactMap { r -> ListSnapshot.Item? in
            guard let id = r["id"] as? String, let text = r["text"] as? String, let status = r["status"] as? String else { return nil }
            return .init(id: id, text: text, status: status, wait: r["wait"] as? String, basis: r["basis"] as? String,
                         evidence: r["evidence"] as? String, approved: r["approvedTurn"] is String, touched: r["touched"] as? Int)
        }
        return .snapshot(.init(turnIndex: obj["turnIndex"] as? Int, items: items,
                               changes: obj["changes"] as? [String] ?? [], problems: obj["problems"] as? [String] ?? []))
    }
}
