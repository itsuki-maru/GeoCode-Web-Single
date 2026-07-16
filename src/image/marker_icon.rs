use crate::error::AppError;
use image::{DynamicImage, GenericImage, ImageFormat, RgbaImage, imageops::FilterType};
use std::io::Cursor;

pub const MARKER_ICON_SIZE: u32 = 30;
pub const MAX_MARKER_ICON_FILE_SIZE_BYTES: usize = 5 * 1024 * 1024;

pub fn process_marker_icon(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    if bytes.is_empty() || bytes.len() > MAX_MARKER_ICON_FILE_SIZE_BYTES {
        return Err(AppError::Validation(
            "marker icon must be 5MB or smaller".to_string(),
        ));
    }
    let decoded = image::load_from_memory(bytes)
        .map_err(|_| AppError::Validation("invalid marker icon image".to_string()))?;
    let resized = decoded.resize(MARKER_ICON_SIZE, MARKER_ICON_SIZE, FilterType::Lanczos3);
    let mut canvas = RgbaImage::new(MARKER_ICON_SIZE, MARKER_ICON_SIZE);
    let x = (MARKER_ICON_SIZE - resized.width()) / 2;
    let y = (MARKER_ICON_SIZE - resized.height()) / 2;
    canvas
        .copy_from(&resized.to_rgba8(), x, y)
        .map_err(|_| AppError::InternalServerError)?;
    let mut output = Vec::new();
    DynamicImage::ImageRgba8(canvas)
        .write_to(&mut Cursor::new(&mut output), ImageFormat::Png)
        .map_err(|_| AppError::InternalServerError)?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_a_thirty_pixel_png() {
        let mut source = Vec::new();
        DynamicImage::new_rgba8(80, 40)
            .write_to(&mut Cursor::new(&mut source), ImageFormat::Png)
            .unwrap();
        let result = process_marker_icon(&source).unwrap();
        let image = image::load_from_memory(&result).unwrap();
        assert_eq!((image.width(), image.height()), (30, 30));
    }
}
