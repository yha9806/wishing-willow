import Foundation

/// One finished turn, as the plugin appended it to `<session>.log.jsonl`.
///
/// The log is an index, not a source of truth: everything load-bearing here can
/// be recomputed from Claude Code's own transcript, and the transcript wins if
/// they ever disagree. `promptField` is the one field the transcript does not
/// know, so it is diagnostic only — no count may rest on it.
struct TurnLogEntry: Sendable, Equatable, Identifiable {
    var id: String {
        (turnId ?? "") + "|" + (at.map { "\($0.timeIntervalSince1970)" } ?? "") + "|" + (endedAt.map { "\($0.timeIntervalSince1970)" } ?? "")
    }

    var turnId: String?
    var at: Date?
    var endedAt: Date?
    /// Whether the plugin asked this turn at all. Without it, "we never asked"
    /// and "we asked and got nothing" are the same row — and every statistic
    /// built on that confusion is wrong.
    var reminded: Bool?
    /// 被打断的一轮（没有 Stop，下一条消息来之前由 capture 补记）。
    var interrupted: Bool?
    var origin: String?
    var prompt: String?
    var decode: String?
    var tag: String?
    /// 这一条本身是中途追加进来的。
    var midTurn: Bool?
    /// 这一轮进行到一半，被你追加的下一条接走的时刻（不是被打断）。
    var supersededAt: Date?

    var isSystemMessage: Bool { PromptSource.isSystem(origin: origin, prompt: prompt) }
    var declared: Bool { decode?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false }
    var flaggedByModel: Bool { decode?.hasPrefix("⚠") == true }
    /// 和中途追加有关、又没有理解的一轮：之后写的理解夹在工具调用之间，聊天记录不存——核对不了，不是没写。
    var unverifiable: Bool { !declared && interrupted != true && (midTurn == true || supersededAt != nil) }

    /// How long the turn took. Shown because a long turn that drifted is the
    /// expensive kind. Never negative: the two times come from different clocks
    /// (the prompt hook and the transcript), and a row that ended "before" it
    /// started makes lintel reject the whole activity (10-09, a slash command
    /// logged at −0.19 s).
    var duration: TimeInterval? {
        guard let at, let endedAt else { return nil }
        return max(0, endedAt.timeIntervalSince(at))
    }
}

extension TurnLogEntry: Decodable {
    private enum K: String, CodingKey { case turnId, at, endedAt, reminded, interrupted, promptField, origin, prompt, decode, tag, midTurn, supersededAt }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        turnId = try c.decodeIfPresent(String.self, forKey: .turnId)
        reminded = try c.decodeIfPresent(Bool.self, forKey: .reminded)
        origin = try c.decodeIfPresent(String.self, forKey: .origin)
        interrupted = try c.decodeIfPresent(Bool.self, forKey: .interrupted)
        prompt = try c.decodeIfPresent(String.self, forKey: .prompt)
        decode = try c.decodeIfPresent(String.self, forKey: .decode)
        tag = try c.decodeIfPresent(String.self, forKey: .tag)
        midTurn = try c.decodeIfPresent(Bool.self, forKey: .midTurn)
        supersededAt = (try c.decodeIfPresent(String.self, forKey: .supersededAt)).flatMap(WillowRecord.parseISO8601)
        at = (try c.decodeIfPresent(String.self, forKey: .at)).flatMap(WillowRecord.parseISO8601)
        endedAt = (try c.decodeIfPresent(String.self, forKey: .endedAt)).flatMap(WillowRecord.parseISO8601)
    }
}

enum TurnLog {
    /// Read a session's log. A half-written line is skipped, not fatal — the
    /// plugin renames into place, but a reader should never assume that.
    static func read(sessionId: String, directory: URL) -> [TurnLogEntry] {
        // 每次导出读两遍、每个会话都读（K10 功耗）：文件没变就用上一次读出的。
        cache.value(at: directory.appendingPathComponent("\(sessionId).log.jsonl", isDirectory: false), load: load)
    }

    private static let cache = FileCache<[TurnLogEntry]>()

    private static func load(_ url: URL) -> [TurnLogEntry] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        var out: [TurnLogEntry] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let data = line.data(using: .utf8),
                  let e = try? JSONDecoder().decode(TurnLogEntry.self, from: data)
            else { continue }
            out.append(e)
        }
        return out
    }
}
