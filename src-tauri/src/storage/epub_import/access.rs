use super::*;

const EPUB_MAX_ENTRY_COUNT: usize = 10_000;
const EPUB_MAX_ENTRY_BYTES: u64 = 1024 * 1024 * 1024;
const EPUB_MAX_EXPANDED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const EPUB_MAX_COMPRESSION_RATIO: u64 = 1_000;
const EPUB_COMPRESSION_RATIO_MIN_BYTES: u64 = 1024 * 1024;
pub(in crate::storage) const EPUB_XML_READ_LIMIT: u64 = 8 * 1024 * 1024;
pub(in crate::storage) const EPUB_COVER_READ_LIMIT: u64 = 64 * 1024 * 1024;
pub(in crate::storage) const EPUB_SEARCH_DOCUMENT_READ_LIMIT: u64 = 32 * 1024 * 1024;
pub(in crate::storage) const EPUB_MAX_SEARCH_TEXT_BYTES: u64 = 512 * 1024 * 1024;

pub(in crate::storage) fn read_bounded_bytes(
    reader: impl Read,
    limit: u64,
    description: &str,
) -> Result<Vec<u8>, String> {
    let capacity = usize::try_from(limit.min(1024 * 1024)).unwrap_or(1024 * 1024);
    let mut data = Vec::with_capacity(capacity);
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut data)
        .map_err(|error| error.to_string())?;
    if data.len() as u64 > limit {
        return Err(format!("{description} exceeds the supported size limit"));
    }
    Ok(data)
}

pub(in crate::storage) fn inspect_epub_access(path: &Path) -> Result<EpubAccessInfo, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    validate_epub_archive_limits(&mut archive)?;
    let mut flags = Vec::new();
    let mut has_non_portable_path = false;
    let mut declares_encryption = false;

    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = file.name().replace('\\', "/");
        if non_portable_zip_path(&name) {
            has_non_portable_path = true;
        }
        if name.eq_ignore_ascii_case("META-INF/encryption.xml") {
            declares_encryption = true;
        }
    }

    if has_non_portable_path {
        flags.push(BookContentFlag::NonPortableArchivePaths);
    }
    if declares_encryption {
        flags.push(BookContentFlag::DeclaresEncryption);
    }

    Ok(EpubAccessInfo {
        mode: if has_non_portable_path {
            BookContentMode::ArchiveOnly
        } else {
            BookContentMode::Normal
        },
        flags,
    })
}

pub(in crate::storage) fn validate_epub_archive_limits<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<(), String> {
    if archive.len() > EPUB_MAX_ENTRY_COUNT {
        return Err("EPUB contains too many archive entries".to_string());
    }

    let mut total_size = 0u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|error| error.to_string())?;
        let size = file.size();
        if size > EPUB_MAX_ENTRY_BYTES {
            return Err(format!("EPUB entry exceeds the supported size limit: {}", file.name()));
        }
        total_size = total_size
            .checked_add(size)
            .ok_or_else(|| "EPUB expanded size overflows the supported limit".to_string())?;
        if total_size > EPUB_MAX_EXPANDED_BYTES {
            return Err("EPUB expanded content exceeds the supported size limit".to_string());
        }

        let compressed_size = file.compressed_size();
        if size >= EPUB_COMPRESSION_RATIO_MIN_BYTES
            && compressed_size > 0
            && size / compressed_size > EPUB_MAX_COMPRESSION_RATIO
        {
            return Err(format!("EPUB entry has an unsafe compression ratio: {}", file.name()));
        }
    }
    Ok(())
}

pub(super) fn non_portable_zip_path(path: &str) -> bool {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .any(non_portable_path_segment)
}

pub(super) fn non_portable_path_segment(segment: &str) -> bool {
    let invalid_character = segment
        .chars()
        .any(|character| matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*'));
    if invalid_character || segment.ends_with(' ') || segment.ends_with('.') {
        return true;
    }

    let stem = segment
        .split_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(segment)
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

pub(in crate::storage) fn unpack_epub(path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    validate_epub_archive_limits(&mut archive)?;

    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(dest).map_err(|error| error.to_string())?;

    let result = (|| {
        let mut expanded_size = 0u64;
        for index in 0..archive.len() {
            let file = archive.by_index(index).map_err(|error| error.to_string())?;
            let Some(enclosed_name) = file.enclosed_name() else {
                continue;
            };
            let outpath = dest.join(enclosed_name);

            if file.is_dir() {
                fs::create_dir_all(&outpath).map_err(|error| error.to_string())?;
                continue;
            }

            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }

            let remaining_total = EPUB_MAX_EXPANDED_BYTES.saturating_sub(expanded_size);
            let entry_limit = EPUB_MAX_ENTRY_BYTES.min(remaining_total);
            let mut outfile = fs::File::create(&outpath).map_err(|error| error.to_string())?;
            let copied = std::io::copy(&mut file.take(entry_limit.saturating_add(1)), &mut outfile)
                .map_err(|error| error.to_string())?;
            if copied > entry_limit {
                return Err("EPUB expanded content exceeds the supported size limit".to_string());
            }
            expanded_size = expanded_size
                .checked_add(copied)
                .ok_or_else(|| "EPUB expanded size overflows the supported limit".to_string())?;
        }

        Ok(())
    })();

    if result.is_err()
        && let Err(error) = fs::remove_dir_all(dest)
    {
        eprintln!("Failed to clean rejected EPUB extraction: {error}");
    }

    result
}

pub(in crate::storage) fn find_unpacked_opf_path(unpacked_dir: &Path) -> Result<PathBuf, String> {
    let container_path = unpacked_dir.join("META-INF").join("container.xml");
    let container = String::from_utf8(read_bounded_bytes(
        fs::File::open(&container_path).map_err(|error| error.to_string())?,
        EPUB_XML_READ_LIMIT,
        "EPUB container",
    )?)
    .map_err(|error| error.to_string())?;
    let container_doc = roxmltree::Document::parse(&container).map_err(|error| error.to_string())?;
    let opf_path = container_doc
        .descendants()
        .find(|node| node.has_tag_name("rootfile"))
        .and_then(|node| node.attribute("full-path"))
        .ok_or_else(|| "EPUB container has no rootfile".to_string())?;
    let normalized = normalize_zip_path(opf_path.replace('\\', "/"));
    if normalized.is_empty() {
        return Err("EPUB container has invalid rootfile".to_string());
    }

    Ok(unpacked_dir.join(normalized))
}
