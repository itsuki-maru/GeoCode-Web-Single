use geocode_web_single::image::{
    exif::{fix_orientation, get_orientation},
    resize::resizer,
};
use image::{DynamicImage, Rgba, RgbaImage};
use std::path::PathBuf;

struct Files(PathBuf);
impl Files {
    fn new() -> Self {
        let path =
            PathBuf::from("target/image-processing-tests").join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Files {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn every_exif_orientation_preserves_the_expected_pixel_positions() {
    let image = DynamicImage::ImageRgba8(RgbaImage::from_fn(3, 2, |x, y| {
        Rgba([(y * 3 + x + 1) as u8, 0, 0, 255])
    }));
    // 期待する各行は EXIF の向きを直接表した例であり、画像の変換処理に依存しない。
    for (orientation, width, height, expected) in [
        (1, 3, 2, vec![1, 2, 3, 4, 5, 6]),
        (2, 3, 2, vec![3, 2, 1, 6, 5, 4]),
        (3, 3, 2, vec![6, 5, 4, 3, 2, 1]),
        (4, 3, 2, vec![4, 5, 6, 1, 2, 3]),
        (5, 2, 3, vec![1, 4, 2, 5, 3, 6]),
        (6, 2, 3, vec![4, 1, 5, 2, 6, 3]),
        (7, 2, 3, vec![6, 3, 5, 2, 4, 1]),
        (8, 2, 3, vec![3, 6, 2, 5, 1, 4]),
        (99, 3, 2, vec![1, 2, 3, 4, 5, 6]),
    ] {
        let result = fix_orientation(&image, orientation).to_rgba8();
        assert_eq!(
            result.dimensions(),
            (width, height),
            "orientation {orientation}"
        );
        assert_eq!(
            result.pixels().map(|p| p[0]).collect::<Vec<_>>(),
            expected,
            "orientation {orientation}"
        );
    }
    assert_eq!(
        image.to_rgba8().pixels().map(|p| p[0]).collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5, 6]
    );
}

#[test]
fn reads_jpeg_orientation_and_rotates_before_resizing() {
    let files = Files::new();
    let source = files.0.join("source.jpg");
    DynamicImage::new_rgb8(8, 4).save(&source).unwrap();
    let jpeg = std::fs::read(&source).unwrap();
    // APP1 の構成: Exif ヘッダー、リトルエンディアンの TIFF、SHORT 型の Orientation 項目一つ（値は 6）。
    let exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
    let mut oriented = jpeg[..2].to_vec();
    oriented.extend(b"\xff\xe1");
    oriented.extend(((exif.len() + 2) as u16).to_be_bytes());
    oriented.extend(exif);
    oriented.extend(&jpeg[2..]);
    std::fs::write(&source, oriented).unwrap();
    assert_eq!(get_orientation(source.to_str().unwrap()), 6);
    resizer(&source, files.0.clone(), 2, "rotated.png").unwrap();
    assert_eq!(
        image::open(files.0.join("rotated.png"))
            .unwrap()
            .to_rgba8()
            .dimensions(),
        (2, 4)
    );
}

#[test]
fn small_images_keep_dimensions_and_failed_output_is_reported() {
    let files = Files::new();
    let source = files.0.join("small.png");
    DynamicImage::ImageRgba8(RgbaImage::from_pixel(3, 2, Rgba([15, 30, 60, 255])))
        .save(&source)
        .unwrap();
    assert_eq!(get_orientation(source.to_str().unwrap()), 1);
    resizer(&source, files.0.clone(), 450, "small-copy.png").unwrap();
    let result = image::open(files.0.join("small-copy.png"))
        .unwrap()
        .to_rgba8();
    assert_eq!(result.dimensions(), (3, 2));
    assert!(result.pixels().all(|p| *p == Rgba([15, 30, 60, 255])));
    assert!(
        resizer(
            &source,
            files.0.join("missing-directory"),
            450,
            "output.png"
        )
        .is_err()
    );
}

#[test]
fn missing_and_undecodable_inputs_use_default_orientation_and_create_no_output() {
    let files = Files::new();
    let source = files.0.join("bad.png");
    assert_eq!(get_orientation(source.to_str().unwrap()), 1);
    resizer(&source, files.0.clone(), 450, "missing.png").unwrap();
    assert!(!files.0.join("missing.png").exists());
    std::fs::write(&source, b"not an image").unwrap();
    assert_eq!(get_orientation(source.to_str().unwrap()), 1);
    resizer(&source, files.0.clone(), 450, "bad-copy.png").unwrap();
    assert!(!files.0.join("bad-copy.png").exists());
}
