use crate::image::exif;
use anyhow::Result;
use image::{DynamicImage, GenericImageView, imageops::FilterType};
use std::path::Path;
use std::path::PathBuf;

pub fn resizer(
    target: &PathBuf,
    output_dir: PathBuf,
    new_long_side_pixel: u32,
    save_file_name: &str,
) -> Result<()> {
    if let Ok(image) = image::open(&target) {
        let orientation = exif::get_orientation(&target.to_string_lossy());
        let image = exif::fix_orientation(&image, orientation);
        let resized_image = resize_image(&image, new_long_side_pixel);
        let output_path = Path::new(&output_dir.clone()).join(save_file_name);
        resized_image.save(output_path)?;
    }
    Ok(())
}

fn resize_image(image: &DynamicImage, new_long_side_pixel: u32) -> DynamicImage {
    // 現在の縦横サイズを取得
    let (width, height) = image.dimensions();

    // 長辺が指定サイズに満たない場合は元のサイズでリターン
    if width < new_long_side_pixel {
        return image.resize_exact(width, height, FilterType::Lanczos3);
    }
    // アスペクト比を維持して高さを計算
    let target_height = (new_long_side_pixel as f32 * height as f32 / width as f32).round() as u32;
    // 縦横をピクセル指定でリサイズ
    image.resize_exact(new_long_side_pixel, target_height, FilterType::Lanczos3)
}
