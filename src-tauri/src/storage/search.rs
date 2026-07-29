use std::{
    fs,
    io::{Read, Seek},
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use crate::{
    diagnostics,
    tasks::{TaskKey, TaskKind, TaskPriority, TaskService},
};

use super::epub_import::{EPUB_MAX_SEARCH_TEXT_BYTES, EPUB_SEARCH_DOCUMENT_READ_LIMIT, read_bounded_bytes};
use super::*;

const SEARCH_TEXT_MEMORY_CACHE_LIMIT: usize = 8;
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SearchTextCache {
    pub(super) version: u32,
    pub(super) extractor_version: u32,
    pub(super) book_hash: String,
    pub(super) content_version: u32,
    pub(super) sections: Vec<SearchTextSection>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SearchTextSection {
    pub(super) section_index: usize,
    pub(super) href: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) title: Option<String>,
    #[serde(default)]
    pub(super) nav_path: Vec<String>,
    pub(super) text: String,
}

#[derive(Debug, Clone)]
struct SearchTextNavItem {
    pub(super) href: Option<String>,
    label: String,
    path: Vec<String>,
}

#[derive(Debug, Clone)]
struct SearchManifestItem {
    pub(super) href: String,
    media_type: String,
    properties: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTextResult {
    pub(super) id: String,
    pub(super) excerpt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
    pub(super) section_index: usize,
    pub(super) subitems: Vec<SearchTextHit>,
    pub(super) expanded: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTextHit {
    pub(super) id: String,
    pub(super) excerpt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cfi: Option<String>,
    pub(super) occurrence: usize,
}

pub(super) fn search_text_cache_to_bytes(cache: &SearchTextCache) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(cache).map_err(|error| error.to_string())?;
    zstd::stream::encode_all(json.as_slice(), 3).map_err(|error| error.to_string())
}

pub(super) fn search_text_cache_from_bytes(bytes: &[u8]) -> Result<SearchTextCache, String> {
    let json = zstd::stream::decode_all(bytes).map_err(|error| error.to_string())?;
    serde_json::from_slice(&json).map_err(|error| error.to_string())
}

fn search_text_cache_matches_book(cache: &SearchTextCache, book: &LibraryBook) -> bool {
    cache.version == SEARCH_TEXT_CACHE_VERSION
        && cache.extractor_version == SEARCH_TEXT_EXTRACTOR_VERSION
        && cache.book_hash == book.content_hash
        && cache.content_version == book.content_version
}

fn write_search_text_cache_if_current(storage: &AppStorage, id: &str, cache: &SearchTextCache) -> Result<bool, String> {
    let current_book = storage.library_book(id)?;
    if !search_text_cache_matches_book(cache, &current_book) {
        return Ok(false);
    }

    let path = storage.search_text_cache_path(id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let bytes = search_text_cache_to_bytes(cache)?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|error| error.to_string())?;

    let current_book = storage.library_book(id)?;
    if !search_text_cache_matches_book(cache, &current_book) {
        let _ = fs::remove_file(&tmp);
        return Ok(false);
    }

    fs::rename(&tmp, path).map_err(|error| error.to_string())?;
    Ok(true)
}

fn store_search_text_memory_cache(storage: &AppStorage, id: String, cache: Arc<SearchTextCache>) -> Result<(), String> {
    let mut caches = storage
        .inner
        .search_text_caches
        .lock()
        .map_err(|_| "search text cache lock poisoned".to_string())?;
    let mut order = storage
        .inner
        .search_text_cache_order
        .lock()
        .map_err(|_| "search text cache order lock poisoned".to_string())?;

    caches.insert(id.clone(), cache);
    order.retain(|cache_id| cache_id != &id);
    order.push_back(id.clone());

    while caches.len() > SEARCH_TEXT_MEMORY_CACHE_LIMIT {
        let Some(evicted_id) = order.pop_front() else {
            break;
        };
        if evicted_id != id {
            caches.remove(&evicted_id);
        }
    }

    Ok(())
}

fn load_search_text_memory_cache(
    storage: &AppStorage,
    book: &LibraryBook,
) -> Result<Option<Arc<SearchTextCache>>, String> {
    let mut stale = false;
    let cache = {
        let mut caches = storage
            .inner
            .search_text_caches
            .lock()
            .map_err(|_| "search text cache lock poisoned".to_string())?;
        let cache = caches.get(&book.id).cloned();
        match cache {
            Some(cache) if search_text_cache_matches_book(&cache, book) => Some(cache),
            Some(_) => {
                caches.remove(&book.id);
                stale = true;
                None
            }
            None => None,
        }
    };

    if cache.is_some() || stale {
        let mut order = storage
            .inner
            .search_text_cache_order
            .lock()
            .map_err(|_| "search text cache order lock poisoned".to_string())?;
        order.retain(|cache_id| cache_id != &book.id);
        if cache.is_some() {
            order.push_back(book.id.clone());
        }
    }

    Ok(cache)
}

fn read_search_text_cache(storage: &AppStorage, book: &LibraryBook) -> Result<SearchTextCache, String> {
    let path = storage.search_text_cache_path(&book.id);
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let cache = search_text_cache_from_bytes(&bytes)?;
    if search_text_cache_matches_book(&cache, book) {
        Ok(cache)
    } else {
        Err("Search text cache is stale".to_string())
    }
}

pub(super) fn load_or_build_search_text_cache(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &LibraryBook,
) -> Result<Arc<SearchTextCache>, String> {
    load_or_build_search_text_cache_with_builder(storage, tasks, book, build_search_text_cache)
}

fn load_or_build_search_text_cache_with_builder(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &LibraryBook,
    builder: impl FnOnce(&AppStorage, &TaskService, &LibraryBook) -> Result<SearchTextCache, String>,
) -> Result<Arc<SearchTextCache>, String> {
    let started = Instant::now();
    if let Some(cache) = load_search_text_memory_cache(storage, book)? {
        let mut fields = vec![
            ("book", book.id.clone()),
            ("cache", "memory".to_string()),
            ("sections", cache.sections.len().to_string()),
            (
                "search_memory_caches",
                storage.search_text_memory_cache_len().to_string(),
            ),
        ];
        fields.extend(tasks.diagnostic_fields());
        diagnostics::record_timing("search-index", started.elapsed(), &fields);
        return Ok(cache);
    }

    if let Ok(cache) = read_search_text_cache(storage, book) {
        let cache = Arc::new(cache);
        store_search_text_memory_cache(storage, book.id.clone(), cache.clone())?;
        let mut fields = vec![
            ("book", book.id.clone()),
            ("cache", "disk".to_string()),
            ("sections", cache.sections.len().to_string()),
            (
                "search_memory_caches",
                storage.search_text_memory_cache_len().to_string(),
            ),
        ];
        fields.extend(tasks.diagnostic_fields());
        diagnostics::record_timing("search-index", started.elapsed(), &fields);
        return Ok(cache);
    }

    let key = search_index_task_key(book);
    let task_storage = storage.clone();
    let task_book = book.clone();
    let task_runner = tasks.clone();
    let cache: Arc<SearchTextCache> = tasks.get_or_run(key, TaskPriority::Foreground, move || {
        task_runner.run_book_exclusive(&task_book.id, TaskPriority::Foreground, || {
            task_runner.run_cpu(TaskPriority::Foreground, || {
                let cache = builder(&task_storage, &task_runner, &task_book)?;
                if !write_search_text_cache_if_current(&task_storage, &task_book.id, &cache)? {
                    return Err("Search text cache is stale".to_string());
                }
                Ok(Arc::new(cache))
            })
        })
    })?;

    if !search_text_cache_matches_book(&cache, book) {
        return Err("Search text cache is stale".to_string());
    }
    store_search_text_memory_cache(storage, book.id.clone(), cache.clone())?;
    let mut fields = vec![
        ("book", book.id.clone()),
        ("cache", "built".to_string()),
        ("sections", cache.sections.len().to_string()),
        (
            "search_memory_caches",
            storage.search_text_memory_cache_len().to_string(),
        ),
    ];
    fields.extend(tasks.diagnostic_fields());
    diagnostics::record_timing("search-index", started.elapsed(), &fields);
    Ok(cache)
}

fn search_index_task_key(book: &LibraryBook) -> TaskKey {
    TaskKey::new(TaskKind::SearchIndex, format!("{}:{}", book.id, book.content_version))
}

fn build_search_text_cache(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &LibraryBook,
) -> Result<SearchTextCache, String> {
    let book_dir = storage.book_dir(&book.id);
    let unpacked_dir = book_dir.join(UNPACKED_DIR);
    let sections = if inspect_and_store_book_content_access(storage, book)? == BookContentMode::ArchiveOnly {
        read_search_text_sections_from_epub_package(&archive_only_source_path(storage, book)?)?
    } else {
        ensure_book_package_path(storage, tasks, book)?;
        read_search_text_sections_from_unpacked(&unpacked_dir)?
    };
    Ok(SearchTextCache {
        version: SEARCH_TEXT_CACHE_VERSION,
        extractor_version: SEARCH_TEXT_EXTRACTOR_VERSION,
        book_hash: book.content_hash.clone(),
        content_version: book.content_version,
        sections,
    })
}

pub(super) fn read_search_text_sections_from_unpacked(unpacked_dir: &Path) -> Result<Vec<SearchTextSection>, String> {
    let mut source = UnpackedSearchTextSource { root: unpacked_dir };
    read_search_text_sections_from_source(&mut source)
}

fn read_search_text_sections_from_epub_package(path: &Path) -> Result<Vec<SearchTextSection>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    validate_epub_archive_limits(&mut archive)?;
    let mut source = ArchiveSearchTextSource { archive };
    read_search_text_sections_from_source(&mut source)
}

trait SearchTextSource {
    fn read_text(&mut self, path: &str) -> Result<String, String>;
}

struct UnpackedSearchTextSource<'a> {
    root: &'a Path,
}

impl SearchTextSource for UnpackedSearchTextSource<'_> {
    fn read_text(&mut self, path: &str) -> Result<String, String> {
        read_text_file_lossy(&resolve_unpacked_search_path(self.root, path)?)
    }
}

struct ArchiveSearchTextSource<R: Read + Seek> {
    archive: ZipArchive<R>,
}

impl<R: Read + Seek> SearchTextSource for ArchiveSearchTextSource<R> {
    fn read_text(&mut self, path: &str) -> Result<String, String> {
        let bytes = read_archive_bytes(&mut self.archive, path)?;
        Ok(text_from_bytes_lossy(bytes))
    }
}

fn read_archive_bytes<R: Read + Seek>(archive: &mut ZipArchive<R>, path: &str) -> Result<Vec<u8>, String> {
    let mut last_error = "EPUB entry not found".to_string();

    for candidate in zip_path_candidates(path) {
        let entry = archive.by_name(&candidate);
        match entry {
            Ok(mut file) => {
                return read_bounded_bytes(&mut file, EPUB_SEARCH_DOCUMENT_READ_LIMIT, "EPUB search document");
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }
    }

    Err(last_error)
}

fn text_from_bytes_lossy(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes.clone()).unwrap_or_else(|_| decode_text_bytes(&bytes, None).text)
}

fn read_search_text_sections_from_source(source: &mut impl SearchTextSource) -> Result<Vec<SearchTextSection>, String> {
    let container = source.read_text("META-INF/container.xml")?;
    let container_doc = roxmltree::Document::parse(&container).map_err(|error| error.to_string())?;
    let opf_path = container_doc
        .descendants()
        .find(|node| node.has_tag_name("rootfile"))
        .and_then(|node| node.attribute("full-path"))
        .ok_or_else(|| "EPUB container has no rootfile".to_string())?;
    let opf_path = normalize_zip_path(opf_path.replace('\\', "/"));
    if opf_path.is_empty() {
        return Err("EPUB container has invalid rootfile".to_string());
    }

    let opf = source.read_text(&opf_path)?;
    let opf_doc = roxmltree::Document::parse(&opf).map_err(|error| error.to_string())?;
    let opf_dir = parent_zip_path(&opf_path).to_string();

    let manifest = opf_doc
        .descendants()
        .filter(|node| node.is_element() && node.has_tag_name("item"))
        .filter_map(|node| {
            let id = node.attribute("id")?.to_string();
            let href = node.attribute("href")?.to_string();
            Some((
                id,
                SearchManifestItem {
                    href,
                    media_type: node.attribute("media-type").unwrap_or("").to_string(),
                    properties: node.attribute("properties").unwrap_or("").to_string(),
                },
            ))
        })
        .collect::<HashMap<_, _>>();
    let nav_items = read_search_text_nav_items(source, &opf_doc, &manifest, &opf_dir);

    let mut sections = Vec::new();
    let mut total_document_bytes = 0u64;
    for (section_index, itemref) in opf_doc
        .descendants()
        .filter(|node| node.is_element() && node.has_tag_name("itemref"))
        .enumerate()
    {
        let Some(idref) = itemref.attribute("idref") else {
            continue;
        };
        let Some(item) = manifest.get(idref) else {
            continue;
        };
        if !is_search_text_document_media_type(&item.media_type) {
            continue;
        }

        let normalized_href = normalize_zip_path(href_without_fragment(&item.href).replace('\\', "/"));
        if normalized_href.is_empty() {
            continue;
        }

        let section_path = normalize_zip_path(join_zip_path(&opf_dir, &normalized_href));
        let xhtml = source.read_text(&section_path)?;
        total_document_bytes = total_document_bytes
            .checked_add(xhtml.len() as u64)
            .ok_or_else(|| "EPUB search text size overflows the supported limit".to_string())?;
        if total_document_bytes > EPUB_MAX_SEARCH_TEXT_BYTES {
            return Err("EPUB search text exceeds the supported size limit".to_string());
        }
        let (text, title) = search_text_and_title_from_xhtml(&xhtml);
        if text.is_empty() {
            continue;
        }
        let nav_item = nav_items
            .iter()
            .find(|item| {
                item.href
                    .as_deref()
                    .is_some_and(|href| search_href_matches(&normalized_href, href))
            })
            .cloned();

        sections.push(SearchTextSection {
            section_index,
            href: normalized_href,
            title: nav_item.as_ref().map(|item| item.label.clone()).or(title),
            nav_path: nav_item.map(|item| item.path).unwrap_or_default(),
            text,
        });
    }

    Ok(sections)
}

fn read_search_text_nav_items(
    source: &mut impl SearchTextSource,
    opf_doc: &roxmltree::Document,
    manifest: &HashMap<String, SearchManifestItem>,
    opf_dir: &str,
) -> Vec<SearchTextNavItem> {
    if let Some(item) = manifest
        .values()
        .find(|item| item.properties.split_whitespace().any(|value| value == "nav"))
        && let Ok(items) = read_epub3_search_nav_items(source, opf_dir, &item.href)
        && !items.is_empty()
    {
        return items;
    }

    let ncx_id = opf_doc
        .descendants()
        .find(|node| node.is_element() && node.has_tag_name("spine"))
        .and_then(|node| node.attribute("toc"));
    let ncx_item = ncx_id.and_then(|id| manifest.get(id)).or_else(|| {
        manifest
            .values()
            .find(|item| item.media_type == "application/x-dtbncx+xml")
    });

    ncx_item
        .and_then(|item| read_ncx_search_nav_items(source, opf_dir, &item.href).ok())
        .unwrap_or_default()
}

fn read_epub3_search_nav_items(
    source: &mut impl SearchTextSource,
    opf_dir: &str,
    nav_href: &str,
) -> Result<Vec<SearchTextNavItem>, String> {
    let normalized_href = normalize_zip_path(href_without_fragment(nav_href).replace('\\', "/"));
    if normalized_href.is_empty() {
        return Ok(Vec::new());
    }

    let nav_path = normalize_zip_path(join_zip_path(opf_dir, &normalized_href));
    let nav_text = source.read_text(&nav_path)?;
    let nav_text = remove_doctype_declaration(&nav_text);
    let nav_doc = roxmltree::Document::parse(&nav_text).map_err(|error| error.to_string())?;
    let Some(nav_node) = nav_doc
        .descendants()
        .find(|node| node.is_element() && node.has_tag_name("nav") && is_toc_nav_node(*node))
        .or_else(|| {
            nav_doc
                .descendants()
                .find(|node| node.is_element() && node.has_tag_name("nav"))
        })
    else {
        return Ok(Vec::new());
    };
    let Some(list) = nav_node
        .children()
        .find(|node| node.is_element() && node.has_tag_name("ol"))
    else {
        return Ok(Vec::new());
    };

    let mut items = Vec::new();
    let mut path = Vec::new();
    collect_epub3_search_nav_items(list, parent_zip_path(&normalized_href), &mut path, &mut items);
    Ok(items)
}

fn is_toc_nav_node(node: roxmltree::Node) -> bool {
    node.attributes()
        .any(|attribute| attribute.name() == "type" && attribute.value().contains("toc"))
}

fn collect_epub3_search_nav_items(
    list: roxmltree::Node,
    base_href: &str,
    path: &mut Vec<String>,
    items: &mut Vec<SearchTextNavItem>,
) {
    for item in list
        .children()
        .filter(|node| node.is_element() && node.has_tag_name("li"))
    {
        let label_node = item
            .children()
            .find(|node| node.is_element() && matches!(node.tag_name().name(), "a" | "span"));
        let label = label_node.map(node_search_text).filter(|label| !label.is_empty());
        let href = label_node
            .and_then(|node| node.attribute("href"))
            .map(|href| normalize_nav_href(base_href, href));

        if let Some(label) = label {
            if href.is_some() {
                items.push(SearchTextNavItem {
                    href,
                    label: label.clone(),
                    path: path.clone(),
                });
            }

            path.push(label);
            for child_list in item
                .children()
                .filter(|node| node.is_element() && node.has_tag_name("ol"))
            {
                collect_epub3_search_nav_items(child_list, base_href, path, items);
            }
            path.pop();
        } else {
            for child_list in item
                .children()
                .filter(|node| node.is_element() && node.has_tag_name("ol"))
            {
                collect_epub3_search_nav_items(child_list, base_href, path, items);
            }
        }
    }
}

fn read_ncx_search_nav_items(
    source: &mut impl SearchTextSource,
    opf_dir: &str,
    ncx_href: &str,
) -> Result<Vec<SearchTextNavItem>, String> {
    let normalized_href = normalize_zip_path(href_without_fragment(ncx_href).replace('\\', "/"));
    if normalized_href.is_empty() {
        return Ok(Vec::new());
    }

    let ncx_path = normalize_zip_path(join_zip_path(opf_dir, &normalized_href));
    let ncx_text = source.read_text(&ncx_path)?;
    let ncx_text = remove_doctype_declaration(&ncx_text);
    let ncx_doc = roxmltree::Document::parse(&ncx_text).map_err(|error| error.to_string())?;
    let Some(nav_map) = ncx_doc
        .descendants()
        .find(|node| node.is_element() && node.has_tag_name("navMap"))
    else {
        return Ok(Vec::new());
    };

    let mut items = Vec::new();
    let mut path = Vec::new();
    collect_ncx_search_nav_items(nav_map, parent_zip_path(&normalized_href), &mut path, &mut items);
    Ok(items)
}

fn collect_ncx_search_nav_items(
    parent: roxmltree::Node,
    base_href: &str,
    path: &mut Vec<String>,
    items: &mut Vec<SearchTextNavItem>,
) {
    for nav_point in parent
        .children()
        .filter(|node| node.is_element() && node.has_tag_name("navPoint"))
    {
        let label = nav_point
            .children()
            .find(|node| node.is_element() && node.has_tag_name("navLabel"))
            .and_then(|node| {
                node.descendants()
                    .find(|child| child.is_element() && child.has_tag_name("text"))
            })
            .map(node_search_text)
            .filter(|label| !label.is_empty());
        let href = nav_point
            .children()
            .find(|node| node.is_element() && node.has_tag_name("content"))
            .and_then(|node| node.attribute("src"))
            .map(|href| normalize_nav_href(base_href, href));

        if let Some(label) = label {
            if href.is_some() {
                items.push(SearchTextNavItem {
                    href,
                    label: label.clone(),
                    path: path.clone(),
                });
            }

            path.push(label);
            collect_ncx_search_nav_items(nav_point, base_href, path, items);
            path.pop();
        } else {
            collect_ncx_search_nav_items(nav_point, base_href, path, items);
        }
    }
}

fn normalize_nav_href(base_href: &str, href: &str) -> String {
    normalize_zip_path(join_zip_path(
        base_href,
        &href_without_fragment(href).replace('\\', "/"),
    ))
}

fn search_href_matches(section_href: &str, nav_href: &str) -> bool {
    !section_href.is_empty()
        && !nav_href.is_empty()
        && (section_href.ends_with(nav_href) || nav_href.ends_with(section_href))
}

fn node_search_text(node: roxmltree::Node) -> String {
    let mut text = String::new();
    collect_node_text(node, &mut text);
    clean_xml_text(&text)
}

fn collect_node_text(node: roxmltree::Node, output: &mut String) {
    if node.is_text() {
        if let Some(text) = node.text() {
            output.push_str(text);
        }
        return;
    }

    for child in node.children() {
        collect_node_text(child, output);
    }
}

fn is_search_text_document_media_type(media_type: &str) -> bool {
    matches!(
        media_type,
        "application/xhtml+xml" | "text/html" | "application/xml" | "text/xml"
    )
}

fn href_without_fragment(href: &str) -> &str {
    href.split_once('#').map(|(path, _)| path).unwrap_or(href)
}

fn resolve_unpacked_search_path(root: &Path, href: &str) -> Result<PathBuf, String> {
    let decoded = percent_decode_path(&href.replace('\\', "/")).replace('\\', "/");
    if decoded.is_empty() || decoded.contains('%') {
        return Err("EPUB search document has an invalid encoded path".to_string());
    }

    let relative = Path::new(&decoded);
    if relative.components().any(|component| {
        matches!(
            component,
            Component::Prefix(_) | Component::RootDir | Component::ParentDir
        )
    }) {
        return Err("EPUB search document path escapes the unpacked book".to_string());
    }

    let canonical_root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let canonical_candidate = fs::canonicalize(root.join(relative)).map_err(|error| error.to_string())?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err("EPUB search document path escapes the unpacked book".to_string());
    }

    Ok(canonical_candidate)
}

fn read_text_file_lossy(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let bytes = read_bounded_bytes(file, EPUB_SEARCH_DOCUMENT_READ_LIMIT, "EPUB search document")?;
    String::from_utf8(bytes.clone()).or_else(|_| Ok(decode_text_bytes(&bytes, None).text))
}

#[cfg(test)]
pub(super) fn visible_search_text_from_xhtml(xhtml: &str) -> String {
    search_text_and_title_from_xhtml(xhtml).0
}

fn search_text_and_title_from_xhtml(xhtml: &str) -> (String, Option<String>) {
    let xhtml = remove_doctype_declaration(xhtml);
    let Ok(doc) = roxmltree::Document::parse(&xhtml) else {
        return (strip_html_for_search_text(&xhtml), None);
    };

    let body = doc
        .descendants()
        .find(|node| node.is_element() && node.has_tag_name("body"))
        .unwrap_or_else(|| doc.root_element());

    let mut text = String::new();
    append_visible_search_text(body, &mut text);

    let title = body
        .descendants()
        .find(|node| node.is_element() && matches!(node.tag_name().name(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6"))
        .and_then(|node| node.text())
        .map(clean_xml_text)
        .filter(|title| !title.is_empty())
        .or_else(|| {
            doc.descendants()
                .find(|node| node.is_element() && node.has_tag_name("title"))
                .and_then(|node| node.text())
                .map(clean_xml_text)
                .filter(|title| !title.is_empty())
        });

    (collapse_search_text_whitespace(&text), title)
}

fn remove_doctype_declaration(value: &str) -> String {
    let Some(start) = value.find("<!DOCTYPE") else {
        return value.to_string();
    };

    let after_start = &value[start..];
    let end = if let Some(internal_subset_start) = after_start.find('[') {
        let first_tag_end = after_start.find('>');
        if first_tag_end.is_none_or(|index| internal_subset_start < index) {
            after_start
                .find("]>")
                .map(|index| start + index + 2)
                .or_else(|| after_start.find('>').map(|index| start + index + 1))
        } else {
            first_tag_end.map(|index| start + index + 1)
        }
    } else {
        after_start.find('>').map(|index| start + index + 1)
    };

    let Some(end) = end else {
        return value.to_string();
    };

    let mut cleaned = String::with_capacity(value.len());
    cleaned.push_str(&value[..start]);
    cleaned.push_str(&value[end..]);
    cleaned
}

fn append_visible_search_text(node: roxmltree::Node, output: &mut String) {
    if node.is_text() {
        if let Some(text) = node.text() {
            output.push_str(text);
        }
        return;
    }

    if !node.is_element() {
        return;
    }

    let name = node.tag_name().name();
    if is_ignored_search_text_element(name) {
        return;
    }

    let block = is_search_text_block_element(name);
    if block {
        push_search_text_boundary(output);
    }

    for child in node.children() {
        append_visible_search_text(child, output);
    }

    if block {
        push_search_text_boundary(output);
    }
}

fn push_search_text_boundary(output: &mut String) {
    if !output.is_empty() && !output.ends_with('\n') {
        output.push('\n');
    }
}

fn is_ignored_search_text_element(name: &str) -> bool {
    matches!(name, "head" | "script" | "style" | "svg" | "math")
}

fn is_search_text_block_element(name: &str) -> bool {
    matches!(
        name,
        "address"
            | "article"
            | "aside"
            | "blockquote"
            | "body"
            | "br"
            | "dd"
            | "div"
            | "dl"
            | "dt"
            | "figcaption"
            | "figure"
            | "footer"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "header"
            | "hr"
            | "li"
            | "main"
            | "nav"
            | "ol"
            | "p"
            | "pre"
            | "section"
            | "table"
            | "td"
            | "th"
            | "tr"
            | "ul"
    )
}

fn collapse_search_text_whitespace(value: &str) -> String {
    value
        .split('\n')
        .filter_map(|line| {
            let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
            (!line.is_empty()).then_some(line)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn strip_html_for_search_text(value: &str) -> String {
    let mut text = String::with_capacity(value.len());
    let mut in_tag = false;

    for ch in value.chars() {
        match ch {
            '<' => {
                in_tag = true;
                push_search_text_boundary(&mut text);
            }
            '>' => {
                in_tag = false;
                push_search_text_boundary(&mut text);
            }
            _ if !in_tag => text.push(ch),
            _ => {}
        }
    }

    collapse_search_text_whitespace(
        &text
            .replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'"),
    )
}

pub(super) fn search_text_in_cache(
    cache: &SearchTextCache,
    keyword: &str,
    limit: Option<usize>,
) -> Vec<SearchTextResult> {
    let started = Instant::now();
    let keyword = keyword.trim();
    if keyword.is_empty() || limit == Some(0) {
        return Vec::new();
    }

    let folded_keyword = keyword.to_lowercase();
    let keyword_char_len = keyword.chars().count().max(1);
    let mut results = Vec::new();
    let mut total = 0usize;
    let diagnostics_enabled = diagnostics::enabled();
    let mut fold_elapsed = Duration::ZERO;
    let mut locate_elapsed = Duration::ZERO;
    let mut excerpt_elapsed = Duration::ZERO;

    'sections: for section in &cache.sections {
        let fold_started = diagnostics_enabled.then(Instant::now);
        let (folded_text, original_char_offsets) = lowercase_with_original_char_offsets(&section.text);
        if let Some(fold_started) = fold_started {
            fold_elapsed += fold_started.elapsed();
        }
        let mut previous_folded_byte_offset = 0usize;
        let mut folded_char_offset = 0usize;
        let mut subitems = Vec::new();
        let mut text_chars = None;

        for (occurrence, (folded_byte_offset, _)) in folded_text.match_indices(&folded_keyword).enumerate() {
            let locate_started = diagnostics_enabled.then(Instant::now);
            folded_char_offset += folded_text[previous_folded_byte_offset..folded_byte_offset]
                .chars()
                .count();
            previous_folded_byte_offset = folded_byte_offset;
            let char_offset = original_char_offsets
                .as_ref()
                .and_then(|offsets| offsets.get(folded_char_offset))
                .copied()
                .or_else(|| original_char_offsets.is_none().then_some(folded_char_offset))
                .unwrap_or_else(|| section.text.chars().count());
            if let Some(locate_started) = locate_started {
                locate_elapsed += locate_started.elapsed();
            }

            let excerpt_started = diagnostics_enabled.then(Instant::now);
            let text_chars = text_chars.get_or_insert_with(|| section.text.chars().collect::<Vec<_>>());
            let excerpt = search_text_excerpt(text_chars, char_offset, keyword_char_len);
            if let Some(excerpt_started) = excerpt_started {
                excerpt_elapsed += excerpt_started.elapsed();
            }
            let id = format!("{}:{}:{}", section.href, occurrence, char_offset);

            subitems.push(SearchTextHit {
                id,
                excerpt,
                cfi: None,
                occurrence,
            });

            total += 1;
            if limit.is_some_and(|limit| total >= limit) {
                break;
            }
        }

        if !subitems.is_empty() {
            results.push(SearchTextResult {
                id: section.href.clone(),
                excerpt: section.title.clone().unwrap_or_else(|| section.href.clone()),
                description: (!section.nav_path.is_empty()).then(|| section.nav_path.join(" / ")),
                section_index: section.section_index,
                subitems,
                expanded: true,
            });
        }

        if limit.is_some_and(|limit| total >= limit) {
            break 'sections;
        }
    }

    if diagnostics_enabled {
        diagnostics::record_timing(
            "search-query",
            started.elapsed(),
            &[
                ("sections", cache.sections.len().to_string()),
                ("matched_sections", results.len().to_string()),
                ("hits", total.to_string()),
                ("fold_ms", format!("{:.2}", fold_elapsed.as_secs_f64() * 1000.0)),
                ("locate_ms", format!("{:.2}", locate_elapsed.as_secs_f64() * 1000.0)),
                ("excerpt_ms", format!("{:.2}", excerpt_elapsed.as_secs_f64() * 1000.0)),
            ],
        );
    }

    results
}

fn lowercase_with_original_char_offsets(text: &str) -> (String, Option<Vec<usize>>) {
    let folded = text.to_lowercase();
    if !text.chars().any(|ch| ch.to_lowercase().count() != 1) {
        return (folded, None);
    }

    let original_char_offsets = text
        .chars()
        .enumerate()
        .flat_map(|(original_char_offset, ch)| ch.to_lowercase().map(move |_| original_char_offset))
        .collect();

    (folded, Some(original_char_offsets))
}

fn search_text_excerpt(chars: &[char], offset: usize, keyword_len: usize) -> String {
    if chars.is_empty() {
        return String::new();
    }

    let offset = offset.min(chars.len());
    let keyword_end = (offset + keyword_len).min(chars.len());
    let mut paragraph_start = chars[..offset]
        .iter()
        .rposition(|ch| *ch == '\n')
        .map_or(0, |index| index + 1);
    let mut paragraph_end = chars[keyword_end..]
        .iter()
        .position(|ch| *ch == '\n')
        .map_or(chars.len(), |index| keyword_end + index);

    while paragraph_start < paragraph_end && chars[paragraph_start].is_whitespace() {
        paragraph_start += 1;
    }
    while paragraph_end > paragraph_start && chars[paragraph_end - 1].is_whitespace() {
        paragraph_end -= 1;
    }

    if paragraph_start >= paragraph_end {
        return String::new();
    }

    let mut start = offset.saturating_sub(SEARCH_TEXT_EXCERPT_RADIUS).max(paragraph_start);
    let mut end = (offset + keyword_len + SEARCH_TEXT_EXCERPT_RADIUS).min(paragraph_end);

    while start < end && chars[start].is_whitespace() {
        start += 1;
    }
    while end > start && chars[end - 1].is_whitespace() {
        end -= 1;
    }

    if start >= end {
        return String::new();
    }

    let mut excerpt = String::new();

    if start > paragraph_start {
        excerpt.push('…');
    }
    excerpt.extend(chars[start..end].iter());
    if end < paragraph_end {
        excerpt.push('…');
    }

    excerpt
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        collections::{HashMap, VecDeque},
        path::Path,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("flow-reader-{label}-{}-{nonce}", std::process::id()))
    }

    fn test_book(id: &str, content_version: u32) -> LibraryBook {
        LibraryBook {
            id: id.to_string(),
            name: format!("{id}.epub"),
            size: 1,
            reading_status: None,
            source_format: Some(BookSourceFormat::Epub),
            exported_versions: Default::default(),
            content_edited_at: None,
            content_hash: format!("hash-{content_version}"),
            content_version,
            content_mode: BookContentMode::Normal,
            content_flags: Vec::new(),
            source_storage: SourceStorage::Managed,
            source_path: None,
            metadata: empty_object(),
            created_at: 1,
            updated_at: None,
            last_read_at: None,
            cfi: None,
            percentage: None,
            tag_ids: Vec::new(),
        }
    }

    fn test_storage(root: &Path, books: Vec<LibraryBook>) -> AppStorage {
        AppStorage {
            inner: Arc::new(StorageInner {
                root: root.to_path_buf(),
                state: Mutex::new(StorageState {
                    library: Library {
                        version: 1,
                        books,
                        tags: Vec::new(),
                    },
                    external: ExternalBookIndex::default(),
                    settings: json!({}),
                    book_states: HashMap::new(),
                }),
                dirty: Mutex::new(DirtyState::default()),
                flush_lock: Mutex::new(()),
                import_lock: Mutex::new(()),
                reading_position_sequences: Mutex::new(HashMap::new()),
                search_text_caches: Mutex::new(HashMap::new()),
                search_text_cache_order: Mutex::new(VecDeque::new()),
                text_import_prepared_cache: Mutex::new(TextImportPreparedCache::new()),
                text_import_prepare_runs: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepare_active: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepare_max_active: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepare_delay_ms: std::sync::atomic::AtomicU64::new(0),
                text_import_prepared_handoff_active: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepared_handoff_max_active: std::sync::atomic::AtomicUsize::new(0),
            }),
        }
    }

    fn test_cache(book: &LibraryBook, text: &str) -> SearchTextCache {
        SearchTextCache {
            version: SEARCH_TEXT_CACHE_VERSION,
            extractor_version: SEARCH_TEXT_EXTRACTOR_VERSION,
            book_hash: book.content_hash.clone(),
            content_version: book.content_version,
            sections: vec![SearchTextSection {
                section_index: 0,
                href: "Text/chapter.xhtml".to_string(),
                title: Some("Chapter".to_string()),
                nav_path: Vec::new(),
                text: text.to_string(),
            }],
        }
    }

    #[test]
    fn unpacked_search_rejects_percent_encoded_parent_paths() {
        let root = temp_root("search-path-boundary-test");
        let unpacked = root.join("unpacked");
        fs::create_dir_all(unpacked.join("META-INF")).unwrap();
        fs::write(
            unpacked.join("META-INF/container.xml"),
            r#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
        )
        .unwrap();
        fs::write(
            unpacked.join("content.opf"),
            r#"<?xml version="1.0"?><package><manifest><item id="chapter" href="%2e%2e/outside.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>"#,
        )
        .unwrap();
        fs::write(root.join("outside.xhtml"), "<html><body>outside secret</body></html>").unwrap();

        let result = read_search_text_sections_from_unpacked(&unpacked);

        assert!(result.is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_index_reuses_in_flight_build_for_same_book_version() {
        let root = temp_root("search-idempotent-test");
        let storage = Arc::new(test_storage(&root, vec![test_book("book", 1)]));
        let tasks = Arc::new(TaskService::default());
        let runs = Arc::new(AtomicUsize::new(0));
        let book = storage.library_book("book").unwrap();

        let first = {
            let storage = Arc::clone(&storage);
            let tasks = Arc::clone(&tasks);
            let runs = Arc::clone(&runs);
            let book = book.clone();
            thread::spawn(move || {
                load_or_build_search_text_cache_with_builder(&storage, &tasks, &book, |_, _, book| {
                    runs.fetch_add(1, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(100));
                    Ok(test_cache(book, "first build"))
                })
            })
        };

        thread::sleep(Duration::from_millis(20));

        let second = {
            let storage = Arc::clone(&storage);
            let tasks = Arc::clone(&tasks);
            let runs = Arc::clone(&runs);
            thread::spawn(move || {
                load_or_build_search_text_cache_with_builder(&storage, &tasks, &book, |_, _, book| {
                    runs.fetch_add(1, Ordering::SeqCst);
                    Ok(test_cache(book, "second build"))
                })
            })
        };

        let first = first.join().unwrap().unwrap();
        let second = second.join().unwrap().unwrap();

        assert_eq!(first.sections[0].text, second.sections[0].text);
        assert_eq!(runs.load(Ordering::SeqCst), 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_search_index_result_is_not_written() {
        let root = temp_root("search-stale-publish-test");
        let storage = test_storage(&root, vec![test_book("book", 1)]);
        let book = storage.library_book("book").unwrap();
        let cache = test_cache(&book, "old content");

        {
            let mut state = storage.inner.state.lock().unwrap();
            let book = state.library.books.iter_mut().find(|book| book.id == "book").unwrap();
            book.content_hash = "hash-2".to_string();
            book.content_version = 2;
        }

        let published = write_search_text_cache_if_current(&storage, "book", &cache).unwrap();

        assert!(!published);
        assert!(!storage.search_text_cache_path("book").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_memory_cache_is_bounded_by_book_count() {
        let root = temp_root("search-memory-bound-test");
        let books = (0..=SEARCH_TEXT_MEMORY_CACHE_LIMIT)
            .map(|index| test_book(&format!("book-{index}"), 1))
            .collect::<Vec<_>>();
        let storage = test_storage(&root, books.clone());

        for book in &books {
            store_search_text_memory_cache(&storage, book.id.clone(), Arc::new(test_cache(book, &book.id))).unwrap();
        }

        let caches = storage.inner.search_text_caches.lock().unwrap();

        assert!(caches.len() <= SEARCH_TEXT_MEMORY_CACHE_LIMIT);
        assert!(!caches.contains_key("book-0"));
        assert!(caches.contains_key(&format!("book-{SEARCH_TEXT_MEMORY_CACHE_LIMIT}")));

        let _ = fs::remove_dir_all(root);
    }
}
