#!/usr/bin/env python3
"""JavaScript の実行やデータの出力を行わず、非公開の回答地図 HTML を比較する。

入力と集計結果だけのレポートは、いずれかのチェックアウトの target/ 内に置く。
旧形式の JavaScript オブジェクトリテラルと application/json ブロックに対応するが、
JavaScript は評価しない。オブジェクトのキーは並べ替え、配列の順序、文字列、
JSON 数値の全桁は比較対象として保持する。任意の通常本文への参照は、
比較前に厳密に正規データへ復元する。比較から除外するのは
answerPreview.query.as_of のみとする。時間計測の対象外で実行する。

実行例（PostgreSQL 版のチェックアウトから）:
  python -B scripts/performance/compare-answer-map-bootstrap.py \
    --before GeoCode-Web-Single/target/answer-map-popup-before/map.html \
    --after GeoCode-Web-Single/target/answer-map-popup-after/map.html \
    --output target/answer-map-popup-bootstrap-comparison.json

終了コード: 0 は一致、1 は不一致、2 は入力不正または診断失敗。
任意の --self-test は人工的な値を使い、非公開のファイルは読み込まない。
"""

from __future__ import annotations

import argparse
from copy import deepcopy
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any, Iterator


ROOT = Path(__file__).resolve().parents[2]
TARGETS = ((ROOT / "target").resolve(), (ROOT / "GeoCode-Web-Single/target").resolve())
SECTIONS = frozenset((
    "page", "popupBodies", "answerPreview", "isCluster", "initialView",
    "tileServers", "tileOverlays", "tileVisibilityAccountId", "layers", "markers", "shapes",
))
OPTIONAL_SECTIONS = frozenset(("normalBodyReferences",))
IDENTIFIER = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
ASSIGNMENT = re.compile(r"\bwindow\.__GEOCODE_MAP_BOOTSTRAP__\s*=\s*")
JSON_SCRIPT = re.compile(r'''<script\b(?=[^>]*\bid\s*=\s*["']geocode-map-bootstrap["'])[^>]*>''', re.IGNORECASE)
JSON_TYPE = re.compile(r'''\btype\s*=\s*["']application/json["']''', re.IGNORECASE)


class DiagnosticError(Exception):
    """エラーコードには固定の診断テキストを使い、ソースの内容は含めない。"""


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DiagnosticError("duplicate_json_key")
        result[key] = value
    return result


def invalid_constant(_: str) -> Any:
    raise DiagnosticError("non_json_numeric_constant")


DECODER = json.JSONDecoder(
    parse_float=Decimal, parse_int=int, parse_constant=invalid_constant,
    object_pairs_hook=unique_object,
)


def whitespace(source: str, position: int) -> int:
    while position < len(source) and source[position] in " \t\r\n":
        position += 1
    return position


def expect(source: str, position: int, token: str) -> int:
    position = whitespace(source, position)
    if not source.startswith(token, position):
        raise DiagnosticError("unexpected_bootstrap_syntax")
    return position + len(token)


def identifier(source: str, position: int) -> tuple[str, int]:
    match = IDENTIFIER.match(source, whitespace(source, position))
    if not match:
        raise DiagnosticError("unexpected_bootstrap_property")
    return match.group(), match.end()


def json_value(source: str, position: int) -> tuple[Any, int]:
    try:
        return DECODER.raw_decode(source, whitespace(source, position))
    except (ValueError, RecursionError) as error:
        raise DiagnosticError("invalid_bootstrap_json") from error


def initial_view(source: str, position: int) -> tuple[dict[str, Any], int]:
    # テンプレートでは、ここに JS のプロパティ識別子を使う。値自体は JSON である。
    position = expect(source, position, "{")
    result: dict[str, Any] = {}
    while True:
        position = whitespace(source, position)
        if source.startswith("}", position):
            position += 1
            break
        key, position = identifier(source, position)
        if key not in ("latitude", "longitude", "zoom") or key in result:
            raise DiagnosticError("invalid_initial_view_structure")
        position = expect(source, position, ":")
        value, position = json_value(source, position)
        if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
            raise DiagnosticError("invalid_initial_view_number")
        result[key] = value
        position = whitespace(source, position)
        if source.startswith(",", position):
            position += 1
        elif not source.startswith("}", position):
            raise DiagnosticError("unexpected_initial_view_syntax")
    if set(result) != {"latitude", "longitude", "zoom"}:
        raise DiagnosticError("incomplete_initial_view")
    return result, position


def bootstrap_sections(source: str) -> Iterator[tuple[str, Any]]:
    json_script = JSON_SCRIPT.search(source)
    json_format = json_script is not None
    if json_script and not JSON_TYPE.search(json_script.group()):
        raise DiagnosticError("invalid_bootstrap_json_script_type")
    match = json_script or ASSIGNMENT.search(source)
    if not match:
        raise DiagnosticError("bootstrap_assignment_missing")
    position = expect(source, match.end(), "{")
    seen: set[str] = set()
    while True:
        position = whitespace(source, position)
        if source.startswith("}", position):
            position += 1
            break
        if json_format:
            key, position = json_value(source, position)
            if not isinstance(key, str):
                raise DiagnosticError("bootstrap_json_property_must_be_a_string")
        else:
            key, position = identifier(source, position)
        if key not in SECTIONS | OPTIONAL_SECTIONS or key in seen:
            raise DiagnosticError("unsupported_or_duplicate_bootstrap_section")
        if key in OPTIONAL_SECTIONS and not json_format:
            raise DiagnosticError("body_references_require_json_script")
        seen.add(key)
        position = expect(source, position, ":")
        value, position = initial_view(source, position) if key == "initialView" and not json_format else json_value(source, position)
        if key == "initialView" and json_format:
            if not isinstance(value, dict) or set(value) != {"latitude", "longitude", "zoom"}:
                raise DiagnosticError("invalid_initial_view_structure")
            if any(isinstance(number, bool) or not isinstance(number, (int, Decimal)) for number in value.values()):
                raise DiagnosticError("invalid_initial_view_number")
        yield key, value
        position = whitespace(source, position)
        if source.startswith(",", position):
            position += 1
            if json_format and source.startswith("}", whitespace(source, position)):
                raise DiagnosticError("trailing_comma_in_bootstrap_json")
        elif not source.startswith("}", position):
            raise DiagnosticError("unexpected_bootstrap_separator")
    if seen - OPTIONAL_SECTIONS != SECTIONS:
        raise DiagnosticError("incomplete_bootstrap")
    if not json_format:
        position = expect(source, position, ";")
    if not source[whitespace(source, position):].lower().startswith("</script"):
        raise DiagnosticError("unexpected_code_after_bootstrap")


def canonical_chunks(value: Any) -> Iterator[str]:
    if value is None:
        yield "null"
    elif value is True:
        yield "true"
    elif value is False:
        yield "false"
    elif isinstance(value, str):
        # ASCII エスケープにより、Unicode のコードポイントと単独のサロゲート値を保持する。
        yield json.dumps(value, ensure_ascii=True)
    elif isinstance(value, int):
        yield str(value)
    elif isinstance(value, Decimal):
        if not value.is_finite():
            raise DiagnosticError("non_finite_json_number")
        # 浮動小数点への変換や Decimal.normalize() は、大きな値を丸める可能性があるため使わない。
        # Decimal は入力の全桁と符号付きゼロを保持し、指数表記は
        # Decimal 自体が正規化する。数値の再整形に失敗しても安全に終了できる。
        yield str(value)
    elif isinstance(value, list):
        yield "["
        for index, item in enumerate(value):
            if index:
                yield ","
            yield from canonical_chunks(item)
        yield "]"
    elif isinstance(value, dict):
        yield "{"
        for index, key in enumerate(sorted(value)):
            if index:
                yield ","
            yield json.dumps(key, ensure_ascii=True)
            yield ":"
            yield from canonical_chunks(value[key])
        yield "}"
    else:
        raise DiagnosticError("unsupported_json_value")


def digest(value: Any) -> tuple[str, int]:
    hashed = hashlib.sha256()
    size = 0
    for chunk in canonical_chunks(value):
        encoded = chunk.encode("ascii")
        hashed.update(encoded)
        size += len(encoded)
    return hashed.hexdigest(), size


def private_path(raw: str, *, existing: bool) -> Path:
    path = Path(raw)
    if not path.is_absolute():
        path = ROOT / path
    path = path.resolve(strict=existing)
    if not any(path != target and path.is_relative_to(target) for target in TARGETS):
        raise DiagnosticError("path_must_stay_below_repository_target")
    if existing and not path.is_file():
        raise DiagnosticError("input_must_be_a_file")
    return path


def restore_normal_body_references(value: dict[str, Any]) -> dict[str, Any]:
    """eval や数値変換を使わず、製品側の JSON 専用コーデックを再現する。"""
    if "normalBodyReferences" not in value:
        return {"present": False, "markers": 0, "shapes": 0}
    metadata = value["normalBodyReferences"]
    if (value.get("page") != "form-answer-map" or not isinstance(metadata, dict)
            or set(metadata) != {"version", "markers", "shapes"}
            or type(metadata["version"]) not in (int, Decimal) or metadata["version"] != 1
            or not isinstance(value.get("markers"), dict)
            or not isinstance(value.get("shapes"), list)
            or not isinstance(value.get("popupBodies"), dict)):
        raise DiagnosticError("invalid_body_reference_metadata")

    def ids(items: Any) -> list[str]:
        if not isinstance(items, list):
            raise DiagnosticError("invalid_body_reference_ids")
        seen: set[str] = set()
        for item in items:
            if (not isinstance(item, str) or not item or ":" in item
                    or len(item.encode("utf-16-le", "surrogatepass")) // 2 > 128 or item in seen):
                raise DiagnosticError("invalid_body_reference_ids")
            seen.add(item)
        return items

    marker_ids, shape_ids = ids(metadata["markers"]), ids(metadata["shapes"])
    shapes: dict[str, dict[str, Any]] = {}
    for shape in value["shapes"]:
        if not isinstance(shape, dict) or not isinstance(shape.get("id"), str):
            continue
        if shape["id"] in shapes:
            raise DiagnosticError("ambiguous_body_reference_shape")
        shapes[shape["id"]] = shape
    updates: list[tuple[dict[str, Any], str, str, str]] = []

    def prepare(kind: str, item: str, target: dict[str, Any], field: str) -> None:
        key = kind + ":" + item
        if field in target or key not in value["popupBodies"]:
            raise DiagnosticError("body_reference_conflict_or_missing_popup")
        popup = value["popupBodies"][key]
        if (not isinstance(popup, dict)
                or not isinstance(popup.get("free_text"), str)
                or not isinstance(popup.get("managed_markdown"), str)
                or type(popup.get("sync_required")) is not bool):
            raise DiagnosticError("invalid_body_reference_popup")
        updates.append((target, field, popup["free_text"], popup["managed_markdown"]))

    for item in marker_ids:
        if item not in value["markers"]:
            raise DiagnosticError("body_reference_marker_missing")
        marker = value["markers"][item]
        if not isinstance(marker, dict) or marker.get("id") != item:
            raise DiagnosticError("invalid_body_reference_marker")
        prepare("marker", item, marker, "detail")
    for item in shape_ids:
        shape = shapes.get(item)
        if (shape is None or not isinstance(shape.get("geojson"), dict)
                or not isinstance(shape["geojson"].get("properties"), dict)):
            raise DiagnosticError("invalid_body_reference_shape")
        prepare("shape", item, shape["geojson"]["properties"], "memo")
    # 正規の値を変更する前に、すべての参照を検証する。JSON オブジェクトに含まれるのは
    # 自身の項目のみであり、__proto__ も通常のキーとして扱い、プロトタイプにはしない。
    for target, field, free, managed in updates:
        target[field] = free + managed
    del value["normalBodyReferences"]
    return {"present": True, "version": 1, "markers": len(marker_ids), "shapes": len(shape_ids)}


def fingerprint_source(source: str) -> dict[str, Any]:
    # セクションをまたぐ参照の復元には、ローカルで完全な値を用意する必要がある。
    # この値は外部に公開せず、アプリやブラウザーのベンチマークの計測にも含めない。
    values = dict(bootstrap_sections(source))
    transport = restore_normal_body_references(values)
    sections: dict[str, Any] = {}
    excluded: dict[str, Any] | None = None
    for name, value in values.items():
        if name == "page" and value != "form-answer-map":
            raise DiagnosticError("unexpected_map_page")
        if name == "answerPreview":
            if not isinstance(value, dict) or not isinstance(value.get("query"), dict):
                raise DiagnosticError("answer_preview_query_missing")
            query = value["query"]
            present = "as_of" in query
            as_of = query.pop("as_of", None)
            if present and not isinstance(as_of, str):
                raise DiagnosticError("query_as_of_must_be_a_timestamp_string")
            excluded = {"present": present, "digest": digest(as_of)[0]}
        hashed, size = digest(value)
        section: dict[str, Any] = {"sha256": hashed, "canonicalBytes": size}
        if isinstance(value, (list, dict)):
            section["items"] = len(value)
        if name == "answerPreview":
            for count in ("answerCount", "targetCount"):
                if type(value.get(count)) is not int or value[count] < 0:
                    raise DiagnosticError("invalid_answer_preview_count")
                section[count] = value[count]
            if not isinstance(value.get("targets"), list):
                raise DiagnosticError("answer_preview_targets_missing")
            section["targets"] = len(value["targets"])
        sections[name] = section
        del value
    if excluded is None:
        raise DiagnosticError("answer_preview_missing")
    combined = digest({name: section["sha256"] for name, section in sections.items()})[0]
    return {"sections": sections, "sectionDigestSha256": combined, "excluded": excluded,
            "sourceFormat": "json" if JSON_SCRIPT.search(source) else "legacy", "transport": transport}


def fingerprint_file(path: Path) -> dict[str, Any]:
    # デコーダーの例外、HTML 断片、非公開のキー・パス・内容は出力しない。
    result = fingerprint_source(path.read_text(encoding="utf-8"))
    result["htmlBytes"] = path.stat().st_size
    return result


def comparison(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    sections = {
        name: {
            "equal": before["sections"][name]["sha256"] == after["sections"][name]["sha256"],
            "before": before["sections"][name], "after": after["sections"][name],
        }
        for name in sorted(SECTIONS)
    }
    presence_equal = before["excluded"]["present"] == after["excluded"]["present"]
    as_of_equal = presence_equal and before["excluded"]["digest"] == after["excluded"]["digest"]
    equal = presence_equal and all(section["equal"] for section in sections.values())
    return {
        "version": 3, "equalExceptQueryAsOf": equal,
        "beforeFormat": before["sourceFormat"], "afterFormat": after["sourceFormat"],
        "beforeHtmlBytes": before["htmlBytes"], "afterHtmlBytes": after["htmlBytes"],
        "beforeSectionDigestSha256": before["sectionDigestSha256"],
        "afterSectionDigestSha256": after["sectionDigestSha256"],
        "bodyReferenceTransport": {"before": before["transport"], "after": after["transport"]},
        "excludedMetadata": {
            "path": "answerPreview.query.as_of", "presenceEqual": presence_equal,
            "beforePresent": before["excluded"]["present"], "afterPresent": after["excluded"]["present"],
            "valueEqual": as_of_equal,
        },
        "sections": sections,
        "scope": [
            "Every expected bootstrap section is compared; missing, duplicate or unexpected sections fail closed.",
            "JSON is decoded without eval. Object keys are sorted at every depth; all array order and full strings are retained.",
            "Legacy object-literal sections and the inert application/json block are extracted structurally; JavaScript is never executed. The wrapper format may differ.",
            "Optional version1 normalBodyReferences is accepted only in JSON, strictly validated, restored as same-kind/id free_text+managed_markdown, and removed before comparing the11canonical sections. No data IDs or body values are exported.",
            "Integers use arbitrary precision and fractional numbers use Decimal, never binary floating-point rounding. Numeric representation changes can conservatively produce a mismatch.",
            "Only answerPreview.query.as_of is excluded; query conditions, target array order, counts, transport metadata, geometry, popup text and shape/marker text are compared.",
            "canonicalBytes measures ASCII-escaped canonical data, not HTTP size. SectionDigestSha256 hashes the sorted section-name/digest mapping, not the original HTML.",
            "Different process-start as_of values are allowed only for this immutable-copy output comparison. Equal resulting data does not prove identical query cutoffs.",
            "Reports contain aggregate counts/bytes, static section names, booleans and whole-section hashes only. No data IDs, text, coordinates or URLs are emitted.",
        ],
    }


def synthetic_source(*, reverse_keys: bool = False, reverse_targets: bool = False,
                     as_of: str = "synthetic-before", text: str = "synthetic text",
                     json_format: bool = False) -> str:
    values = {
        "page": '"form-answer-map"',
        "popupBodies": json.dumps({"synthetic-a": {"text": text, "nested": {"b": 2, "a": 1}}}, ensure_ascii=True),
        "answerPreview": json.dumps({"query": {"as_of": as_of, "mode": "history"}, "targets": ["a", "b"][::-1] if reverse_targets else ["a", "b"], "answerCount": 2, "targetCount": 2}),
        "isCluster": "true", "initialView": "{ latitude: 0.0, longitude: 0.0, zoom: 6, }",
        "tileServers": "{}", "tileOverlays": "[]", "tileVisibilityAccountId": '"synthetic"',
        "layers": '{"b":{"n":123456789012345678901234567890},"a":{"n":0.123456789012345678901234567890}}' if reverse_keys else '{"a":{"n":0.123456789012345678901234567890},"b":{"n":123456789012345678901234567890}}',
        "markers": "{}", "shapes": "[]",
    }
    if reverse_keys:
        values = dict(reversed(list(values.items())))
    if json_format:
        values["initialView"] = '{"latitude":0.0,"longitude":0.0,"zoom":6}'
        return '<script type="application/json" id="geocode-map-bootstrap">{' + ",".join(json.dumps(key) + ":" + value for key, value in values.items()) + "}</script>"
    return "<script>window.__GEOCODE_MAP_BOOTSTRAP__ = {" + ",".join(key + ":" + value for key, value in values.items()) + ",};</script>"


def codec_self_tests() -> int:
    data = dict(bootstrap_sections(synthetic_source(json_format=True)))
    marker_free, marker_managed = "自由\r\n😀e\u0301\x00<>&", "\n回答</script>\u2028\u2029"
    shape_free, shape_managed = "", "図形\r\n同じ文字😀"
    data["markers"] = {"same": {"id": "same", "detail": marker_free + marker_managed,
                                "normalBodyReferences": {"user": True}}}
    data["shapes"] = [
        {"id": "same", "geojson": {"properties": {"memo": shape_free + shape_managed,
                                                  "normalBodyReferences": "user property"}}},
        {"id": "untouched", "geojson": {"properties": {"memo": {"nonstring": True}}}},
    ]
    data["popupBodies"] = {
        "marker:same": {"free_text": marker_free, "managed_markdown": marker_managed, "sync_required": False},
        "shape:same": {"free_text": shape_free, "managed_markdown": shape_managed, "sync_required": True},
    }
    data["answerPreview"].update({"answerCount": 4, "targetCount": 3,
                                  "targets": ["marker:same", "shape:same", "shape:untouched"]})
    encoded = deepcopy(data)
    del encoded["markers"]["same"]["detail"]
    del encoded["shapes"][0]["geojson"]["properties"]["memo"]
    encoded["normalBodyReferences"] = {"version": 1, "markers": ["same"], "shapes": ["same"]}

    def source(value: dict[str, Any]) -> str:
        body = "".join(canonical_chunks(value)).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
        return '<script type="application/json" id="geocode-map-bootstrap">' + body + "</script>"

    def fingerprint(value: dict[str, Any]) -> dict[str, Any]:
        result = fingerprint_source(source(value))
        result["htmlBytes"] = 0
        return result

    def rejects(value: dict[str, Any]) -> None:
        try:
            fingerprint(value)
        except DiagnosticError:
            return
        raise AssertionError("Synthetic invalid body references must be rejected")

    passed = 0
    canonical, decoded = fingerprint(data), fingerprint(encoded)
    assert comparison(canonical, decoded)["equalExceptQueryAsOf"]
    assert len(decoded["sections"]) == 11 and decoded["transport"] == {
        "present": True, "version": 1, "markers": 1, "shapes": 1}
    passed += 1
    # プロトタイプと同名の自身の項目は、継承された値を参照せず、通常の JSON キーとして扱う。
    prototype = deepcopy(encoded)
    prototype["markers"]["__proto__"] = prototype["markers"].pop("same")
    prototype["markers"]["__proto__"]["id"] = "__proto__"
    prototype["popupBodies"]["marker:__proto__"] = prototype["popupBodies"].pop("marker:same")
    prototype["normalBodyReferences"]["markers"] = ["__proto__"]
    assert fingerprint(prototype)["transport"]["markers"] == 1
    passed += 1
    # 空文字列や空の補助データも有効とし、参照されていないフィールドはそのまま残す。
    empty = deepcopy(encoded)
    empty["popupBodies"]["shape:same"].update({"free_text": "", "managed_markdown": ""})
    empty_value = dict(bootstrap_sections(source(empty)))
    restore_normal_body_references(empty_value)
    assert empty_value["shapes"][0]["geojson"]["properties"]["memo"] == ""
    assert empty_value["shapes"][1] == data["shapes"][1]
    passed += 1
    empty_metadata = deepcopy(data)
    empty_metadata["normalBodyReferences"] = {"version": 1, "markers": [], "shapes": []}
    assert comparison(canonical, fingerprint(empty_metadata))["equalExceptQueryAsOf"]
    passed += 1
    # UTF-16 の連結でサロゲートの片割れが結合しても、JSON テキストは変わらない。
    surrogate = deepcopy(encoded)
    surrogate["popupBodies"]["shape:same"].update({"free_text": "\ud83d", "managed_markdown": "\ude00"})
    surrogate_canonical = deepcopy(surrogate)
    restore_normal_body_references(surrogate_canonical)
    surrogate_canonical["shapes"][0]["geojson"]["properties"]["memo"] = "😀"
    assert comparison(fingerprint(surrogate_canonical), fingerprint(surrogate))["equalExceptQueryAsOf"]
    passed += 1

    invalid: list[dict[str, Any]] = []
    for metadata in (None, [], {"version": 2, "markers": [], "shapes": []},
                     {"version": True, "markers": [], "shapes": []},
                     {"version": "1", "markers": [], "shapes": []},
                     {"version": 1, "markers": []},
                     {"version": 1, "markers": [], "shapes": [], "extra": True}):
        value = deepcopy(encoded); value["normalBodyReferences"] = metadata; invalid.append(value)
    for kind in ("markers", "shapes"):
        for ids in (None, "same", [1], [False], [""], ["kind:same"], ["x" * 129], ["😀" * 65], ["same", "same"], ["missing"]):
            value = deepcopy(encoded); value["normalBodyReferences"][kind] = ids; invalid.append(value)
    for key, replacement in (("page", "map"), ("markers", []), ("shapes", {}), ("popupBodies", [])):
        value = deepcopy(encoded); value[key] = replacement; invalid.append(value)
    for replacement in (None, {"id": "different"}, {"detail": "present"}):
        value = deepcopy(encoded); value["markers"]["same"] = replacement; invalid.append(value)
    for field in ("free_text", "managed_markdown", "sync_required"):
        for operation in ("missing", "wrong_type"):
            value = deepcopy(encoded)
            if operation == "missing": del value["popupBodies"]["marker:same"][field]
            else: value["popupBodies"]["marker:same"][field] = 0
            invalid.append(value)
    for kind in ("marker", "shape"):
        value = deepcopy(encoded); del value["popupBodies"][kind + ":same"]; invalid.append(value)
        value = deepcopy(encoded); value["popupBodies"][kind + ":same"] = None; invalid.append(value)
    for field_value in (None, "", {"reference": True}):
        value = deepcopy(encoded); value["markers"]["same"]["detail"] = field_value; invalid.append(value)
        value = deepcopy(encoded); value["shapes"][0]["geojson"]["properties"]["memo"] = field_value; invalid.append(value)
    for shape in ({"id": "same"}, {"id": "same", "geojson": None},
                  {"id": "same", "geojson": {"properties": []}}, {"id": 1}):
        value = deepcopy(encoded); value["shapes"][0] = shape; invalid.append(value)
    value = deepcopy(encoded); value["shapes"].append(deepcopy(value["shapes"][0])); invalid.append(value)
    value = deepcopy(empty_metadata); value["shapes"].append(deepcopy(value["shapes"][1])); invalid.append(value)
    for value in invalid:
        rejects(value)
        passed += 1
    atomic = deepcopy(encoded)
    atomic["popupBodies"]["shape:same"]["managed_markdown"] = None
    try:
        restore_normal_body_references(atomic)
    except DiagnosticError:
        assert "detail" not in atomic["markers"]["same"] and "normalBodyReferences" in atomic
    else:
        raise AssertionError("Synthetic partial restoration must not be published")
    passed += 1
    legacy = synthetic_source()
    legacy = legacy.replace('page:"form-answer-map",', 'normalBodyReferences:{"version":1,"markers":[],"shapes":[]},page:"form-answer-map",')
    try:
        fingerprint_source(legacy)
    except DiagnosticError:
        passed += 1
    else:
        raise AssertionError("Legacy global body references must be rejected")
    return passed


def self_test() -> int:
    def checked(**options: Any) -> dict[str, Any]:
        result = fingerprint_source(synthetic_source(**options))
        result["htmlBytes"] = 0
        return result

    before = checked()
    same = checked(reverse_keys=True, as_of="synthetic-after")
    assert comparison(before, same)["equalExceptQueryAsOf"]
    assert not comparison(before, same)["excludedMetadata"]["valueEqual"]
    assert not comparison(before, checked(reverse_targets=True))["equalExceptQueryAsOf"]
    assert not comparison(before, checked(text="changed synthetic text"))["equalExceptQueryAsOf"]
    assert digest(DECODER.decode("123456789012345678901234567890"))[0] != digest(DECODER.decode("123456789012345678901234567891"))[0]
    assert digest(DECODER.decode("0.123456789012345678901234567890"))[0] != digest(DECODER.decode("0.123456789012345678901234567891"))[0]
    assert comparison(before, checked(json_format=True, reverse_keys=True))["equalExceptQueryAsOf"]
    assert not comparison(before, checked(json_format=True, text="changed synthetic text"))["equalExceptQueryAsOf"]
    for source in (
        synthetic_source().replace("markers:{}", 'markers:{"a":1,"a":2}'),
        synthetic_source().replace("shapes:[]", "shapes:(function(){})()"),
        synthetic_source().replace("shapes:[]", "unknown:[]"),
        synthetic_source(json_format=True).replace('"shapes":[]}', '"shapes":[],}'),
        synthetic_source(json_format=True).replace('type="application/json"', 'type="text/javascript"'),
    ):
        try:
            fingerprint_source(source)
        except DiagnosticError:
            continue
        raise AssertionError("Synthetic invalid data must be rejected")
    codec_cases = codec_self_tests()
    print(json.dumps({"selfTests": 13 + codec_cases, "passed": 13 + codec_cases,
                      "existingCases": 13, "bodyReferenceCases": codec_cases}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--before")
    parser.add_argument("--after")
    parser.add_argument("--output")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if not args.before or not args.after or not args.output:
        raise DiagnosticError("before_after_output_required")
    before = fingerprint_file(private_path(args.before, existing=True))
    after = fingerprint_file(private_path(args.after, existing=True))
    report = comparison(before, after)
    output = private_path(args.output, existing=False)
    if output.suffix.lower() != ".json":
        raise DiagnosticError("report_must_be_json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output = private_path(str(output), existing=False)
    with output.open("x", encoding="utf-8", newline="\n") as destination:
        json.dump(report, destination, ensure_ascii=True, indent=2)
        destination.write("\n")
    print(json.dumps({
        "equalExceptQueryAsOf": report["equalExceptQueryAsOf"],
        "sections": len(report["sections"]),
        "matchingSections": sum(section["equal"] for section in report["sections"].values()),
        "queryAsOfEqual": report["excludedMetadata"]["valueEqual"],
    }))
    return 0 if report["equalExceptQueryAsOf"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except DiagnosticError as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        raise SystemExit(2)
    except Exception:
        # トレースバック、JSON ソースの抜粋、非公開のパス名はログに出力しない。
        print(json.dumps({"error": "comparison_failed"}), file=sys.stderr)
        raise SystemExit(2)
