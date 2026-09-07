"""Fail-fast privacy audit for the public portfolio package."""

from __future__ import annotations

import gzip
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", "__pycache__", ".gradio"}
TEXT_SUFFIXES = {".py", ".js", ".css", ".html", ".md", ".txt", ".json", ".example", ".ps1", ".cmd"}

FORBIDDEN_FILE_PATTERNS = (
    "*.xlsx",
    "*.xls",
    "*.csv",
    "*causal_predictions*",
    "*private*records*",
)

FORBIDDEN_CONTENT = {
    "private sample size": re.compile(r"\b(?:275645|192547|192537)\b"),
    "private field name": re.compile(r"\b(?:report_id|easting_m|northing_m)\b", re.I),
    "local private path": re.compile(r"(?:[A-Z]:\\|file:///)[^\r\n]*", re.I),
    "secret-like token": re.compile(r"(?:AIza[0-9A-Za-z_-]{20,}|hf_[0-9A-Za-z]{20,}|sk-[0-9A-Za-z_-]{20,})"),
}


def public_files() -> list[Path]:
    return [
        path
        for path in ROOT.rglob("*")
        if path.is_file() and not any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts)
    ]


def inspect_text(path: Path) -> list[str]:
    if path.resolve() == Path(__file__).resolve():
        return []
    if path.suffix.lower() not in TEXT_SUFFIXES and path.name != ".gitignore":
        return []
    text = path.read_text(encoding="utf-8", errors="replace")
    issues = []
    for label, pattern in FORBIDDEN_CONTENT.items():
        if pattern.search(text):
            issues.append(f"{label}: {path.relative_to(ROOT)}")
    return issues


def validate_data() -> list[str]:
    issues = []
    summary_paths = [ROOT / "data" / "explorer_data.json", ROOT / "docs" / "data" / "explorer_data.json"]
    summaries = []
    for path in summary_paths:
        payload = json.loads(path.read_text(encoding="utf-8"))
        summaries.append(payload)
        if payload.get("meta", {}).get("data_classification") != "synthetic_demo_only":
            issues.append(f"missing synthetic classification: {path.relative_to(ROOT)}")
    if summaries[0] != summaries[1]:
        issues.append("dashboard and app summary data differ")

    records_path = ROOT / "docs" / "data" / "explorer_records.json.gz"
    with gzip.open(records_path, "rt", encoding="utf-8") as handle:
        records_payload = json.load(handle)
    if records_payload.get("data_classification") != "synthetic_demo_only":
        issues.append("record data is not classified as synthetic_demo_only")
    if len(records_payload.get("records", [])) != 8000:
        issues.append("synthetic relation count is not the expected 8,000")
    return issues


def main() -> int:
    issues: list[str] = []
    files = public_files()
    for pattern in FORBIDDEN_FILE_PATTERNS:
        for path in ROOT.rglob(pattern):
            if path.is_file() and not any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
                issues.append(f"forbidden filename: {path.relative_to(ROOT)}")
    for path in files:
        issues.extend(inspect_text(path))
    issues.extend(validate_data())

    if issues:
        print("PUBLIC RELEASE AUDIT: FAILED")
        for issue in sorted(set(issues)):
            print(f"- {issue}")
        return 1

    print("PUBLIC RELEASE AUDIT: PASSED")
    print(f"Checked {len(files)} files.")
    print("All packaged data is labelled synthetic_demo_only; no blocked research fields, files or token patterns were found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
