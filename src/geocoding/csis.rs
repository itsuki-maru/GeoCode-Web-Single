use super::{Geometry, SearchResult, result};
use crate::error::AppError;
use reqwest::Url;

pub(super) fn query(url: &mut Url, address: &str) {
    url.query_pairs_mut()
        .append_pair("addr", address)
        .append_pair("charset", "UTF8")
        .append_pair("series", "ADDRESS");
}

pub(super) fn parse(bytes: &[u8]) -> Result<Vec<SearchResult>, AppError> {
    let xml = std::str::from_utf8(bytes).map_err(|_| AppError::BadGateway)?;
    // DTDs (including external entities) are disabled by the parser by default.
    let document = roxmltree::Document::parse(xml).map_err(|_| AppError::BadGateway)?;
    let root = document.root_element();
    if !root.has_tag_name("results") {
        return Err(AppError::BadGateway);
    }
    if let Some(geodetic) = root.children().find(|node| node.has_tag_name("geodetic")) {
        if geodetic.text().unwrap_or("").trim() != "wgs1984" {
            return Err(AppError::BadGateway);
        }
    }
    Ok(root
        .children()
        .filter(|node| node.has_tag_name("candidate"))
        .filter_map(|candidate| {
            let field = |name| {
                candidate
                    .children()
                    .find(|node| node.has_tag_name(name))
                    .and_then(|node| node.text())
            };
            let latitude = field("latitude")?.trim().parse::<f64>().ok()?;
            let longitude = field("longitude")?.trim().parse::<f64>().ok()?;
            let address = field("address").unwrap_or("").trim().to_owned();
            result(
                Some(Geometry {
                    kind: "Point".into(),
                    coordinates: vec![longitude, latitude],
                }),
                address,
            )
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_utf8_candidates_in_order_and_skips_unusable_coordinates() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <results><geodetic>wgs1984</geodetic>
        <candidate><address>東京都/目黒区 &amp; 駒場</address><latitude>35.662941</latitude><longitude>139.677521</longitude></candidate>
        <candidate><address>missing</address></candidate>
        <candidate><latitude>NaN</latitude><longitude>139</longitude></candidate>
        <candidate><latitude>35</latitude><longitude>181</longitude></candidate>
        <candidate><latitude>invalid</latitude><longitude>139</longitude></candidate>
        <candidate><address>茨城県/取手市</address><latitude>35.915131</latitude><longitude>140.053268</longitude></candidate>
        </results>"#;
        let results = parse(xml.as_bytes()).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].address, "東京都/目黒区 & 駒場");
        assert_eq!(
            (results[0].latitude, results[0].longitude),
            (35.662941, 139.677521)
        );
        assert_eq!(results[1].address, "茨城県/取手市");
        assert_eq!(parse(b"<results><candidate><latitude>35</latitude><longitude>139</longitude></candidate></results>").unwrap().len(), 1);
    }

    #[test]
    fn distinguishes_no_matches_from_invalid_responses() {
        assert!(
            parse(b"<results><iConf>0</iConf></results>")
                .unwrap()
                .is_empty()
        );
        for xml in [
            "<html>error</html>",
            "<results>",
            "<results/><results/>",
            "<results><geodetic>tokyo</geodetic></results>",
            "<!DOCTYPE results [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><results>&x;</results>",
        ] {
            assert!(parse(xml.as_bytes()).is_err(), "{xml}");
        }
        assert!(parse(&[0xff]).is_err());
    }
}
