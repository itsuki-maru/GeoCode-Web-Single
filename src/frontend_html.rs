//! 共通HTMLのmanifest参照だけを、SQLite版の同梱資材へ向ける。

pub(crate) fn localize_manifest(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut result = String::with_capacity(html.len());
    let mut cursor = 0;
    while let Some(offset) = html[cursor..].find('<') {
        let start = cursor + offset;
        result.push_str(&html[cursor..start]);
        if lower[start..].starts_with("<!--") {
            let end = lower[start + 4..]
                .find("-->")
                .map_or(html.len(), |offset| start + 4 + offset + 3);
            result.push_str(&html[start..end]);
            cursor = end;
            continue;
        }
        let Some(end) = tag_end(html, start) else {
            result.push_str(&html[start..]);
            return result;
        };
        let name_end = html[start + 1..end]
            .bytes()
            .take_while(|byte| byte.is_ascii_alphanumeric())
            .count()
            + start
            + 1;
        let name = &lower[start + 1..name_end];
        // カスタム要素などの名前の前方一致で、link/script要素として解釈しない。
        if !html
            .as_bytes()
            .get(name_end)
            .is_some_and(|byte| byte.is_ascii_whitespace() || matches!(byte, b'>' | b'/'))
        {
            result.push_str(&html[start..end]);
            cursor = end;
            continue;
        }
        if name == "plaintext" {
            result.push_str(&html[start..]);
            return result;
        }
        if matches!(
            name,
            "script" | "style" | "textarea" | "title" | "xmp" | "iframe" | "noembed" | "noframes"
        ) {
            // JS/CSSの文字列中にあるHTMLらしい文字列は書き換えない。
            let raw_end = raw_text_end(&lower, name, end);
            result.push_str(&html[start..raw_end]);
            cursor = raw_end;
            continue;
        }
        if name == "link" {
            let tag = &html[start..end];
            result.push_str(&localize_link(tag, name_end - start));
        } else {
            result.push_str(&html[start..end]);
        }
        cursor = end;
    }
    result.push_str(&html[cursor..]);
    result
}

fn raw_text_end(lower: &str, name: &str, start: usize) -> usize {
    let needle = format!("</{name}");
    let mut cursor = start;
    while let Some(offset) = lower[cursor..].find(&needle) {
        let found = cursor + offset;
        let after = found + needle.len();
        if lower
            .as_bytes()
            .get(after)
            .is_some_and(|byte| byte.is_ascii_whitespace() || matches!(byte, b'>' | b'/'))
        {
            return found;
        }
        cursor = after;
    }
    lower.len()
}

fn tag_end(html: &str, start: usize) -> Option<usize> {
    let mut quote = None;
    for (offset, byte) in html.as_bytes()[start + 1..].iter().copied().enumerate() {
        if let Some(current) = quote {
            if byte == current {
                quote = None;
            }
        } else if byte == b'\'' || byte == b'"' {
            quote = Some(byte);
        } else if byte == b'>' {
            return Some(start + 1 + offset + 1);
        }
    }
    None
}

fn localize_link(tag: &str, mut cursor: usize) -> String {
    let bytes = tag.as_bytes();
    let mut relation = None;
    let mut href = None;
    while cursor < bytes.len() {
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let start = cursor;
        while cursor < bytes.len()
            && (bytes[cursor].is_ascii_alphanumeric()
                || matches!(bytes[cursor], b'-' | b'_' | b':'))
        {
            cursor += 1;
        }
        if start == cursor {
            break;
        }
        let name = &tag[start..cursor];
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b'=') {
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let quote = bytes
            .get(cursor)
            .copied()
            .filter(|byte| matches!(byte, b'\'' | b'"'));
        if quote.is_some() {
            cursor += 1;
        }
        let value_start = cursor;
        while cursor < bytes.len()
            && match quote {
                Some(quote) => bytes[cursor] != quote,
                None => !bytes[cursor].is_ascii_whitespace() && bytes[cursor] != b'>',
            }
        {
            cursor += 1;
        }
        let value_end = cursor;
        if quote.is_some() {
            if cursor == bytes.len() {
                return tag.into();
            }
            cursor += 1;
        }
        if name.eq_ignore_ascii_case("rel") {
            if relation.is_some() {
                return tag.into();
            }
            relation = Some(&tag[value_start..value_end]);
        } else if name.eq_ignore_ascii_case("href") {
            if href.is_some() {
                return tag.into();
            }
            href = Some((value_start, value_end));
        }
    }
    if !relation.is_some_and(|rel| {
        rel.split_ascii_whitespace()
            .any(|token| token.eq_ignore_ascii_case("manifest"))
    }) {
        return tag.into();
    }
    let Some((start, end)) = href else {
        return tag.into();
    };
    let local = match &tag[start..end] {
        "https://geocode-web-mobile-app.pages.dev/assets/manifest-tab.json" => {
            "/assets/manifest-tab.json"
        },
        "https://geocode-web-mobile-app.pages.dev/assets/manifest.json" => "/assets/manifest.json",
        _ => return tag.into(),
    };
    format!("{}{local}{}", &tag[..start], &tag[end..])
}

#[cfg(test)]
mod tests {
    use super::*;
    const REMOTE: &str = "https://geocode-web-mobile-app.pages.dev/assets/manifest.json";

    #[test]
    fn custom_elementを標準タグの前方一致で解釈しない() {
        let html = format!(
            "<link-widget rel=manifest href='{REMOTE}'></link-widget><script-widget></script-widget><link rel=manifest href='{REMOTE}'>"
        );
        let changed = localize_manifest(&html);
        assert!(changed.starts_with(&format!("<link-widget rel=manifest href='{REMOTE}'>")));
        assert!(changed.ends_with("<link rel=manifest href='/assets/manifest.json'>"));
    }

    #[test]
    fn 終端名の前方一致や文字列領域を本物のリンクと誤認しない() {
        for name in [
            "script",
            "style",
            "textarea",
            "title",
            "xmp",
            "iframe",
            "noembed",
            "noframes",
            "plaintext",
        ] {
            let html =
                format!("<{name}>引用 </{name}extra><link rel=manifest href='{REMOTE}'></{name}>");
            assert_eq!(localize_manifest(&html), html, "{name}");
        }
    }

    #[test]
    fn manifestだけを書き換えコメントやスクリプトや通常リンクを保持する() {
        let html = format!(
            "<!-- <link rel='manifest' href='{REMOTE}'> --><script>const a=\"<link rel='manifest' href='{REMOTE}'>\";</script><a href='{REMOTE}'>出典</a><LINK title='a > b' HREF='{REMOTE}' REL='alternate MANIFEST'>"
        );
        let changed = localize_manifest(&html);
        assert_eq!(changed.matches(REMOTE).count(), 3);
        assert!(changed.ends_with(
            "<LINK title='a > b' HREF='/assets/manifest.json' REL='alternate MANIFEST'>"
        ));
        assert_eq!(localize_manifest(&changed), changed);
    }

    #[test]
    fn タブレットと引用符省略と未知参照の扱いを固定する() {
        let html = "<link rel=manifest href=https://geocode-web-mobile-app.pages.dev/assets/manifest-tab.json><link rel=icon href='https://geocode-web-mobile-app.pages.dev/assets/manifest.json'><link rel=manifest href='/custom.json'>";
        let changed = localize_manifest(html);
        assert!(changed.starts_with("<link rel=manifest href=/assets/manifest-tab.json>"));
        assert!(changed.contains("rel=icon href='https://"));
        assert!(changed.ends_with("<link rel=manifest href='/custom.json'>"));
    }
}
