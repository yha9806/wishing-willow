#!/usr/bin/env python3
"""Pull Swift declarations out of a file verbatim (doc comments and attributes included), by brace matching.

Used once, for the 2026-09-19 cleanup that moved the export's wording rules out of the view files. Kept so the
move can be re-run and checked: every extracted block is a byte-for-byte slice of its source.

  decl(path, r"static func earTag\\b")   -> the member with its comments, as it stands in the file
  typ(path, "enum Clock")                -> a top-level type with its comments
"""
import re
from pathlib import Path


def _block(lines, start):
    """Lines start.. through the line closing the first brace opened at or after start."""
    depth, opened = 0, False
    for i in range(start, len(lines)):
        code = re.sub(r'"(?:\\.|[^"\\])*"', '""', lines[i])       # braces inside string literals do not count
        code = code.split("//")[0]
        for ch in code:
            if ch == "{":
                depth += 1
                opened = True
            elif ch == "}":
                depth -= 1
        if opened and depth == 0:
            return i
        if not opened and i > start and not lines[i].strip():
            return i - 1                                         # a one-line declaration without a body
    raise ValueError(f"unclosed block from line {start + 1}")


def _with_comments(lines, i):
    j = i
    while j > 0 and re.match(r"\s*(///|//|@)", lines[j - 1]):
        j -= 1
    return j


def decl(path, pattern):
    lines = Path(path).read_text().split("\n")
    hits = [i for i, l in enumerate(lines) if re.search(r"^\s*(?:(?:private|fileprivate|nonisolated)\s+)*" + pattern, l)]
    if len(hits) != 1:
        raise ValueError(f"{pattern!r} matched {len(hits)} lines in {path}")
    i = hits[0]
    first = re.sub(r'"(?:\\.|[^"\\])*"', '""', lines[i]).split("//")[0]
    end = i if ("=" in first and "{" not in first) else _block(lines, i)   # `static let x = …` is one line
    return "\n".join(lines[_with_comments(lines, i):end + 1])


def typ(path, head):
    return decl(path, re.escape(head) + r"\b")
