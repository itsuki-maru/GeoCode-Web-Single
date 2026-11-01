//! 回答地図の HTML 転送のみを圧縮し、データベースと読み取りモデルの本文は正規の表現を保つ。
use serde_json::{Map, Value};
use tera::Context;

// 任意の補助データ全体のサイズを、テンプレートの空白も含めて各参照に計上する。
// これにより、参照ごとに分担されるコストを意図的に多めに見積もる。
const REFERENCE_FIXED_BYTES: usize = concat!(
    ",\n            \"normalBodyReferences\": ",
    "{\"version\":1,\"markers\":[],\"shapes\":[]}"
)
.len();

pub(crate) fn encode_context(context: Context) -> tera::Result<Context> {
    // どちらの変換も、大きな文字列を含む所有済みの JSON 値を移動する。
    let mut value = context.into_json();
    encode_values(&mut value);
    Context::from_value(value)
}

fn encode_values(value: &mut Value) {
    let Some(context) = value.as_object_mut() else {
        return;
    };
    let Some(popup_bodies) = context.remove("popupBodies") else {
        return;
    };
    let mut marker_refs = Vec::new();
    let mut shape_refs = Vec::new();
    if let Some(markers) = context
        .get_mut("markersFromAxum")
        .and_then(Value::as_object_mut)
    {
        for (id, marker) in markers {
            if marker.get("id").and_then(Value::as_str) == Some(id.as_str())
                && can_reference(
                    marker.get("detail"),
                    popup_bodies.get(format!("marker:{id}")),
                    id,
                )
            {
                if let Some(marker) = marker.as_object_mut() {
                    marker.remove("detail");
                    marker_refs.push(Value::String(id.clone()));
                }
            }
        }
    }
    if let Some(shapes) = context
        .get_mut("shapesFromAxum")
        .and_then(Value::as_array_mut)
    {
        for shape in shapes {
            let reference = shape.get("id").and_then(Value::as_str).and_then(|id| {
                can_reference(
                    shape.pointer("/geojson/properties/memo"),
                    popup_bodies.get(format!("shape:{id}")),
                    id,
                )
                .then(|| id.to_owned())
            });
            if let Some(id) = reference {
                if let Some(properties) = shape
                    .pointer_mut("/geojson/properties")
                    .and_then(Value::as_object_mut)
                {
                    properties.remove("memo");
                    shape_refs.push(Value::String(id));
                }
            }
        }
    }
    context.insert("popupBodies".into(), popup_bodies);
    if !marker_refs.is_empty() || !shape_refs.is_empty() {
        let references = Map::from_iter([
            ("version".into(), Value::from(1)),
            ("markers".into(), Value::Array(marker_refs)),
            ("shapes".into(), Value::Array(shape_refs)),
        ]);
        context.insert("normalBodyReferences".into(), Value::Object(references));
    }
}

fn can_reference(normal: Option<&Value>, popup: Option<&Value>, id: &str) -> bool {
    // 想定外の旧形式の識別子は、省略しない完全な表現のまま保持する。
    if uuid::Uuid::parse_str(id).is_err() {
        return false;
    }
    let Some(normal) = normal.and_then(Value::as_str) else {
        return false;
    };
    let Some(popup) = popup else {
        return false;
    };
    let (Some(free), Some(managed), Some(_)) = (
        popup.get("free_text").and_then(Value::as_str),
        popup.get("managed_markdown").and_then(Value::as_str),
        popup.get("sync_required").and_then(Value::as_bool),
    ) else {
        return false;
    };
    // 正規化や各部分についての仮定を行わず、文字列全体の完全一致を確認する。
    if normal.strip_prefix(free) != Some(managed) {
        return false;
    }
    match (
        html_safe_json_string_token_bytes(normal),
        html_safe_json_string_token_bytes(id)
            .and_then(|n| n.checked_add(REFERENCE_FIXED_BYTES + 1)),
    ) {
        // プロパティ名やカンマの削除でもサイズは減るが、その削減分は計算に含めない。
        (Some(removed), Some(added_upper_bound)) => removed > added_upper_bound,
        _ => false,
    }
}

/// serde_json の文字列トークンに、本番の json_encode_for_html と同じ置換を適用した
/// 正確な UTF-8 長を求める。テキストをコピーせず、直接数える。
fn html_safe_json_string_token_bytes(text: &str) -> Option<usize> {
    text.chars().try_fold(2usize, |bytes, ch| {
        let width = match ch {
            '"' | '\\' | '\u{08}' | '\t' | '\n' | '\u{0c}' | '\r' => 2,
            '\u{00}'..='\u{1f}' | '&' | '<' | '>' | '\u{2028}' | '\u{2029}' => 6,
            _ => ch.len_utf8(),
        };
        bytes.checked_add(width)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "00000000-0000-0000-0000-000000000001";

    fn context(normal: Option<Value>, free: Value, managed: Value, sync: bool) -> Context {
        let mut marker = json!({"id":ID,"unrelated":"retained"});
        if let Some(normal) = normal {
            marker["detail"] = normal;
        }
        Context::from_value(json!({
            "markersFromAxum":{ID:marker},
            "shapesFromAxum":[],
            "popupBodies":{format!("marker:{ID}"):{
                "free_text":free,"managed_markdown":managed,"sync_required":sync
            }},
            "other":{"normalBodyReferences":{"version":"user data"}}
        }))
        .unwrap()
    }

    fn restore(mut value: Value) -> Value {
        if let Some(refs) = value
            .as_object_mut()
            .unwrap()
            .remove("normalBodyReferences")
        {
            assert_eq!(refs["version"], 1);
            for kind in ["marker", "shape"] {
                for id in refs[format!("{kind}s")].as_array().unwrap() {
                    let id = id.as_str().unwrap();
                    let popup = &value["popupBodies"][format!("{kind}:{id}")];
                    let body = format!(
                        "{}{}",
                        popup["free_text"].as_str().unwrap(),
                        popup["managed_markdown"].as_str().unwrap()
                    );
                    if kind == "marker" {
                        value["markersFromAxum"][id]["detail"] = Value::String(body);
                    } else {
                        let shape = value["shapesFromAxum"]
                            .as_array_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|s| s["id"] == id)
                            .unwrap();
                        shape["geojson"]["properties"]["memo"] = Value::String(body);
                    }
                }
            }
        }
        value
    }

    #[test]
    fn string_token_length_matches_production_html_safe_filter() {
        let mut tera = crate::build_tera_from_embed().unwrap();
        tera.add_raw_template(
            "transport-token",
            "{{ text | json_encode_for_html | safe }}",
        )
        .unwrap();
        let controls: String = (0..=31).map(char::from).collect();
        for text in [
            "",
            "abc",
            "\"\\/\n\r\t\u{08}\u{0c}",
            "</ScRiPt>&\u{2028}\u{2029}",
            "漢字𠮷🙂e\u{301}",
            &controls,
        ] {
            let mut context = Context::new();
            context.insert("text", text);
            let encoded = tera.render("transport-token", &context).unwrap();
            assert_eq!(html_safe_json_string_token_bytes(text), Some(encoded.len()));
            assert_eq!(serde_json::from_str::<String>(&encoded).unwrap(), text);
        }
    }

    #[test]
    fn references_round_trip_markers_shapes_unicode_and_ambiguous_legacy_without_copying_popups() {
        let free = "自由</script>&\u{2028}\u{2029}𠮷e\u{301}\r\n".repeat(12);
        let managed = "同じ回答🙂\n同じ回答🙂\n".repeat(12);
        let body = format!("{free}{managed}");
        let mut canonical =
            context(Some(json!(body)), json!(free), json!(managed), true).into_json();
        canonical["shapesFromAxum"] = json!([{"id":ID,"geojson":{"properties":{"memo":body,"normalBodyReferences":{"version":999}},"geometry":{"type":"Point","coordinates":[139,35]}}}]);
        canonical["popupBodies"][format!("shape:{ID}")] =
            canonical["popupBodies"][format!("marker:{ID}")].clone();
        let input = Context::from_value(canonical.clone()).unwrap();
        let popup_pointer =
            input.get("popupBodies").unwrap()[format!("marker:{ID}")]["managed_markdown"]
                .as_str()
                .unwrap()
                .as_ptr();
        let encoded = encode_context(input).unwrap().into_json();
        assert_eq!(
            encoded["normalBodyReferences"],
            json!({"version":1,"markers":[ID],"shapes":[ID]})
        );
        assert!(encoded["markersFromAxum"][ID].get("detail").is_none());
        assert!(
            encoded["shapesFromAxum"][0]["geojson"]["properties"]
                .get("memo")
                .is_none()
        );
        assert_eq!(encoded["popupBodies"], canonical["popupBodies"]);
        assert_eq!(
            encoded["popupBodies"][format!("marker:{ID}")]["managed_markdown"]
                .as_str()
                .unwrap()
                .as_ptr(),
            popup_pointer
        );
        assert_eq!(restore(encoded), canonical);
    }

    #[test]
    fn nonmatching_missing_nonstring_and_short_bodies_remain_unchanged() {
        let free = "free:".repeat(60);
        let managed = "answer:".repeat(60);
        let body = format!("{free}{managed}");
        let values = [
            context(
                Some(json!(format!("{managed}{free}"))),
                json!(free),
                json!(managed),
                false,
            ),
            context(
                Some(json!(format!("{free}{managed}extra"))),
                json!(free),
                json!(managed),
                false,
            ),
            context(Some(json!(body)), json!(free), json!(false), false),
            context(Some(json!("")), json!(""), json!(""), true),
            context(Some(json!("short")), json!(""), json!("short"), false),
            context(Some(Value::Null), json!(""), json!(""), false),
            context(
                Some(json!({"ref":"user data"})),
                json!(""),
                json!(""),
                false,
            ),
            context(None, json!(""), json!(""), false),
        ];
        for input in values {
            let mut original = input.into_json();
            let marker = &original["markersFromAxum"][ID];
            let mut properties = json!({"retained":true});
            if let Some(normal) = marker.get("detail") {
                properties["memo"] = normal.clone();
            }
            original["shapesFromAxum"] = json!([{"id":ID,"geojson":{"properties":properties}}]);
            original["popupBodies"][format!("shape:{ID}")] =
                original["popupBodies"][format!("marker:{ID}")].clone();
            let input = Context::from_value(original.clone()).unwrap();
            let encoded = encode_context(input).unwrap().into_json();
            assert_eq!(encoded, original);
            assert!(encoded.get("normalBodyReferences").is_none());
        }
        let mut mismatch =
            context(Some(json!(body)), json!(free), json!(managed), false).into_json();
        mismatch["markersFromAxum"][ID]["id"] = json!("00000000-0000-0000-0000-000000000002");
        assert_eq!(
            encode_context(Context::from_value(mismatch.clone()).unwrap())
                .unwrap()
                .into_json(),
            mismatch
        );
        let mut missing_popup =
            context(Some(json!(body)), json!(free), json!(managed), false).into_json();
        missing_popup["popupBodies"] = json!({});
        assert_eq!(
            encode_context(Context::from_value(missing_popup.clone()).unwrap())
                .unwrap()
                .into_json(),
            missing_popup
        );
    }

    #[test]
    fn short_guard_is_strict_and_each_reference_covers_the_entire_sidecar() {
        let bound = REFERENCE_FIXED_BYTES + html_safe_json_string_token_bytes(ID).unwrap() + 1;
        for (length, expected) in [(bound - 2, false), (bound - 1, true)] {
            let body = "x".repeat(length);
            let input = context(Some(json!(body)), json!(""), json!(body), false);
            let encoded = encode_context(input.clone()).unwrap().into_json();
            assert_eq!(encoded.get("normalBodyReferences").is_some(), expected);
            assert_eq!(restore(encoded.clone()), input.clone().into_json());
            if expected {
                // 見積もりだけでなく、実際の本番テンプレートで比較する。
                let mut tera = crate::build_tera_from_embed().unwrap();
                tera.add_raw_template("transport-size", concat!(
                    "{\"markers\":{{ markersFromAxum | json_encode_for_html | safe }}",
                    "{% if normalBodyReferences is defined %},\n            \"normalBodyReferences\": {{ normalBodyReferences | json_encode_for_html | safe }}{% endif %}}"
                )).unwrap();
                assert!(
                    tera.render("transport-size", &Context::from_value(encoded).unwrap())
                        .unwrap()
                        .len()
                        < tera.render("transport-size", &input).unwrap().len()
                );
            }
        }
    }
}
