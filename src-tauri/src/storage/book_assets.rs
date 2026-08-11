use std::{fs, io::Cursor, path::Path};

use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, imageops::FilterType};

use super::*;

const LIBRARY_COVER_MAX_WIDTH: u32 = 320;
const LIBRARY_COVER_MAX_HEIGHT: u32 = 480;
const LIBRARY_COVER_WEBP_QUALITY: f32 = 90.0;

pub(super) fn write_cover(storage: &AppStorage, id: &str, cover: Option<CoverInput>) -> Result<(), String> {
    remove_cover_files(storage, id)?;

    let Some(cover) = cover else {
        return Ok(());
    };

    let extension = sanitize_cover_extension(&cover.extension, &cover.mime_type);
    if extension.is_empty() || cover.data.is_empty() {
        return Ok(());
    }

    let (extension, data) = if matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "webp") {
        library_cover_thumbnail(&cover.data, &extension).unwrap_or((extension, cover.data))
    } else {
        (extension, cover.data)
    };
    let path = storage.book_dir(id).join(format!("{COVER_STEM}.{extension}"));
    fs::write(path, data).map_err(|error| error.to_string())
}

fn library_cover_thumbnail(data: &[u8], extension: &str) -> Option<(String, Vec<u8>)> {
    let image = if extension == "webp" {
        let decoded = webp::Decoder::new(data).decode()?;
        let (width, height) = (decoded.width(), decoded.height());
        if decoded.is_alpha() {
            DynamicImage::ImageRgba8(image::RgbaImage::from_raw(width, height, decoded.to_vec())?)
        } else {
            DynamicImage::ImageRgb8(image::RgbImage::from_raw(width, height, decoded.to_vec())?)
        }
    } else {
        let format = match extension {
            "jpg" | "jpeg" => ImageFormat::Jpeg,
            "png" => ImageFormat::Png,
            _ => return None,
        };
        let reader = ImageReader::with_format(Cursor::new(data), format);
        let mut decoder = reader.into_decoder().ok()?;
        let orientation = decoder
            .orientation()
            .unwrap_or(image::metadata::Orientation::NoTransforms);
        let mut image = DynamicImage::from_decoder(decoder).ok()?;
        image.apply_orientation(orientation);
        image
    };
    let image = if image.width() > LIBRARY_COVER_MAX_WIDTH || image.height() > LIBRARY_COVER_MAX_HEIGHT {
        image.resize(LIBRARY_COVER_MAX_WIDTH, LIBRARY_COVER_MAX_HEIGHT, FilterType::Lanczos3)
    } else {
        image
    };
    let output = if image.color().has_alpha() {
        let pixels = image.to_rgba8();
        webp::Encoder::from_rgba(pixels.as_raw(), image.width(), image.height()).encode(LIBRARY_COVER_WEBP_QUALITY)
    } else {
        let pixels = image.to_rgb8();
        webp::Encoder::from_rgb(pixels.as_raw(), image.width(), image.height()).encode(LIBRARY_COVER_WEBP_QUALITY)
    };
    Some(("webp".to_string(), output.to_vec()))
}

pub(super) fn read_cover(storage: &AppStorage, id: &str) -> Result<Option<String>, String> {
    let dir = storage.book_dir(id);
    if !dir.exists() {
        return Ok(None);
    }

    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if is_cover_file(&path) {
            return Ok(Some(path.to_string_lossy().to_string()));
        }
    }

    Ok(None)
}

pub(super) fn read_cover_record(storage: &AppStorage, id: String) -> Result<CoverRecord, String> {
    Ok(CoverRecord {
        cover: read_cover(storage, &id)?,
        id,
    })
}

pub(super) fn remove_cover_files(storage: &AppStorage, id: &str) -> Result<(), String> {
    let dir = storage.book_dir(id);
    if !dir.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if is_cover_file(&path) {
            let _ = fs::remove_file(path);
        }
    }

    Ok(())
}

pub(super) fn is_cover_file(path: &Path) -> bool {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem == COVER_STEM)
}

pub(super) fn sanitize_cover_extension(extension: &str, mime_type: &str) -> String {
    let extension = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>();

    if matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg") {
        return extension;
    }

    match mime_type {
        "image/jpeg" => "jpg".to_string(),
        "image/png" => "png".to_string(),
        "image/gif" => "gif".to_string(),
        "image/webp" => "webp".to_string(),
        "image/svg+xml" => "svg".to_string(),
        _ => String::new(),
    }
}
