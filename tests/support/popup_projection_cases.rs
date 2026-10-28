use serde_json::{Value, json};
use uuid::Uuid;

pub struct PopupCase {
    pub name: &'static str,
    pub markdown: Vec<&'static str>,
    pub body: &'static str,
    parts: Option<Value>,
    free: &'static str,
    sync: bool,
}

impl PopupCase {
    pub fn new(
        name: &'static str,
        markdown: Vec<&'static str>,
        body: &'static str,
        parts: Option<Value>,
        free: &'static str,
        sync: bool,
    ) -> Self {
        Self {
            name,
            markdown,
            body,
            parts,
            free,
            sync,
        }
    }

    pub fn stored_parts(&self, ids: &[Uuid]) -> Option<Value> {
        self.parts.clone().map(|mut parts| {
            for part in parts.as_array_mut().unwrap() {
                if part["type"] == "answer" {
                    let index = part["id"].as_u64().unwrap() as usize;
                    part["id"] = json!(ids.get(index).copied().unwrap_or(Uuid::nil()));
                }
            }
            parts
        })
    }

    pub fn expected(&self) -> Value {
        json!({"free_text":self.free,"managed_markdown":self.markdown.concat(),"sync_required":self.sync})
    }
}

pub fn cases() -> Vec<PopupCase> {
    vec![
        PopupCase::new(
            "stored order differs from answer order",
            vec!["A\n", "B\n"],
            "前B\n中A\n後",
            Some(
                json!([{"type":"text","text":"前"},{"type":"answer","id":1},{"type":"text","text":"中"},{"type":"answer","id":0},{"type":"text","text":"後"}]),
            ),
            "前中後",
            false,
        ),
        PopupCase::new(
            "legacy Unicode byte offsets",
            vec!["**回答🗾**\n", "e\u{301}追記🙂"],
            "前置き漢字**回答🗾**\n間e\u{301}追記🙂末尾🧰",
            None,
            "前置き漢字間末尾🧰",
            false,
        ),
        PopupCase::new(
            "legacy repeated match",
            vec!["同じ\n"],
            "同じ\n同じ\n",
            None,
            "",
            true,
        ),
        PopupCase::new(
            "legacy duplicate answer texts",
            vec!["同じ\n", "同じ\n"],
            "自由同じ\n",
            None,
            "",
            true,
        ),
        PopupCase::new(
            "stored duplicate texts keep separate IDs",
            vec!["同じ\n", "同じ\n"],
            "自由同じ\n同じ\n",
            Some(
                json!([{"type":"text","text":"自由"},{"type":"answer","id":1},{"type":"answer","id":0}]),
            ),
            "自由",
            false,
        ),
        PopupCase::new(
            "legacy overlapping answer texts",
            vec!["abcd", "bc"],
            "free:abcd",
            None,
            "",
            true,
        ),
        PopupCase::new(
            "legacy missing answer text",
            vec!["ない回答"],
            "自由のみ",
            None,
            "",
            true,
        ),
        PopupCase::new(
            "legacy empty markdown",
            vec![""],
            "空の自由🌸",
            None,
            "",
            true,
        ),
        PopupCase::new(
            "stored empty markdown",
            vec![""],
            "空の自由🌸",
            Some(json!([{"type":"text","text":"空の自由🌸"},{"type":"answer","id":0}])),
            "空の自由🌸",
            false,
        ),
        PopupCase::new(
            "stored duplicate answer reference",
            vec!["同じ"],
            "同じ同じ",
            Some(json!([{"type":"answer","id":0},{"type":"answer","id":0}])),
            "",
            true,
        ),
        PopupCase::new(
            "stored mismatch does not adopt legacy body",
            vec!["答"],
            "自由答",
            Some(json!([{"type":"text","text":"不一致"},{"type":"answer","id":0}])),
            "",
            true,
        ),
        PopupCase::new(
            "stored unknown answer reference",
            vec!["答"],
            "答",
            Some(json!([{"type":"answer","id":99}])),
            "",
            true,
        ),
        PopupCase::new("legacy empty body", vec![""], "", None, "", true),
        PopupCase::new(
            "stored empty body",
            vec![""],
            "",
            Some(json!([{"type":"answer","id":0}])),
            "",
            false,
        ),
    ]
}
