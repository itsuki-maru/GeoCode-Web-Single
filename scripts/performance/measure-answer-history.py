"""Compare shared full-row history SQL from two SQLite revisions in a memory DB."""

import argparse
import hashlib
import json
import re
import sqlite3
import statistics
import subprocess
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE = "src/handler/form_answers.rs"


def history_query(source):
    function = source.split("pub(super) fn build_query(", 1)[1].split(
        "pub(super) fn append_conditions(", 1
    )[0]
    if "QueryBuilder<'static, Sqlite>" not in function:
        raise ValueError("This diagnostic supports the SQLite backend only")
    raw = re.findall(r'r#"([\s\S]*?)"#', function)
    if "fn append_answer_source(" in function:
        # The current backend shares these Full-projection fragments with CSV,
        # answer maps and the bounded detail fetch. Search/count use narrower
        # projections; this diagnostic deliberately continues measuring Full.
        helper = function.split("fn append_answer_source(", 1)[1].split(
            "fn build_query_with_projection(", 1
        )[0]
        fragments = re.findall(r'r#"([\s\S]*?)"#', helper)

        def template(description, *markers):
            matches = [sql for sql in fragments if all(marker in sql for marker in markers)]
            if len(matches) != 1:
                raise ValueError(f"Unrecognized Full-projection {description}: {len(matches)} templates")
            return matches[0]

        core = template("SELECT core", "AS target_type", "AS target_id")
        if "SELECT" not in core:
            # Full retains s.id; only the history Count projection omits it.
            select = re.search(r'b\.push\("(SELECT\s+)"\)', helper)
            answer_id = re.search(r'b\.push\("(s\.id,\s*)"\)', helper)
            if not select or not answer_id:
                raise ValueError("Unrecognized Full-projection SELECT prefix")
            core = select[1] + answer_id[1] + core
        full_extra = template("additional columns", "{name} AS target_name", "s.submitted_values", "common_form_deleted")
        owner_from = template("FROM", "FROM {kind}_form_submission_model s", "{table} m ON m.id = s.{kind}_id")
        if "{target_join}" in owner_from:
            # Shared Full history passes keys=None; CROSS JOIN belongs only to
            # the bounded detail fetch and is outside this diagnostic's scope.
            target_join = re.search(
                r'let target_join = if keys\.is_some\(\)\s*\{\s*"CROSS JOIN"\s*\}\s*else\s*\{\s*"(JOIN)"\s*\}',
                helper,
            )
            if not target_join:
                raise ValueError("Unrecognized Full-projection target join")
            owner_from = owner_from.replace("{target_join}", target_join[1])
        full_joins = template("display joins", "LEFT JOIN layer_model", "LEFT JOIN common_form_model")
        owner_where = re.search(r'b\.push\("(\s*WHERE m\.user_id\s*=\s*)"\)\s*\.push_bind', helper)
        if not owner_where:
            raise ValueError("Unrecognized Full-projection owner predicate")
        owner = core + full_extra + owner_from + full_joins + owner_where[1]
    else:
        # Retain the original all-in-one templates, including 47b82c0/ecf2d71.
        owner = next(sql for sql in raw if "s.submitted_values" in sql)
    branches = []
    for kind in ("marker", "shape"):
        table = "marker_info_model" if kind == "marker" else "shape_model"
        name = "m.marker_name" if kind == "marker" else "COALESCE(m.name, '名称なし')"
        branches.append(owner.format(kind=kind, table=table, name=name) + ":user")
    prefix = (
        "WITH owned AS ("
        + " UNION ALL ".join(branches)
        + "), scoped AS (SELECT * FROM owned WHERE create_at COLLATE answer_time <= :at"
    )
    history = re.search(r'b\.push\("(\), filtered AS \(SELECT \* FROM scoped WHERE TRUE)"\)', function)
    if history:
        suffix = history[1]
    else:
        suffix = next(sql for sql in raw if "), ranked AS (" in sql)
        if "SELECT * FROM ranked WHERE TRUE" not in suffix:
            raise ValueError("Unrecognized baseline history query")
    columns = re.search(r'const ROW_COLUMNS: &str = r#"([\s\S]*?)"#;', source)[1]
    return {
        "count": prefix + suffix + ") SELECT count(*), count(DISTINCT target_type || ':' || target_id) FROM filtered",
        "page": prefix + suffix + ") SELECT " + columns
        + " FROM filtered WHERE TRUE ORDER BY create_at COLLATE answer_time DESC, id DESC, target_type DESC LIMIT 51",
    }


def fixture(count, length):
    db = sqlite3.connect(":memory:")
    # All fixture timestamps have the same fixed UTC format. This deliberately
    # excludes the production Rust collation's parsing cost and mixed formats.
    db.create_collation("answer_time", lambda a, b: (a > b) - (a < b))
    db.executescript(
        "CREATE TABLE layer_model(id TEXT PRIMARY KEY,user_id TEXT,layer_name TEXT);"
        "CREATE TABLE common_form_model(id TEXT PRIMARY KEY,user_id TEXT,form_title TEXT,deleted INTEGER);"
    )
    for kind in ("marker", "shape"):
        table = "marker_info_model" if kind == "marker" else "shape_model"
        name = "marker_name" if kind == "marker" else "name"
        db.execute(f"CREATE TABLE {table}(id TEXT PRIMARY KEY,user_id TEXT,layer_id TEXT,{name} TEXT)")
        db.execute(f"CREATE INDEX idx_{kind}_owner ON {table}(user_id,layer_id)")
        db.execute(f"CREATE TABLE {kind}_form_submission_model(id TEXT PRIMARY KEY,{kind}_id TEXT,create_at TEXT,edited_at TEXT,revision INTEGER,submitted_values TEXT,form_snapshot TEXT,source_form TEXT)")
        db.execute(f"CREATE INDEX idx_{kind}_target_time ON {kind}_form_submission_model({kind}_id,create_at DESC)")
        db.execute(f"CREATE INDEX idx_{kind}_form_time ON {kind}_form_submission_model((source_form->>'id'),{kind}_id,create_at DESC,id DESC)")
        db.executemany(
            f"INSERT INTO {table} VALUES(?,?,?,?)",
            [(f"{kind}-{i:06}", "synthetic-user", None, f"object-{i}") for i in range(count // 20)],
        )
        values = json.dumps({"text": "x" * length})
        snapshot = json.dumps({"form_schema": {"fields": [{"id": "text", "label": "Text", "type": "text"}]}})
        db.executemany(
            f"INSERT INTO {kind}_form_submission_model VALUES(?,?,?,?,?,?,?,?)",
            [(f"answer-{kind}-{i:06}", f"{kind}-{i // 10:06}",
              f"2026-10-27 {i // 3600:02}:{i // 60 % 60:02}:{i % 60:02}",
              None, 1, values, snapshot, None) for i in range(count // 2)],
        )
    db.commit()
    return db


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repository", default="GeoCode-Web-Single" if (ROOT / "GeoCode-Web-Single").is_dir() else "."
    )
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("--samples must be positive")
    repository = (ROOT / args.repository).resolve()
    baseline = subprocess.check_output(
        ["git", "-C", str(repository), "rev-parse", "--verify", args.baseline + "^{commit}"],
        encoding="utf-8",
    ).strip()
    sources = {
        "before": subprocess.check_output(["git", "-C", str(repository), "show", baseline + ":" + SOURCE], encoding="utf-8"),
        "after": (repository / SOURCE).read_text(encoding="utf-8"),
    }
    queries = {stage: history_query(source) for stage, source in sources.items()}
    bindings = {"user": "synthetic-user", "at": "2026-10-28 00:00:00"}
    report = {
        "sqliteVersion": sqlite3.sqlite_version,
        "baseline": baseline,
        "sourceSha256": {stage: hashlib.sha256(source.replace("\r\n", "\n").encode()).hexdigest() for stage, source in sources.items()},
        "samples": args.samples,
        "notes": [
            "Default unscoped shared Full-projection history SQL reconstructed from the production Rust templates; not a full handler or application benchmark.",
            "This preserves the full-row SQL comparison across revisions. It does not measure the newer Count/Search projections, ID-first pagination, or deferred full-row fetch; use the native handler profiler for those changes.",
            "Synthetic memory DB with the referenced columns and owner/target/form indexes, not an application database. No application data or sources are modified.",
            "Fixed-format UTC timestamps use lexical comparison, excluding production Rust timestamp parsing and mixed formats.",
            "One warm-up per query; before/after samples alternate on the same fixture. Time includes SQLite execution and Python fetchall, excluding fixture setup, HTTP, JSON serialization/transfer, SQLx, and Vue.",
            "Each case verifies identical counts, target counts, and 51 complete ordered rows (50 plus next-cursor sentinel). Latest-mode correctness is covered by the backend integration tests.",
        ],
        "cases": [],
    }
    for count, length in ((2000, 80), (20000, 80), (20000, 5000)):
        db = fixture(count, length)
        case = {"rows": count, "valueLength": length, "operations": {}}
        try:
            for operation in ("count", "page"):
                expected = db.execute(queries["before"][operation], bindings).fetchall()
                assert db.execute(queries["after"][operation], bindings).fetchall() == expected
                times = {stage: [] for stage in queries}
                for _ in range(args.samples):
                    for stage in queries:
                        started = time.perf_counter()
                        actual = db.execute(queries[stage][operation], bindings).fetchall()
                        times[stage].append((time.perf_counter() - started) * 1000)
                        assert actual == expected
                case["operations"][operation] = {}
                for stage in queries:
                    plan = [row[3] for row in db.execute("EXPLAIN QUERY PLAN " + queries[stage][operation], bindings)]
                    case["operations"][operation][stage] = {
                        "medianMs": round(statistics.median(times[stage]), 2),
                        "samplesMs": [round(value, 2) for value in times[stage]],
                        "plan": plan,
                    }
        finally:
            db.close()
        report["cases"].append(case)
        print(json.dumps({
            "rows": count,
            "valueLength": length,
            "medianMs": {
                operation: {stage: values["medianMs"] for stage, values in stages.items()}
                for operation, stages in case["operations"].items()
            },
        }), flush=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
