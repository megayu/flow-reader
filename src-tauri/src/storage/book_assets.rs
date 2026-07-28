use std::{fs, path::Path};

use serde_json::Value;

use super::*;
pub(super) fn write_metadata(storage: &AppStorage, id: &str, metadata: &Value) -> Result<(), String> {
    write_json(&storage.book_dir(id).join(METADATA_FILE), metadata)
}

pub(super) fn write_cover(storage: &AppStorage, id: &str, cover: Option<CoverInput>) -> Result<(), String> {
    remove_cover_files(storage, id)?;

    let Some(cover) = cover else {
        return Ok(());
    };

    let extension = sanitize_cover_extension(&cover.extension, &cover.mime_type);
    if extension.is_empty() || cover.data.is_empty() {
        return Ok(());
    }

    let path = storage.book_dir(id).join(format!("{COVER_STEM}.{extension}"));
    fs::write(path, cover.data).map_err(|error| error.to_string())
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

pub(super) fn is_generated_text_cover(storage: &AppStorage, id: &str) -> Result<bool, String> {
    let Some(path) = read_cover(storage, id)? else {
        return Ok(true);
    };
    let path = PathBuf::from(path);
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"))
    {
        return Ok(false);
    }

    let svg = fs::read_to_string(path).unwrap_or_default();
    Ok(svg.contains(GENERATED_TEXT_COVER_MARKER)
        || (svg.contains(r##"<rect width="768" height="1024" fill="#ead7b5"/>"##) && svg.contains("Noto Serif CJK SC")))
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
