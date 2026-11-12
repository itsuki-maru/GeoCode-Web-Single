//! 識別方式変更前に固定したPNGとRGBAを、現在の描画結果と比較する。

use geocode_web_single::tilegen;
use sha2::{Digest, Sha256};

#[path = "render_golden_support/mod.rs"]
mod support;

fn display_chunks(bytes: &[u8]) -> Vec<([u8; 4], Vec<u8>)> {
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    let mut cursor = 8;
    let mut chunks = Vec::new();
    while cursor < bytes.len() {
        let length = u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().unwrap()) as usize;
        let kind: [u8; 4] = bytes[cursor + 4..cursor + 8].try_into().unwrap();
        let data = &bytes[cursor + 8..cursor + 8 + length];
        if [
            *b"IHDR", *b"PLTE", *b"sRGB", *b"gAMA", *b"cHRM", *b"iCCP", *b"tRNS", *b"sBIT",
            *b"cICP", *b"mDCv", *b"cLLi",
        ]
        .contains(&kind)
        {
            chunks.push((kind, data.to_vec()));
        }
        cursor += 12 + length;
    }
    assert_eq!(cursor, bytes.len());
    chunks
}

#[test]
fn 描画方式変更前の固定画像とすべての画素が一致する() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/render-golden");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["source_ref"], "9c30ae1");
    let entries = manifest["cases"].as_array().unwrap();
    let cases = support::cases();
    assert_eq!(entries.len(), cases.len());
    for (case, entry) in cases.into_iter().zip(entries) {
        assert_eq!(entry["name"], case.name);
        let old_bytes = std::fs::read(root.join(format!("{}.png", case.name))).unwrap();
        let old = tiny_skia::Pixmap::decode_png(&old_bytes).unwrap();
        let current = tilegen::renderer::render_tile(
            case.tile,
            &tilegen::style::Style::roads_v1(),
            &case.candidates,
            |id| Ok(case.geometries.get(&id).unwrap().clone()),
        )
        .unwrap();
        assert_eq!((current.width(), current.height()), (256, 256));
        let actual = format!("{:x}", Sha256::digest(current.data()));
        assert_eq!(entry["rgba_sha256"], actual, "{}", case.name);
        assert_eq!(old.data(), current.data(), "{}", case.name);
        // 圧縮バイト列の違いは許容し、保存・復号後の画素を比較する。
        let encoded = current.encode_png().unwrap();
        let decoded = tiny_skia::Pixmap::decode_png(&encoded).unwrap();
        assert_eq!(decoded.data(), old.data(), "{}", case.name);
        assert_eq!(
            display_chunks(&encoded),
            display_chunks(&old_bytes),
            "{}の寸法・色解釈",
            case.name
        );
        assert!(
            decoded
                .data()
                .as_chunks::<4>()
                .0
                .iter()
                .all(|pixel| pixel[3] == 255)
        );
    }
}
