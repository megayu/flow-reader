use super::*;

pub(super) fn percent_decode_path(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16)
        {
            decoded.push(byte);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&decoded).to_string()
}

pub(super) fn zip_path_candidates(path: &str) -> Vec<String> {
    let decoded = percent_decode_zip_path(path);
    if decoded == path {
        vec![path.to_string()]
    } else {
        vec![path.to_string(), decoded]
    }
}

pub(super) fn percent_decode_zip_path(path: &str) -> String {
    path.split('/')
        .map(percent_decode_path_segment)
        .collect::<Vec<_>>()
        .join("/")
}

pub(super) fn percent_decode_path_segment(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
        {
            decoded.push((high << 4) | low);
            index += 3;
            continue;
        }

        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8(decoded).unwrap_or_else(|_| segment.to_string())
}

pub(super) fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

pub(super) fn resolve_unpacked_resource_path(unpacked_dir: &Path, href: &str) -> Result<PathBuf, String> {
    let opf_path = find_unpacked_opf_path(unpacked_dir)?;
    let opf_dir = opf_path.parent().unwrap_or(unpacked_dir);
    let href = href.split('#').next().unwrap_or("").replace('\\', "/");
    let href = percent_decode_path(&href);
    let normalized = normalize_zip_path(href);
    if normalized.is_empty() {
        return Err("Selected section has an invalid href".to_string());
    }

    let candidate = opf_dir.join(normalized.trim_start_matches('/'));
    let canonical_unpacked = fs::canonicalize(unpacked_dir).map_err(|error| error.to_string())?;
    let canonical_candidate = fs::canonicalize(&candidate).map_err(|error| error.to_string())?;
    if !canonical_candidate.starts_with(canonical_unpacked) {
        return Err("Selected section is outside the unpacked book".to_string());
    }

    Ok(canonical_candidate)
}

pub(super) fn collect_files_sorted(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_files(root, &mut files)?;
    files.sort_by(|a, b| {
        let a = a.strip_prefix(root).unwrap_or(a);
        let b = b.strip_prefix(root).unwrap_or(b);
        a.cmp(b)
    });
    Ok(files)
}

pub(super) fn collect_files(path: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_dir() {
            collect_files(&path, files)?;
        } else if file_type.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

pub(super) fn zip_relative_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

pub(super) fn epub_entry_compression(relative: &str) -> CompressionMethod {
    let extension = relative
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif" | "mp3" | "mp4" | "m4a" | "ogg" | "opus" | "woff"
        | "woff2" | "ttf" | "otf" => CompressionMethod::Stored,
        _ => CompressionMethod::Deflated,
    }
}

pub(super) fn write_epub_file(
    writer: &mut ZipWriter<BufWriter<fs::File>>,
    relative: &str,
    path: &Path,
    deflate_level: Option<i64>,
) -> Result<(), String> {
    let content_options = SimpleFileOptions::default()
        .compression_method(epub_entry_compression(relative))
        .compression_level(deflate_level)
        .unix_permissions(0o644);
    writer
        .start_file(relative, content_options)
        .map_err(|error| error.to_string())?;
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    std::io::copy(&mut file, writer).map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn epub_entry_is_editable_text(relative: &str) -> bool {
    let extension = relative
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    matches!(extension.as_str(), "htm" | "html" | "xhtml" | "opf" | "ncx")
}

pub(super) fn unpacked_file_was_modified(path: &Path) -> Result<bool, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let modified = metadata.modified().map_err(|error| error.to_string())?;
    let created = match metadata.created() {
        Ok(created) => created,
        Err(_) => return Ok(true),
    };

    Ok(created != modified)
}

pub(super) fn should_copy_original_zip_entry(relative: &str, path: &Path) -> Result<bool, String> {
    if !epub_entry_is_editable_text(relative) {
        return Ok(true);
    }

    Ok(!unpacked_file_was_modified(path)?)
}

pub(super) fn original_epub_file_count<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<usize, String> {
    let mut count = 0usize;
    for index in 0..archive.len() {
        let name = archive
            .name_for_index(index)
            .ok_or_else(|| "Invalid EPUB entry index".to_string())?
            .to_string();
        let relative = normalize_zip_path(name.replace('\\', "/"));
        if relative.is_empty() {
            continue;
        }

        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if !entry.is_dir() {
            count += 1;
        }
    }
    Ok(count)
}

pub(super) fn write_epub_from_unpacked_dir(
    unpacked_dir: &Path,
    output_path: &Path,
    deflate_level: Option<i64>,
) -> Result<(), String> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let tmp = output_path.with_extension("tmp");
    let file = fs::File::create(&tmp).map_err(|error| error.to_string())?;
    let mut writer = ZipWriter::new(BufWriter::with_capacity(EPUB_ZIP_WRITER_BUFFER_SIZE, file));
    let stored = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o644);

    writer
        .start_file("mimetype", stored)
        .map_err(|error| error.to_string())?;
    let mimetype = fs::read(unpacked_dir.join("mimetype")).unwrap_or_else(|_| b"application/epub+zip".to_vec());
    writer.write_all(&mimetype).map_err(|error| error.to_string())?;

    for path in collect_files_sorted(unpacked_dir)? {
        let relative = zip_relative_path(unpacked_dir, &path)?;
        if relative == "mimetype" {
            continue;
        }
        write_epub_file(&mut writer, &relative, &path, deflate_level)?;
    }

    let mut output = writer.finish().map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())?;
    if output_path.exists() {
        fs::remove_file(output_path).map_err(|error| error.to_string())?;
    }
    fs::rename(&tmp, output_path).map_err(|error| error.to_string())
}

pub(super) fn write_epub_from_original_and_unpacked(
    original_epub: &Path,
    unpacked_dir: &Path,
    output_path: &Path,
) -> Result<(), String> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let source = fs::File::open(original_epub).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(source).map_err(|error| error.to_string())?;
    if original_epub_file_count(&mut archive)? != collect_files_sorted(unpacked_dir)?.len() {
        return write_epub_from_unpacked_dir(unpacked_dir, output_path, None);
    }

    let tmp = output_path.with_extension("tmp");
    let file = fs::File::create(&tmp).map_err(|error| error.to_string())?;
    let mut writer = ZipWriter::new(BufWriter::with_capacity(EPUB_ZIP_WRITER_BUFFER_SIZE, file));
    let stored = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o644);

    writer
        .start_file("mimetype", stored)
        .map_err(|error| error.to_string())?;
    let mimetype = fs::read(unpacked_dir.join("mimetype")).unwrap_or_else(|_| b"application/epub+zip".to_vec());
    writer.write_all(&mimetype).map_err(|error| error.to_string())?;

    let mut written = HashSet::from(["mimetype".to_string()]);
    for index in 0..archive.len() {
        let name = archive
            .name_for_index(index)
            .ok_or_else(|| "Invalid EPUB entry index".to_string())?
            .to_string();
        let relative = normalize_zip_path(name.replace('\\', "/"));
        if relative.is_empty() || relative == "mimetype" {
            continue;
        }

        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_dir() {
            continue;
        }
        drop(entry);

        let unpacked_path = unpacked_dir.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if !unpacked_path.is_file() {
            continue;
        }

        if should_copy_original_zip_entry(&relative, &unpacked_path)? {
            let raw_entry = archive.by_index(index).map_err(|error| error.to_string())?;
            writer.raw_copy_file(raw_entry).map_err(|error| error.to_string())?;
        } else {
            write_epub_file(&mut writer, &relative, &unpacked_path, None)?;
        }
        written.insert(relative);
    }

    for path in collect_files_sorted(unpacked_dir)? {
        let relative = zip_relative_path(unpacked_dir, &path)?;
        if written.contains(&relative) {
            continue;
        }
        write_epub_file(&mut writer, &relative, &path, None)?;
    }

    let mut output = writer.finish().map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())?;
    if output_path.exists() {
        fs::remove_file(output_path).map_err(|error| error.to_string())?;
    }
    fs::rename(&tmp, output_path).map_err(|error| error.to_string())
}

pub(super) fn export_book_impl(
    storage: &AppStorage,
    id: String,
    format: BookExportFormat,
    output_path: PathBuf,
) -> Result<Option<BookRecord>, String> {
    let initial_book = storage.library_book(&id)?;
    let source_format = initial_book.source_format;
    let content_mode = inspect_and_store_book_content_access(storage, &initial_book)?;
    let book_dir = storage.book_dir(&id);

    match format {
        BookExportFormat::Epub => {
            let unpacked_dir = book_dir.join(UNPACKED_DIR);
            match source_format {
                BookSourceFormat::Epub if content_mode == BookContentMode::ArchiveOnly || !unpacked_dir.exists() => {
                    let book_path = available_book_source_path(storage, &initial_book)?;
                    if let Some(parent) = output_path.parent() {
                        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                    }
                    fs::copy(&book_path, &output_path).map_err(|error| error.to_string())?;
                }
                BookSourceFormat::Epub => {
                    let original_epub = available_book_source_path(storage, &initial_book).ok();
                    if let Some(book_path) = original_epub {
                        write_epub_from_original_and_unpacked(&book_path, &unpacked_dir, &output_path)?;
                    } else {
                        write_epub_from_unpacked_dir(&unpacked_dir, &output_path, None)?;
                    }
                }
                BookSourceFormat::Txt => {
                    if !unpacked_dir.exists() {
                        materialize_library_text_publication(storage, &initial_book)?;
                    }
                    write_epub_from_unpacked_dir(&unpacked_dir, &output_path, Some(TXT_EPUB_DEFLATE_LEVEL))?;
                }
            }
        }
        BookExportFormat::Txt => {
            if source_format != BookSourceFormat::Txt {
                return Err("Only TXT imports can be exported as TXT".to_string());
            }
            if initial_book.source_storage == SourceStorage::Referenced {
                return Err("A referenced TXT can only be exported as EPUB".to_string());
            }
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(book_dir.join(SOURCE_TEXT_FILE), &output_path).map_err(|error| error.to_string())?;
        }
    }

    let book = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let Some(book) = state.library.books.iter_mut().find(|book| book.id == id) else {
            return Ok(None);
        };
        book.source_format = source_format;
        mark_book_exported(book);
        book.clone()
    };

    storage.mark_library_dirty();
    storage.flush_content_dirty()?;

    storage.compose_book(&book).map(Some)
}
