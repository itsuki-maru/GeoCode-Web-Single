"""SQLite 専用の一時DBでバックエンドのテストと LLVM カバレッジを計測する。"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def run(args: list[str], env: dict[str, str], log: Path) -> int:
    print(f"Running: {' '.join(args)} (log: {log.relative_to(ROOT)})", flush=True)
    with log.open("w", encoding="utf-8") as stream:
        result = subprocess.run(args, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT)
    print(f"Exit code: {result.returncode}", flush=True)
    return result.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--llvm-cov", default=shutil.which("cargo-llvm-cov"))
    parser.add_argument("--label", default="current", choices=("baseline", "current"))
    parser.add_argument("--timezone", default="UTC")
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    if not args.llvm_cov:
        parser.error("cargo-llvm-cov をインストールするか --llvm-cov で指定してください")
    executable = str(Path(args.llvm_cov).resolve())
    output = ROOT / "target" / "coverage" / args.label
    output.mkdir(parents=True, exist_ok=True)
    build = str(ROOT / "target" / "coverage-build")
    env = dict(os.environ, CARGO_LLVM_COV_SETUP="no", CARGO_BUILD_JOBS="2",
               CARGO_LLVM_COV_TARGET_DIR=build, CARGO_LLVM_COV_BUILD_DIR=build,
               SQLX_OFFLINE="true", NO_COLOR="1", TZ=args.timezone,
               DATABASE_URL="sqlite::memory:", CREATEDATABASE_PATH=":memory:")
    record = {"started_at": datetime.now(timezone.utc).isoformat(), "timezone": args.timezone}
    record["clean_exit_code"] = run([executable, "llvm-cov", "clean", "--profraw-only"], env, output / "clean.log")
    if record["clean_exit_code"]:
        (output / "run.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
        return 1
    record["test_exit_code"] = run([
        executable, "llvm-cov", *(["--offline"] if args.offline else []),
        "--lib", "--tests", "--no-fail-fast", "--no-report", "--", "--test-threads=1",
    ], env, output / "tests.log")
    record["report_exit_codes"] = {}
    for name, flags in (
        ("json", ["--json", "--skip-functions", "--output-path", str(output / "backend.json")]),
        ("lcov", ["--lcov", "--output-path", str(output / "backend.lcov")]),
        ("html", ["--html", "--output-dir", str(output / "html")]),
    ):
        record["report_exit_codes"][name] = run([
            executable, "llvm-cov", "report", "--ignore-filename-regex", r"[/\\]target[/\\]", *flags,
        ], env, output / f"{name}.log")
    text = (output / "tests.log").read_text(encoding="utf-8", errors="replace")
    results = re.findall(r"test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored", text)
    record["tests"] = {"passed": sum(int(r[1]) for r in results),
                       "failed": sum(int(r[2]) for r in results),
                       "ignored": sum(int(r[3]) for r in results), "test_binaries": len(results)}
    record["finished_at"] = datetime.now(timezone.utc).isoformat()
    (output / "run.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    print(json.dumps(record, indent=2), flush=True)
    return int(bool(record["test_exit_code"] or any(record["report_exit_codes"].values())))


if __name__ == "__main__":
    raise SystemExit(main())
