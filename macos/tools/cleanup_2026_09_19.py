#!/usr/bin/env python3
"""The 2026-09-19 cleanup: the export's wording rules move out of the view files into Wording/, verbatim.

Run once from macos/ before the view files are deleted. Every block is sliced out of its source by
extract_swift.py, so the move adds no hand-typed logic; only the enclosing `enum` lines and the fixture
wrapper are new.
"""
import re
import subprocess
import tempfile
from pathlib import Path

import extract_swift as E

S = Path("Sources/WishingWillow")
BASE = "f89c150"   # the last commit that still has the view files; the move reads them from here, not from the working tree
_src = Path(tempfile.mkdtemp(prefix="willow-cleanup-src-"))


def from_base(rel):
    out = _src / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(subprocess.run(["git", "show", f"{BASE}:macos/Sources/WishingWillow/{rel}"], capture_output=True, check=True).stdout)
    return out


DK, IV, DV, SN = (from_base(r) for r in ("UI/DesignKit.swift", "UI/IslandView.swift", "UI/DetailView.swift", "Snapshot.swift"))


def members(path, patterns):
    return "\n\n".join(E.decl(path, p) for p in patterns)


wording = f'''import AppKit
import Foundation

// 刘海上「写什么」的规则。2026-09-19 从视图文件里原样搬出（tools/cleanup_2026_09_19.py）：
// 来源模式不再画刘海（lintel 画），只把这些规则算出来的字写进活动文件。类型名不变，导出代码一行不改。

{E.typ(DK, "enum StatusCenter")}

{E.typ(DK, "enum ToolSymbol")}

{E.typ(IV, "enum Clock")}

/// 时间轴分段与各段的名字（原 `TurnBar` 视图的静态部分；颜色与画法在 lintel）。
@MainActor   // 原来是视图结构体，默认在主线程上；保持同样的隔离
enum TurnBar {{
{members(DK, [r"struct Segment\b", r"static func fraction\b", r"static func segments\b", r"static func name\(_ k: Segment\.Kind\)"])}
}}

/// 展开态的字（原 `IslandExpandedContent` 视图的静态部分）。
@MainActor
enum IslandExpandedContent {{
{members(IV, [r"struct CompactLine\b", r"static func earTag\b", r"static func phaseWord\b", r"static func compactLines\b",
              r"static func oneLine\b", r"static func phase\(", r"static func clock\(", r"static func percent\("])}
}}

/// 胶囊里的字（原 `SessionPill` 视图的静态部分）。
@MainActor   // 原来是视图结构体，默认在主线程上；保持同样的隔离
enum SessionPill {{
{members(IV, [r"static func title\(_ pill: FocusRule\.Pill\)"])}
}}

/// 面板用到的时刻与时长写法（原 `DetailView` 视图的静态部分）。
@MainActor   // 原来是视图结构体，默认在主线程上；保持同样的隔离
enum DetailView {{
{members(DV, [r"static func closedAt\b", r"static func duration\b"])}
}}

/// 各轮的结局分类（原 `SessionChart` 视图的静态部分）。
@MainActor   // 原来是视图结构体，默认在主线程上；保持同样的隔离
enum SessionChart {{
{members(DV, [r"enum Outcome\b", r"static func outcome\b", r"static func name\(_ o: Outcome\)"])}
}}
'''
(S / "Wording").mkdir(exist_ok=True)
(S / "Wording/Wording.swift").write_text(wording)

snap = SN.read_text()
i, j = snap.index("        let drifting = record("), snap.index("        // 每一幕里把要展示的那个会话排在最前")
scene_lets = snap[i:j].rstrip() + "\n"
fixtures = f'''import Foundation

/// `--lintel-export --fixtures` 用的固定样例（原 `Snapshot` / `SelfShot` 的「01-declared-but-drifting」一幕，2026-09-19 原样搬出）。
/// lintel 的截图比对工具靠它产出同一批活动。
@MainActor
enum DemoFixtures {{
    static func directory() -> URL {{
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("willow-selfshot-\\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for (name, json) in files {{
            try? Data(json.utf8).write(to: dir.appendingPathComponent(name))
        }}
        try? Data(sampleLog.utf8).write(to: dir.appendingPathComponent("sess-a.log.jsonl"))
        return dir
    }}

    private static var files: [(String, String)] {{
{scene_lets}        return [("a.json", drifting), ("b.json", undeclared), ("d.json", stale)]
    }}

{members(SN, [r"static var now\b", r"static var pid\b", r"static func record\(", r"static var sampleLog\b"])}
}}
'''
(S / "Wording/DemoFixtures.swift").write_text(fixtures)
print("wrote", S / "Wording/Wording.swift", S / "Wording/DemoFixtures.swift")
