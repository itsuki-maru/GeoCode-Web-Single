use image::DynamicImage;
use rexif::parse_file;

pub fn get_orientation(path: &str) -> u16 {
    match parse_file(path) {
        Ok(exif) => {
            for entry in &exif.entries {
                if entry.tag == rexif::ExifTag::Orientation {
                    if let Some(val) = entry.value.to_i64(0) {
                        return val as u16;
                    }
                }
            }
        },
        Err(_e) => {},
    }
    1 // 回転なし（デフォルト）
}

pub fn fix_orientation(img: &DynamicImage, orientation: u16) -> DynamicImage {
    match orientation {
        2 => img.fliph(),             // 左右反転
        3 => img.rotate180(),         // 180度回転
        4 => img.flipv(),             // 上下反転
        5 => img.rotate90().fliph(),  // 90度回転+左右反転
        6 => img.rotate90(),          // 90度回転
        7 => img.rotate270().fliph(), // 270度回転+左右反転
        8 => img.rotate270(),         // 270度回転
        _ => img.clone(),             // 変更なし
    }
}
