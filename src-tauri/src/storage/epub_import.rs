use std::{
    fs,
    io::{BufReader, BufWriter, Read, Seek, Write},
    path::{Path, PathBuf},
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use super::*;
struct ParsedEpubInfo {
    metadata: Value,
    cover: Option<CoverInput>,
}

pub(super) fn unpack_epub(path: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(dest).map_err(|error| error.to_string())?;

    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
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

        let mut outfile = fs::File::create(&outpath).map_err(|error| error.to_string())?;
        std::io::copy(&mut file, &mut outfile).map_err(|error| error.to_string())?;
    }

    Ok(())
}

pub(super) fn find_unpacked_opf_path(unpacked_dir: &Path) -> Result<PathBuf, String> {
    let container_path = unpacked_dir.join("META-INF").join("container.xml");
    let container = fs::read_to_string(&container_path).map_err(|error| error.to_string())?;
    let container_doc =
        roxmltree::Document::parse(&container).map_err(|error| error.to_string())?;
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

fn parse_epub_info_result(path: &Path) -> Result<ParsedEpubInfo, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    let container = read_zip_text(&mut archive, "META-INF/container.xml")?;
    let container_doc =
        roxmltree::Document::parse(&container).map_err(|error| error.to_string())?;
    let opf_path = container_doc
        .descendants()
        .find(|node| node.has_tag_name("rootfile"))
        .and_then(|node| node.attribute("full-path"))
        .ok_or_else(|| "EPUB container has no rootfile".to_string())?
        .to_string();
    let opf = read_zip_text(&mut archive, &opf_path)?;
    let opf_doc = roxmltree::Document::parse(&opf).map_err(|error| error.to_string())?;
    let metadata = parse_opf_metadata(&opf_doc);
    let cover = find_cover_path(&opf_doc)
        .and_then(|(href, mime_type)| {
            let cover_path = normalize_zip_path(join_zip_path(parent_zip_path(&opf_path), &href));
            read_zip_bytes(&mut archive, &cover_path).ok().map(|data| {
                let extension = extension_from_path(&cover_path);
                CoverInput {
                    mime_type,
                    extension,
                    data,
                }
            })
        })
        .or_else(|| {
            create_text_cover_input(&metadata, path.file_stem().and_then(|name| name.to_str()))
        });

    Ok(ParsedEpubInfo { metadata, cover })
}

fn read_zip_text<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<String, String> {
    let mut file = archive.by_name(name).map_err(|error| error.to_string())?;
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|error| error.to_string())?;
    Ok(text)
}

fn read_zip_bytes<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<Vec<u8>, String> {
    let mut file = archive.by_name(name).map_err(|error| error.to_string())?;
    let mut data = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut data)
        .map_err(|error| error.to_string())?;
    Ok(data)
}

fn parse_opf_metadata(doc: &roxmltree::Document) -> Value {
    let mut metadata = serde_json::Map::new();
    let metadata_node = doc.descendants().find(|node| node.has_tag_name("metadata"));

    let Some(metadata_node) = metadata_node else {
        return Value::Object(metadata);
    };

    let element_mappings = [
        ("title", "title"),
        ("creator", "creator"),
        ("description", "description"),
        ("date", "pubdate"),
        ("publisher", "publisher"),
        ("identifier", "identifier"),
        ("language", "language"),
        ("rights", "rights"),
    ];

    for (tag, key) in element_mappings {
        if let Some(value) = metadata_node
            .children()
            .find(|node| node.is_element() && node.tag_name().name() == tag)
            .and_then(|node| node.text())
            .map(clean_xml_text)
            .filter(|value| !value.is_empty())
        {
            let value = if key == "pubdate" {
                normalize_publication_date(&value)
            } else {
                value
            };
            metadata.insert(key.to_string(), Value::String(value));
        }
    }

    let property_mappings = [
        ("dcterms:modified", "modified_date"),
        ("rendition:layout", "layout"),
        ("rendition:orientation", "orientation"),
        ("rendition:flow", "flow"),
        ("rendition:viewport", "viewport"),
        ("rendition:spread", "spread"),
    ];

    for (property, key) in property_mappings {
        if let Some(value) = metadata_node
            .children()
            .find(|node| {
                node.is_element()
                    && node.has_tag_name("meta")
                    && node.attribute("property") == Some(property)
            })
            .and_then(|node| node.text())
            .map(clean_xml_text)
            .filter(|value| !value.is_empty())
        {
            metadata.insert(key.to_string(), Value::String(value));
        }
    }

    Value::Object(metadata)
}

pub(super) fn clean_xml_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn normalize_publication_date(value: &str) -> String {
    let text = clean_xml_text(value);
    if text.is_empty() {
        return text;
    }

    extract_normalized_publication_date(&text).unwrap_or(text)
}

fn extract_normalized_publication_date(text: &str) -> Option<String> {
    for (index, _) in text.char_indices() {
        if !starts_with_ascii_digits(text, index, 4) {
            continue;
        }
        if previous_char_is_ascii_digit(text, index) {
            continue;
        }

        let digit_count = text[index..]
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .count();

        if let Some(date) = parse_compact_publication_date(text, index, digit_count) {
            return Some(date);
        }

        if digit_count >= 6 {
            continue;
        }

        if let Some(date) = parse_separated_publication_date(text, index) {
            return Some(date);
        }

        if text[index + 4..]
            .chars()
            .next()
            .is_some_and(is_publication_date_separator)
        {
            continue;
        }

        let end = index + 4;
        if !next_char_is_ascii_digit(text, end) {
            return Some(text[index..end].to_string());
        }
    }

    None
}

fn parse_compact_publication_date(text: &str, index: usize, digit_count: usize) -> Option<String> {
    if digit_count >= 8 {
        let year = &text[index..index + 4];
        let month = parse_date_component(&text[index + 4..index + 6], 1, 12)?;
        let day = parse_date_component(&text[index + 6..index + 8], 1, 31)?;
        return Some(format!("{year}-{month:02}-{day:02}"));
    }

    if digit_count == 6 {
        let year = &text[index..index + 4];
        let month = parse_date_component(&text[index + 4..index + 6], 1, 12)?;
        return Some(format!("{year}-{month:02}"));
    }

    None
}

fn parse_separated_publication_date(text: &str, index: usize) -> Option<String> {
    let year = &text[index..index + 4];
    let mut cursor = index + 4;
    let separator = text[cursor..].chars().next()?;

    if !is_publication_date_separator(separator) {
        return None;
    }

    cursor += separator.len_utf8();
    let (month, next_cursor) = read_numeric_component(text, cursor, 2)?;
    let month = parse_date_component(month, 1, 12)?;
    cursor = next_cursor;

    let Some(next) = text[cursor..].chars().next() else {
        return Some(format!("{year}-{month:02}"));
    };

    if next == '月' {
        cursor += next.len_utf8();
    } else if is_publication_date_separator(next) {
        cursor += next.len_utf8();
    } else {
        return Some(format!("{year}-{month:02}"));
    }

    let Some((day, next_cursor)) = read_numeric_component(text, cursor, 2) else {
        return Some(format!("{year}-{month:02}"));
    };
    let day = parse_date_component(day, 1, 31)?;
    cursor = next_cursor;

    if text[cursor..].starts_with('日') {
        cursor += '日'.len_utf8();
    }

    if next_char_is_ascii_digit(text, cursor) {
        return None;
    }

    Some(format!("{year}-{month:02}-{day:02}"))
}

fn starts_with_ascii_digits(text: &str, index: usize, count: usize) -> bool {
    text[index..]
        .chars()
        .take(count)
        .filter(|character| character.is_ascii_digit())
        .count()
        == count
}

fn previous_char_is_ascii_digit(text: &str, index: usize) -> bool {
    text[..index]
        .chars()
        .next_back()
        .is_some_and(|character| character.is_ascii_digit())
}

fn next_char_is_ascii_digit(text: &str, index: usize) -> bool {
    text[index..]
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_digit())
}

fn is_publication_date_separator(character: char) -> bool {
    matches!(character, '-' | '/' | '.' | '年')
}

fn read_numeric_component(text: &str, index: usize, max_digits: usize) -> Option<(&str, usize)> {
    let mut end = index;
    let mut digits = 0;

    for (offset, character) in text[index..].char_indices() {
        if !character.is_ascii_digit() || digits >= max_digits {
            break;
        }

        digits += 1;
        end = index + offset + character.len_utf8();
    }

    if digits == 0 {
        None
    } else {
        Some((&text[index..end], end))
    }
}

fn parse_date_component(value: &str, min: u32, max: u32) -> Option<u32> {
    let value = value.parse::<u32>().ok()?;
    (min..=max).contains(&value).then_some(value)
}

fn find_cover_path(doc: &roxmltree::Document) -> Option<(String, String)> {
    let manifest_items = || {
        doc.descendants()
            .filter(|node| node.is_element() && node.has_tag_name("item"))
    };

    if let Some(item) = manifest_items().find(|node| {
        node.attribute("properties")
            .is_some_and(|properties| properties.split_whitespace().any(|p| p == "cover-image"))
    }) {
        return cover_item_to_path(item);
    }

    let cover_id = doc.descendants().find_map(|node| {
        if !node.is_element() || !node.has_tag_name("meta") {
            return None;
        }
        if node.attribute("name") == Some("cover") {
            node.attribute("content").map(str::to_string)
        } else {
            None
        }
    });

    if let Some(cover_id) = cover_id {
        if let Some(item) =
            manifest_items().find(|node| node.attribute("id") == Some(cover_id.as_str()))
        {
            return cover_item_to_path(item);
        }
    }

    manifest_items()
        .find(|node| {
            node.attribute("media-type")
                .is_some_and(|media_type| media_type.starts_with("image/"))
                && node
                    .attribute("href")
                    .is_some_and(|href| href.to_ascii_lowercase().contains("cover"))
        })
        .and_then(cover_item_to_path)
}

fn cover_item_to_path(node: roxmltree::Node) -> Option<(String, String)> {
    let href = node.attribute("href")?.to_string();
    let mime_type = node.attribute("media-type").unwrap_or("").to_string();
    Some((href, mime_type))
}

pub(super) fn parent_zip_path(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("")
}

pub(super) fn join_zip_path(parent: &str, child: &str) -> String {
    if parent.is_empty() || child.starts_with('/') {
        child.trim_start_matches('/').to_string()
    } else {
        format!("{parent}/{child}")
    }
}

pub(super) fn normalize_zip_path(path: String) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

fn extension_from_path(path: &str) -> String {
    path.rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default()
}

fn epub_import_temp_path(root: &Path, name: &str) -> PathBuf {
    let name = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    root.join(format!(
        ".import-{}-{}-{}",
        std::process::id(),
        now_ms(),
        name
    ))
}

fn copy_epub_and_hash(source: &Path, target: &Path) -> Result<String, String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut input = BufReader::new(fs::File::open(source).map_err(|error| error.to_string())?);
    let mut output = BufWriter::new(fs::File::create(target).map_err(|error| error.to_string())?);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];

    loop {
        let read = input.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|error| error.to_string())?;
    }
    output.flush().map_err(|error| error.to_string())?;

    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn remove_epub_import_temp(path: &Path) {
    if let Err(error) = fs::remove_file(path) {
        if path.exists() {
            eprintln!("Failed to remove temporary EPUB import file: {error}");
        }
    }
}

pub(super) fn import_epub_path_impl(
    storage: &AppStorage,
    path: &Path,
    replace_existing: bool,
) -> Result<BookRecord, String> {
    let books_root = books_root(storage.root());
    fs::create_dir_all(&books_root).map_err(|error| error.to_string())?;

    let size = fs::metadata(path).map_err(|error| error.to_string())?.len();
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.epub".to_string());
    let parsed = parse_epub_info_result(path)?;
    let temp_path = epub_import_temp_path(&books_root, &name);
    let hash = match copy_epub_and_hash(path, &temp_path) {
        Ok(hash) => hash,
        Err(error) => {
            remove_epub_import_temp(&temp_path);
            return Err(error);
        }
    };

    enum ImportDecision {
        Existing(BookRecord),
        Commit {
            book: LibraryBook,
            id: String,
            should_copy: bool,
        },
    }

    let result = (|| -> Result<BookRecord, String> {
        let decision = {
            let mut state = storage
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;
            let filename_index = state
                .library
                .books
                .iter()
                .position(|book| book.name == name);
            let hash_index = state
                .library
                .books
                .iter()
                .position(|book| !book.content_hash.is_empty() && book.content_hash == hash);

            if let Some(index) = filename_index {
                if !replace_existing || state.library.books[index].content_hash == hash {
                    let book = state.library.books[index].clone();
                    ImportDecision::Existing(storage.compose_book(&mut state, &book)?)
                } else {
                    let book = &mut state.library.books[index];
                    book.size = size;
                    book.content_hash = hash.clone();
                    book.content_version = book.content_version.saturating_add(1).max(1);
                    book.updated_at = Some(now_ms());
                    book.last_read_at = book.updated_at;
                    let book = state.library.books[index].clone();
                    let id = book.id.clone();
                    ImportDecision::Commit {
                        book,
                        id,
                        should_copy: true,
                    }
                }
            } else if let Some(index) = hash_index {
                let book = &mut state.library.books[index];
                book.name = name.clone();
                book.size = size;
                book.updated_at = Some(now_ms());
                let book = state.library.books[index].clone();
                let id = book.id.clone();
                ImportDecision::Commit {
                    book,
                    id,
                    should_copy: false,
                }
            } else {
                let created_at = now_ms();
                let id = id_from_hash(&hash);
                state.library.books.push(LibraryBook {
                    id,
                    name: name.clone(),
                    size,
                    reading_status: None,
                    source_format: Some(BookSourceFormat::Epub),
                    exported_versions: Default::default(),
                    content_edited_at: None,
                    content_hash: hash.clone(),
                    content_version: 1,
                    metadata: empty_object(),
                    created_at,
                    updated_at: None,
                    last_read_at: None,
                    cfi: None,
                    percentage: None,
                    tag_ids: Vec::new(),
                });
                let book = state
                    .library
                    .books
                    .last()
                    .expect("newly pushed book should exist")
                    .clone();
                let id = book.id.clone();
                ImportDecision::Commit {
                    book,
                    id,
                    should_copy: true,
                }
            }
        };

        let (mut book, id, should_copy) = match decision {
            ImportDecision::Existing(record) => {
                remove_epub_import_temp(&temp_path);
                return Ok(record);
            }
            ImportDecision::Commit {
                book,
                id,
                should_copy,
            } => (book, id, should_copy),
        };

        if should_copy {
            let dir = storage.book_dir(&id);
            storage.unload_search_text_cache(&id);
            fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
            let book_path = dir.join(BOOK_FILE);
            let unpacked_dir = dir.join(UNPACKED_DIR);
            if unpacked_dir.exists() {
                fs::remove_dir_all(&unpacked_dir).map_err(|error| error.to_string())?;
            }
            let search_cache_path = dir.join(SEARCH_TEXT_CACHE_FILE);
            if search_cache_path.exists() {
                fs::remove_file(&search_cache_path).map_err(|error| error.to_string())?;
            }
            if book_path.exists() {
                fs::remove_file(&book_path).map_err(|error| error.to_string())?;
            }
            fs::rename(&temp_path, &book_path).map_err(|error| error.to_string())?;
            if parsed.metadata != json!({}) {
                book.metadata = parsed.metadata;
                let mut state = storage
                    .inner
                    .state
                    .lock()
                    .map_err(|_| "storage state lock poisoned".to_string())?;
                if let Some(stored_book) = state.library.books.iter_mut().find(|book| book.id == id)
                {
                    stored_book.metadata = book.metadata.clone();
                }
            }
            write_metadata(storage, &id, &book.metadata)?;
            write_cover(storage, &id, parsed.cover)?;
        } else {
            remove_epub_import_temp(&temp_path);
        }

        storage.mark_library_dirty();
        storage.flush_dirty()?;

        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        storage.compose_book(&mut state, &book)
    })();

    if result.is_err() {
        remove_epub_import_temp(&temp_path);
    }

    result
}
