use std::fmt;
use std::str::FromStr;

#[derive(Debug)]
pub enum FileAllowExtension {
    Png,
    PNG,
    Jpg,
    JPG,
    Jpeg,
    JPEG,
    Gif,
    GIF,
    Webp,
    WEBP,
    Pdf,
    Mp4,
    MP4,
    Invalid(String),
}

impl fmt::Display for FileAllowExtension {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match *self {
            FileAllowExtension::Png => write!(f, "png"),
            FileAllowExtension::PNG => write!(f, "PNG"),
            FileAllowExtension::Jpg => write!(f, "jpg"),
            FileAllowExtension::JPG => write!(f, "JPG"),
            FileAllowExtension::Jpeg => write!(f, "jpeg"),
            FileAllowExtension::JPEG => write!(f, "JPEG"),
            FileAllowExtension::Gif => write!(f, "gif"),
            FileAllowExtension::GIF => write!(f, "GIF"),
            FileAllowExtension::Webp => write!(f, "webp"),
            FileAllowExtension::WEBP => write!(f, "WEBP"),
            FileAllowExtension::Pdf => write!(f, "pdf"),
            FileAllowExtension::Mp4 => write!(f, "mp4"),
            FileAllowExtension::MP4 => write!(f, "MP4"),
            FileAllowExtension::Invalid(ref ext) => write!(f, "Invalid extension: {}", ext),
        }
    }
}

impl FromStr for FileAllowExtension {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "png" => Ok(FileAllowExtension::Png),
            "PNG" => Ok(FileAllowExtension::PNG),
            "jpg" => Ok(FileAllowExtension::Jpg),
            "JPG" => Ok(FileAllowExtension::JPG),
            "jpeg" => Ok(FileAllowExtension::Jpeg),
            "JPEG" => Ok(FileAllowExtension::JPEG),
            "gif" => Ok(FileAllowExtension::Gif),
            "GIF" => Ok(FileAllowExtension::GIF),
            "webp" => Ok(FileAllowExtension::Webp),
            "WEBP" => Ok(FileAllowExtension::WEBP),
            "pdf" => Ok(FileAllowExtension::Pdf),
            "mp4" => Ok(FileAllowExtension::Mp4),
            "MP4" => Ok(FileAllowExtension::MP4),
            ext => Ok(FileAllowExtension::Invalid(ext.to_string())),
        }
    }
}

pub fn check_file_extension(ext: String) -> Result<FileAllowExtension, String> {
    match ext.parse::<FileAllowExtension>() {
        Ok(FileAllowExtension::Invalid(_)) => Err(format!("Unsupported file extension: {}", ext)),
        Ok(valid_ext) => Ok(valid_ext),
        Err(_) => Err(format!("Error parsing file extension: {}", ext)),
    }
}
