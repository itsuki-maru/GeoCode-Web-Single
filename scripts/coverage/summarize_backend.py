"""SQLite 版のバックエンド計測結果とファイル別の未到達行をまとめる。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "target" / "coverage"


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def ranges(numbers: list[int]) -> str:
    groups = []
    for number in sorted(set(numbers)):
        if groups and groups[-1][1] + 1 == number:
            groups[-1][1] = number
        else:
            groups.append([number, number])
    return ", ".join(str(a) if a == b else f"{a}-{b}" for a, b in groups) or "なし"


def summarize(label: str) -> dict:
    directory = OUTPUT / label
    exported = load(directory / "backend.json")
    uncovered = {}
    current = None
    for line in (directory / "backend.lcov").read_text(encoding="utf-8").splitlines():
        if line.startswith("SF:"):
            path = Path(line[3:])
            current = (path if path.is_absolute() else ROOT / path).resolve()
            uncovered[current] = []
        elif current is not None and line.startswith("DA:"):
            number, count, *_ = line[3:].split(",")
            if int(count) == 0:
                uncovered[current].append(int(number))
    files = []
    for data in exported["data"]:
        for file in data["files"]:
            path = Path(file["filename"]).resolve()
            name = path.relative_to(ROOT).as_posix()
            if not name.startswith("src/"):
                raise ValueError(f"Unexpected coverage source: {name}")
            files.append({"path": name, "metrics": {key: file["summary"][key]
                          for key in ("lines", "functions", "regions")},
                          "uncovered_lines": uncovered.get(path, [])})
    metrics = {}
    for key in ("lines", "functions", "regions"):
        covered = sum(f["metrics"][key]["covered"] for f in files)
        total = sum(f["metrics"][key]["count"] for f in files)
        metrics[key] = {"covered": covered, "count": total, "percent": 100 * covered / total if total else None}
    return {"metrics": metrics, "files": files, "run": load(directory / "run.json"),
            "warnings": [f"{kind}: {line}" for kind in ("json", "lcov", "html")
                         for line in (directory / f"{kind}.log").read_text(encoding="utf-8", errors="replace").splitlines()
                         if line.startswith("warning:")],
            "files_without_records": sorted({f.relative_to(ROOT).as_posix() for f in (ROOT / "src").rglob("*.rs")}
                                            - {f["path"] for f in files})}


def main() -> None:
    report = {"current": summarize("current")}
    if (OUTPUT / "baseline" / "run.json").exists():
        report["baseline"] = summarize("baseline")
    (OUTPUT / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# SQLite版バックエンドのカバレッジ", "",
             f"集計日時: {datetime.now(timezone(timedelta(hours=9))):%Y-%m-%d %H:%M %z}（日本時間）。", "",
             "対象は `src/` のRustコード（Tauri起動処理を含む）。外部の `tests/`、依存ライブラリ、build.rsは除外する。",
             "`src/` 内の `#[cfg(test)]` もLLVMの生集計に含む。安定版では行・関数・regionを計測し、分岐は計測しない。",
             "テストは専用のインメモリDBまたはtarget内の一時SQLiteを使用し、通常のDBを読み書きしない。", "",
             "| 計測 | 行 | 関数 | region | 成功 | 失敗 | ignored |", "|---|---:|---:|---:|---:|---:|---:|"]
    for label in ("baseline", "current"):
        if label not in report:
            continue
        item = report[label]
        cells = [f'{item["metrics"][key]["percent"]:.2f}% ({item["metrics"][key]["covered"]}/{item["metrics"][key]["count"]})'
                 for key in ("lines", "functions", "regions")]
        tests = item["run"]["tests"]
        lines.append(f'| {label} | {" | ".join(cells)} | {tests["passed"]} | {tests["failed"]} | {tests["ignored"]} |')
    if report.get("baseline", {}).get("run", {}).get("excluded_added_tests"):
        lines.extend(["", "baselineは同じ修正後の本体コードで、追加前のテスト集合のみを実行した比較値です。currentは追加分を含む全件実行です。比較時のテスト選択は `target/coverage/baseline/run.json` に記録しています。"])
    lines.extend(["", "## 実行状態", ""])
    for label, item in report.items():
        run = item["run"]
        ok = run.get("clean_exit_code", 0) == 0 and run["test_exit_code"] == 0 and all(code == 0 for code in run["report_exit_codes"].values())
        lines.append(f'- {label}: {"全コマンド成功" if ok else "失敗を含む診断値"}。終了UTC: {run["finished_at"]}、TZ={run["timezone"]}。')
        lines.extend(f'  - {warning}' for warning in item["warnings"])
    lines.extend(["", "## ファイル別の未到達行", "",
                  "到達率はLLVM JSON、未到達行番号はLCOVを使用する。両形式には集計差がある。数値は期待結果の検証の十分さを保証しない。", "",
                  "| ファイル | 行カバレッジ | LCOV未到達行 |", "|---|---:|---|"])
    for file in sorted(report["current"]["files"], key=lambda f: f["path"]):
        m = file["metrics"]["lines"]
        lines.append(f'| {file["path"]} | {m["percent"]:.2f}% ({m["covered"]}/{m["count"]}) | {ranges(file["uncovered_lines"])} |')
    lines.extend(["", "記録なし（未計測。100%として扱わない）: " + (", ".join(report["current"]["files_without_records"]) or "なし"), ""])
    destination = ROOT / "docs" / "COVERAGE_BACKEND.md"
    destination.write_text("\n".join(lines), encoding="utf-8")
    print(destination)


if __name__ == "__main__":
    main()
