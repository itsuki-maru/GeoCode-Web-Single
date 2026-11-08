//! 公開投稿だけに適用する保存前の Markdown 安全化。
//!
//! Markdown 全体を HTML に変換して保存すると、コードや改行、参照リンク等の
//! 編集用データが変わる。Markdown の構文・ソース位置を使い、危険なリンクと
//! HTML だけを処理する。HTML は全断片をまとめて HTML5 パーサーへ渡し、
//! 開始タグを単独で処理した際の自動閉じタグによる表示崩れも避ける。

use pulldown_cmark::{Event, Options, Parser, Tag};
use std::collections::HashSet;
use std::ops::Range;
use uuid::Uuid;

const MAX_NORMALIZATION_PASSES: usize = 8;

fn parser(input: &str) -> Parser<'_> {
    // クライアントの GFM と同じ構文に限定する。クライアントにない数式構文等を
    // 有効にすると、その中にある HTML/リンクを検査せずに見逃す原因になる。
    Parser::new_ext(
        input,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
    )
}

fn allowed_url(url: &str) -> bool {
    let normalized: String = url
        .chars()
        .filter(|ch| !ch.is_whitespace() && !ch.is_control())
        .collect();
    let Some(colon) = normalized.find(':') else {
        return true;
    };
    // 相対パスのクエリー・フラグメント内の ':' はスキームではない。
    if normalized[..colon].contains(['/', '?', '#']) {
        return true;
    }
    matches!(
        normalized[..colon].to_ascii_lowercase().as_str(),
        "http" | "https" | "ftp" | "mailto" | "tel"
    )
}

fn literal_markdown(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    for ch in text.chars() {
        if matches!(
            ch,
            '\\' | '`'
                | '*'
                | '_'
                | '{'
                | '}'
                | '['
                | ']'
                | '('
                | ')'
                | '#'
                | '+'
                | '-'
                | '.'
                | '!'
                | '|'
                | '~'
                | '<'
                | '>'
        ) {
            output.push('\\');
        }
        output.push(ch);
    }
    output
}

fn apply_edits(input: &str, mut edits: Vec<(Range<usize>, String)>) -> String {
    if edits.is_empty() {
        return input.to_owned();
    }
    edits.sort_by_key(|(span, _)| (span.start, std::cmp::Reverse(span.end)));
    let mut output = String::with_capacity(input.len());
    let mut position = 0;
    for (span, replacement) in edits {
        if span.start < position {
            continue;
        }
        output.push_str(&input[position..span.start]);
        output.push_str(&replacement);
        position = span.end;
    }
    output.push_str(&input[position..]);
    output
}

fn sanitize_markdown_urls(input: &str) -> String {
    let parser = parser(input);
    let mut edits: Vec<_> = parser
        .reference_definitions()
        .iter()
        .filter(|(_, definition)| !allowed_url(&definition.dest))
        .map(|(_, definition)| (definition.span.clone(), String::new()))
        .collect();
    let mut events = parser.into_offset_iter();
    while let Some((event, range)) = events.next() {
        let destination = match &event {
            Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }) => dest_url,
            _ => continue,
        };
        if allowed_url(destination) {
            continue;
        }
        let mut depth = 1;
        let mut label = String::new();
        let mut end = range.end;
        for (child, span) in events.by_ref() {
            end = end.max(span.end);
            match child {
                Event::Start(_) => depth += 1,
                Event::End(_) => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                },
                Event::Text(text) | Event::Code(text) => label.push_str(&text),
                Event::SoftBreak | Event::HardBreak => label.push(' '),
                _ => {},
            }
        }
        edits.push((range.start..end, literal_markdown(&label)));
    }
    apply_edits(input, edits)
}

fn sanitize_html(input: &str) -> String {
    let mut ranges: Vec<Range<usize>> = Vec::new();
    for (event, span) in parser(input).into_offset_iter() {
        if !matches!(event, Event::Html(_) | Event::InlineHtml(_)) {
            continue;
        }
        if let Some(previous) = ranges.last_mut() {
            if span.start <= previous.end {
                previous.end = previous.end.max(span.end);
                continue;
            }
        }
        ranges.push(span);
    }
    if ranges.is_empty() {
        return input.to_owned();
    }

    // Markdown の部分はコメントへ退避する。テーブル内でも文字トークンのように
    // HTML5 の foster parenting で外側へ移動されず、コード中の HTML も解釈しない。
    let nonce = Uuid::new_v4().simple().to_string();
    let mut protected = Vec::new();
    let mut html = String::with_capacity(input.len());
    let mut position = 0;
    let mut protect = |source: &str, html: &mut String| {
        if source.is_empty() {
            return;
        }
        let marker = format!("<!--geocode-md-{nonce}-{}-->", protected.len());
        html.push_str(&marker);
        protected.push((marker, source.to_owned()));
    };
    for span in ranges {
        protect(&input[position..span.start], &mut html);
        html.push_str(&input[span.clone()]);
        position = span.end;
    }
    protect(&input[position..], &mut html);

    let mut builder = ammonia::Builder::default();
    builder
        .strip_comments(false)
        .url_schemes(HashSet::from(["http", "https", "ftp", "mailto", "tel"]))
        .add_tags(&["details", "summary"])
        .add_tag_attributes("a", &["target"])
        .add_clean_content_tags(&[
            "iframe",
            "object",
            "embed",
            "template",
            "svg",
            "math",
            "textarea",
            "title",
            "xmp",
            "plaintext",
            "noscript",
        ])
        .link_rel(Some("noopener noreferrer"));
    let cleaned = builder.clean(&html).to_string();
    let mut output = String::with_capacity(cleaned.len());
    let prefix = format!("<!--geocode-md-{nonce}-");
    let mut remaining = cleaned.as_str();
    // 断片数ごとに本文全体を replace せず、1 回の走査で復元する。
    while let Some(start) = remaining.find(&prefix) {
        output.push_str(&remaining[..start]);
        remaining = &remaining[start..];
        let Some(end) = remaining.find("-->").map(|end| end + 3) else {
            break;
        };
        let marker = &remaining[..end];
        let index = remaining[prefix.len()..end - 3].parse::<usize>().ok();
        if let Some((expected, source)) = index.and_then(|index| protected.get(index)) {
            if expected == marker {
                output.push_str(source);
            } else {
                output.push_str(marker);
            }
        } else {
            output.push_str(marker);
        }
        remaining = &remaining[end..];
    }
    output.push_str(remaining);
    output
}

pub(super) fn sanitize_public_markdown(input: &str) -> Option<String> {
    let mut current = input.to_owned();
    // タグの除去で隣り合った文字が、新しい Markdown/HTML 構文になる場合も再検査する。
    // 安定しない入力は、未検証の文字列を保存せず呼び出し元で検証エラーにする。
    for _ in 0..MAX_NORMALIZATION_PASSES {
        let next = sanitize_html(&sanitize_markdown_urls(&current));
        if next == current {
            return Some(next);
        }
        current = next;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(input: &str) -> String {
        sanitize_public_markdown(input).expect("安全化結果が安定すること")
    }

    #[test]
    /// 通常のMarkdown、コード、空白、参照リンクの原文を維持する。
    fn ordinary_markdown_is_unchanged_including_code_whitespace_and_references() {
        let source = "## 点検\n\n**強調** と [資料](https://example.test/guide)  \n次の行\n\n- 項目\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n    indented code\n\n```html\n<script>literal()</script>\n```\n\n`<a rel=opener>`\n\n[参照][doc]\n\n[doc]: /guide \"資料\"\n";
        assert_eq!(clean(source), source);
    }

    #[test]
    /// 危険なMarkdownリンク・画像URL・参照定義を除去し、ラベルを保持する。
    fn removes_unsafe_markdown_destinations_and_reference_definitions() {
        for destination in [
            "javascript:alert%281%29",
            "JaVaScRiPt:alert%281%29",
            "jav&#x61;script:alert%281%29",
            "data:text/html,bad",
            "vbscript:msgbox%281%29",
            "file:///secret",
        ] {
            let result = clean(&format!("[資料]({destination})\n\n![写真]({destination})"));
            assert_eq!(result, "資料\n\n写真", "{destination}");
        }
        assert_eq!(
            clean("[資料][bad]\n\n[bad]: javascript:alert(1)\n").trim_end(),
            "資料"
        );
        assert!(clean("[bad]: javascript:alert(1)\n").trim().is_empty());
        assert_eq!(
            clean("[安全](../guide?next=a:b#x)"),
            "[安全](../guide?next=a:b#x)"
        );
    }

    #[test]
    /// HTMLリンクとMarkdownのラベルを分断せず、危険な属性を除去する。
    fn sanitizes_html_without_breaking_inline_anchor_or_markdown_label() {
        let result = clean(
            "<a href=\"https://example.test/\" target=\"_blank\" rel=\"opener\" onclick=\"bad()\">**資料**</a>",
        );
        assert!(result.contains("href=\"https://example.test/\""));
        assert!(result.contains("rel=\"noopener noreferrer\""));
        assert!(result.contains(">**資料**</a>"));
        assert!(!result.contains("rel=\"opener\""));
        assert!(!result.contains("onclick"));
        assert!(!result.contains("bad()"));
        assert_eq!(clean(&result), result);
    }

    #[test]
    /// 動作するHTMLを除去し、HTML断片の間にあるコードの原文は維持する。
    fn strips_active_html_and_preserves_code_between_html_fragments() {
        let source = "<b>見出し</b>\n\n```html\n<script>literal()</script>\n```\n\n<div onclick=\"bad()\">本文</div>";
        let result = clean(source);
        assert!(result.contains("```html\n<script>literal()</script>\n```"));
        assert!(result.contains("<b>見出し</b>"));
        assert!(result.contains("本文</div>"));
        assert!(!result.contains("onclick"));
        for source in [
            "<script>alert(1)</script>",
            "<iframe srcdoc=\"bad\">bad</iframe>",
            "<svg onload=\"bad()\"><a>bad</a></svg>",
            "<style>bad</style>",
        ] {
            assert_eq!(clean(source), "", "{source}");
        }
    }

    #[test]
    /// 実体参照・重複属性・大文字小文字を使った危険な属性も除去する。
    fn validates_html_attributes_with_entities_duplicates_and_unusual_casing() {
        for source in [
            "<A HREF=\"jav&#x61;script:bad()\" TARGET=_BLANK REL=OpEnEr ONCLICK=bad()>資料</A>",
            "<a href=\"java&#10;script:bad()\" rel=opener rel=nofollow target=report>資料</a>",
            "<a href=\"data:text/html,bad\" rel=opener target=_blank>資料</a>",
            "<img src=\"javascript:bad()\" onerror=bad()>",
            "<math><mtext><table><mglyph><style><!--</style><img title=\"--><img src=x onerror=bad()>\">",
        ] {
            let safe = clean(source);
            assert!(!safe.contains("bad()"), "{source} -> {safe}");
            assert!(!safe.to_ascii_lowercase().contains("javascript:"), "{safe}");
            assert!(!safe.contains("rel=\"opener\""), "{safe}");
            assert_eq!(clean(&safe), safe);
        }
    }

    #[test]
    /// HTMLの囲み内のMarkdownと表の構造を維持する。
    fn preserves_markdown_in_html_containers_and_html_table_structure() {
        let source = "<details>\n<summary>点検</summary>\n\n- **重要**\n- [資料](/guide)\n\n```html\n<a onclick=\"literal()\">\n```\n\n</details>\n\n<table><tr><td>項目</td><td>値</td></tr></table>";
        let result = clean(source);
        assert!(result.contains("<details>"));
        assert!(result.contains("<summary>点検</summary>"));
        assert!(result.contains("- **重要**\n- [資料](/guide)"));
        assert!(result.contains("```html\n<a onclick=\"literal()\">\n```"));
        assert!(result.contains("<tr><td>項目</td><td>値</td></tr>"));
        assert!(!result.contains("geocode-md-"));
        assert_eq!(clean(&result), result);
    }
}
