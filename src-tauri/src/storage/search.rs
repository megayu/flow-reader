use std::{
    fs,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use crate::{
    diagnostics,
    tasks::{TaskKey, TaskKind, TaskPriority, TaskService},
};

use super::epub_import::EPUB_MAX_SEARCH_TEXT_BYTES;
use super::publication::{
    ArchivePublicationSource, PublicationSource, UnpackedPublicationSource, read_package_document,
};
use super::*;

#[cfg(test)]
use std::path::PathBuf;

const DERIVED_CACHE_BOOK_LIMIT: usize = 8;
const DERIVED_CACHE_MEMORY_SOFT_LIMIT: usize = 256 * 1024 * 1024;
const DERIVED_CACHE_COLD_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Default)]
pub struct SearchRequests(Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

pub(super) struct SearchRequest {
    id: String,
    cancelled: Arc<AtomicBool>,
    requests: SearchRequests,
}

impl SearchRequests {
    pub(super) fn start(&self, id: String) -> Result<SearchRequest, String> {
        let mut requests = self.0.lock().map_err(|_| "search request lock poisoned")?;
        if requests.contains_key(&id) {
            return Err("Search request already exists".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        requests.insert(id.clone(), Arc::clone(&cancelled));
        Ok(SearchRequest {
            id,
            cancelled,
            requests: self.clone(),
        })
    }

    pub(super) fn cancel(&self, id: &str) -> Result<(), String> {
        if let Some(cancelled) = self.0.lock().map_err(|_| "search request lock poisoned")?.get(id) {
            cancelled.store(true, Ordering::Relaxed);
        }
        Ok(())
    }
}

impl SearchRequest {
    pub(super) fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

impl Drop for SearchRequest {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.requests.0.lock() {
            requests.remove(&self.id);
        }
    }
}

#[derive(Debug)]
pub(super) struct DerivedCacheState {
    pub(super) active: bool,
    pub(super) persistent: bool,
    pub(super) last_accessed: Instant,
    pub(super) cold_since: Option<Instant>,
    pub(super) search_dirty: bool,
    pub(super) image_dirty: bool,
}

impl DerivedCacheState {
    fn active(persistent: bool) -> Self {
        Self {
            active: true,
            persistent,
            last_accessed: Instant::now(),
            cold_since: None,
            search_dirty: false,
            image_dirty: false,
        }
    }
}

#[derive(Clone)]
struct DerivedCacheBuild {
    search: Option<Arc<SearchTextCache>>,
    image: Arc<ImageIndexCache>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SearchTextCache {
    pub(super) version: u32,
    pub(super) source_revision: u32,
    pub(super) revision: u32,
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
    href: String,
    label: String,
    path: Vec<String>,
}

#[derive(Debug, Clone)]
struct DerivedManifestItem {
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
    encode_compressed_json(cache)
}

pub(super) fn search_text_cache_from_bytes(bytes: &[u8]) -> Result<SearchTextCache, String> {
    decode_compressed_json(bytes)
}

fn search_text_cache_matches_book(cache: &SearchTextCache, book: &StoredBook) -> bool {
    cache.version == SEARCH_TEXT_CACHE_VERSION
        && cache.source_revision == book.source_revision
        && cache.revision == book.revision
}

fn write_search_text_cache_if_current(storage: &AppStorage, id: &str, cache: &SearchTextCache) -> Result<bool, String> {
    let current_book = storage.stored_book(id)?;
    if current_book.scope == BookScope::External || !search_text_cache_matches_book(cache, &current_book) {
        return Ok(false);
    }

    let path = storage.search_text_cache_path(id, cache.source_revision, cache.revision);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let bytes = search_text_cache_to_bytes(cache)?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|error| error.to_string())?;

    let current_book = storage.stored_book(id)?;
    if !search_text_cache_matches_book(cache, &current_book) {
        let _ = fs::remove_file(&tmp);
        return Ok(false);
    }

    fs::rename(&tmp, &path).map_err(|error| error.to_string())?;
    Ok(true)
}

fn store_search_text_memory_cache(
    storage: &AppStorage,
    id: String,
    cache: Arc<SearchTextCache>,
    dirty: bool,
    persistent: bool,
) -> Result<(), String> {
    let mut caches = storage
        .inner
        .search_text_caches
        .lock()
        .map_err(|_| "search text cache lock poisoned".to_string())?;
    caches.insert(id.clone(), cache);
    drop(caches);
    storage.touch_derived_cache(&id, dirty, false, persistent)?;
    storage.enforce_derived_cache_limits()?;

    Ok(())
}

fn load_search_text_memory_cache(
    storage: &AppStorage,
    book: &StoredBook,
) -> Result<Option<Arc<SearchTextCache>>, String> {
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
                None
            }
            None => None,
        }
    };

    if cache.is_some() {
        storage.touch_derived_cache(&book.id, false, false, book.scope == BookScope::Library)?;
    }

    Ok(cache)
}

fn read_search_text_cache(storage: &AppStorage, book: &StoredBook) -> Result<SearchTextCache, String> {
    if book.scope == BookScope::External {
        return Err("External book search caches are memory-only".to_string());
    }
    let path = storage.search_text_cache_path(&book.id, book.source_revision, book.revision);
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let cache = search_text_cache_from_bytes(&bytes)?;
    if search_text_cache_matches_book(&cache, book) {
        Ok(cache)
    } else {
        Err("Search text cache is stale".to_string())
    }
}

fn image_index_cache_matches_book(cache: &ImageIndexCache, book: &StoredBook) -> bool {
    cache.version == IMAGE_INDEX_CACHE_VERSION
        && cache.source_revision == book.source_revision
        && cache.revision == book.revision
}

pub(super) fn read_image_index_cache(storage: &AppStorage, book: &StoredBook) -> Result<ImageIndexCache, String> {
    if book.scope == BookScope::External {
        return Err("External book image caches are memory-only".to_string());
    }
    let path = storage.image_index_cache_path(&book.id, book.source_revision, book.revision);
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let cache = image_index_cache_from_bytes(&bytes)?;
    if image_index_cache_matches_book(&cache, book) {
        Ok(cache)
    } else {
        Err("Image index cache is stale".to_string())
    }
}

pub(super) fn write_image_index_cache_if_current(
    storage: &AppStorage,
    id: &str,
    cache: &ImageIndexCache,
) -> Result<bool, String> {
    let current_book = storage.stored_book(id)?;
    if current_book.scope == BookScope::External || !image_index_cache_matches_book(cache, &current_book) {
        return Ok(false);
    }

    let path = storage.image_index_cache_path(id, cache.source_revision, cache.revision);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = image_index_cache_to_bytes(cache)?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|error| error.to_string())?;
    let current_book = storage.stored_book(id)?;
    if !image_index_cache_matches_book(cache, &current_book) {
        let _ = fs::remove_file(&tmp);
        return Ok(false);
    }
    fs::rename(&tmp, &path).map_err(|error| error.to_string())?;
    Ok(true)
}

fn load_image_index_memory_cache(
    storage: &AppStorage,
    book: &StoredBook,
) -> Result<Option<Arc<ImageIndexCache>>, String> {
    let cache = {
        let mut caches = storage
            .inner
            .image_index_caches
            .lock()
            .map_err(|_| "image index cache lock poisoned".to_string())?;
        match caches.get(&book.id).cloned() {
            Some(cache) if image_index_cache_matches_book(&cache, book) => Some(cache),
            Some(_) => {
                caches.remove(&book.id);
                None
            }
            None => None,
        }
    };
    if cache.is_some() {
        storage.touch_derived_cache(&book.id, false, false, book.scope == BookScope::Library)?;
    }
    Ok(cache)
}

fn store_image_index_memory_cache(
    storage: &AppStorage,
    id: String,
    cache: Arc<ImageIndexCache>,
    dirty: bool,
    persistent: bool,
) -> Result<(), String> {
    storage
        .inner
        .image_index_caches
        .lock()
        .map_err(|_| "image index cache lock poisoned".to_string())?
        .insert(id.clone(), cache);
    storage.touch_derived_cache(&id, false, dirty, persistent)?;
    storage.enforce_derived_cache_limits()
}

pub(super) fn load_or_build_search_text_cache(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &StoredBook,
) -> Result<Arc<SearchTextCache>, String> {
    let cache = load_or_build_derived_cache(storage, tasks, book, true)?
        .search
        .ok_or_else(|| "Search text cache was not built".to_string())?;
    if book.word_count.is_none() {
        let word_count = word_count_from_search_sections(&cache.sections);
        storage.store_word_count_if_missing(&book.id, book.source_revision, word_count)?;
    }
    Ok(cache)
}

pub(super) fn load_or_build_image_index_cache(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &StoredBook,
) -> Result<Arc<ImageIndexCache>, String> {
    Ok(load_or_build_derived_cache(storage, tasks, book, false)?.image)
}

fn load_or_build_derived_cache(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &StoredBook,
    include_search: bool,
) -> Result<DerivedCacheBuild, String> {
    let memory_search = include_search
        .then(|| load_search_text_memory_cache(storage, book))
        .transpose()?
        .flatten();
    let memory_image = load_image_index_memory_cache(storage, book)?;
    if (!include_search || memory_search.is_some())
        && let Some(image) = memory_image
    {
        return Ok(DerivedCacheBuild {
            search: memory_search,
            image,
        });
    }

    let disk_search = if include_search && memory_search.is_none() {
        read_search_text_cache(storage, book).ok().map(Arc::new)
    } else {
        memory_search
    };
    let disk_image = if memory_image.is_none() {
        read_image_index_cache(storage, book).ok().map(Arc::new)
    } else {
        memory_image
    };
    if let Some(search) = &disk_search {
        store_search_text_memory_cache(
            storage,
            book.id.clone(),
            Arc::clone(search),
            false,
            book.scope == BookScope::Library,
        )?;
    }
    if let Some(image) = &disk_image {
        store_image_index_memory_cache(
            storage,
            book.id.clone(),
            Arc::clone(image),
            false,
            book.scope == BookScope::Library,
        )?;
    }
    if (!include_search || disk_search.is_some())
        && let Some(image) = disk_image
    {
        return Ok(DerivedCacheBuild {
            search: disk_search,
            image,
        });
    }

    let key = derived_cache_task_key(book);
    let task_storage = storage.clone();
    let task_book = book.clone();
    let task_runner = tasks.clone();
    let built: DerivedCacheBuild = tasks.get_or_run(key, TaskPriority::Foreground, move || {
        task_runner.run_book_exclusive(&task_book.id, TaskPriority::Foreground, || {
            if let Some(image) = load_image_index_memory_cache(&task_storage, &task_book)? {
                let search = if include_search {
                    load_search_text_memory_cache(&task_storage, &task_book)?
                } else {
                    None
                };
                if !include_search || search.is_some() {
                    return Ok(DerivedCacheBuild { search, image });
                }
            }

            task_runner.run_cpu(TaskPriority::Foreground, || {
                let built = build_derived_cache(&task_storage, &task_runner, &task_book, include_search)?;
                let current_book = task_storage.stored_book(&task_book.id)?;
                if let Some(search) = &built.search {
                    if !search_text_cache_matches_book(search, &current_book) {
                        return Err("Search text cache is stale".to_string());
                    }
                    store_search_text_memory_cache(
                        &task_storage,
                        task_book.id.clone(),
                        Arc::clone(search),
                        true,
                        current_book.scope == BookScope::Library,
                    )?;
                }
                if !image_index_cache_matches_book(&built.image, &current_book) {
                    return Err("Image index cache is stale".to_string());
                }
                store_image_index_memory_cache(
                    &task_storage,
                    task_book.id.clone(),
                    Arc::clone(&built.image),
                    true,
                    current_book.scope == BookScope::Library,
                )?;
                Ok(built)
            })
        })
    })?;

    if include_search && built.search.is_none() {
        return load_or_build_derived_cache(storage, tasks, book, true);
    }
    Ok(built)
}

#[cfg(test)]
fn load_or_build_search_text_cache_with_builder(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &StoredBook,
    builder: impl FnOnce(&AppStorage, &TaskService, &StoredBook) -> Result<SearchTextCache, String>,
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
        store_search_text_memory_cache(
            storage,
            book.id.clone(),
            cache.clone(),
            false,
            book.scope == BookScope::Library,
        )?;
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

    let key = derived_cache_task_key(book);
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
    store_search_text_memory_cache(
        storage,
        book.id.clone(),
        cache.clone(),
        false,
        book.scope == BookScope::Library,
    )?;
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

fn derived_cache_task_key(book: &StoredBook) -> TaskKey {
    TaskKey::new(
        TaskKind::SearchIndex,
        format!("{}:{}:{}", book.id, book.source_revision, book.revision),
    )
}

fn build_derived_cache(
    storage: &AppStorage,
    tasks: &TaskService,
    book: &StoredBook,
    include_search: bool,
) -> Result<DerivedCacheBuild, String> {
    let content_mode = inspect_and_store_book_content_access(storage, book)?;
    let can_read_current_content_from_archive = book.source_format == BookSourceFormat::Epub
        && (!book.editable || content_mode == BookContentMode::ArchiveOnly);
    let (search_sections, mut image_sections) = if can_read_current_content_from_archive {
        read_derived_sections_from_epub_package(&available_book_source_path(storage, book)?, include_search)?
    } else {
        let unpacked_dir = storage.book_dir(&book.id).join(UNPACKED_DIR);
        ensure_book_package_path(storage, tasks, book)?;
        read_derived_sections_from_unpacked(&unpacked_dir, include_search)?
    };
    finalize_image_index(&mut image_sections);

    Ok(DerivedCacheBuild {
        search: include_search.then(|| {
            Arc::new(SearchTextCache {
                version: SEARCH_TEXT_CACHE_VERSION,
                source_revision: book.source_revision,
                revision: book.revision,
                sections: search_sections,
            })
        }),
        image: Arc::new(ImageIndexCache {
            version: IMAGE_INDEX_CACHE_VERSION,
            source_revision: book.source_revision,
            revision: book.revision,
            sections: image_sections,
        }),
    })
}

#[cfg(test)]
pub(super) fn read_search_text_sections_from_unpacked(unpacked_dir: &Path) -> Result<Vec<SearchTextSection>, String> {
    let mut source = UnpackedPublicationSource::new(unpacked_dir);
    Ok(read_derived_sections_from_source(&mut source, true)?.0)
}

fn read_derived_sections_from_unpacked(
    unpacked_dir: &Path,
    include_search: bool,
) -> Result<(Vec<SearchTextSection>, Vec<ImageIndexSection>), String> {
    let mut source = UnpackedPublicationSource::new(unpacked_dir);
    read_derived_sections_from_source(&mut source, include_search)
}

fn read_derived_sections_from_epub_package(
    path: &Path,
    include_search: bool,
) -> Result<(Vec<SearchTextSection>, Vec<ImageIndexSection>), String> {
    with_epub_package_source(path, |source| read_derived_sections_from_source(source, include_search))
}

fn with_epub_package_source<T>(
    path: &Path,
    read: impl FnOnce(&mut ArchivePublicationSource<fs::File>) -> Result<T, String>,
) -> Result<T, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    validate_epub_archive_limits(&mut archive)?;
    let mut source = ArchivePublicationSource::new(archive);
    read(&mut source)
}

fn derived_manifest(opf_doc: &roxmltree::Document<'_>) -> HashMap<String, DerivedManifestItem> {
    opf_doc
        .descendants()
        .filter(|node| node.is_element() && node.has_tag_name("item"))
        .filter_map(|node| {
            let id = node.attribute("id")?.to_string();
            let href = node.attribute("href")?.to_string();
            Some((
                id,
                DerivedManifestItem {
                    href,
                    media_type: node.attribute("media-type").unwrap_or("").to_string(),
                    properties: node.attribute("properties").unwrap_or("").to_string(),
                },
            ))
        })
        .collect()
}

fn visit_derived_spine_documents(
    source: &mut impl PublicationSource,
    opf_doc: &roxmltree::Document<'_>,
    manifest: &HashMap<String, DerivedManifestItem>,
    opf_dir: &str,
    mut visit: impl FnMut(usize, String, &str) -> Result<(), String>,
) -> Result<(), String> {
    let mut total_document_bytes = 0u64;
    for (section_index, itemref) in opf_doc
        .descendants()
        .filter(|node| node.is_element() && node.has_tag_name("itemref"))
        .enumerate()
    {
        let Some(item) = itemref.attribute("idref").and_then(|idref| manifest.get(idref)) else {
            continue;
        };
        if !is_search_text_document_media_type(&item.media_type) {
            continue;
        }

        let normalized_href = normalize_zip_path(href_without_fragment(&item.href).replace('\\', "/"));
        if normalized_href.is_empty() {
            continue;
        }

        let section_path = normalize_zip_path(join_zip_path(opf_dir, &normalized_href));
        let xhtml = source.read_document(&section_path)?;
        total_document_bytes = total_document_bytes
            .checked_add(xhtml.len() as u64)
            .ok_or_else(|| "EPUB search text size overflows the supported limit".to_string())?;
        if total_document_bytes > EPUB_MAX_SEARCH_TEXT_BYTES {
            return Err("EPUB search text exceeds the supported size limit".to_string());
        }
        visit(section_index, normalized_href, &xhtml)?;
    }
    Ok(())
}

fn read_derived_sections_from_source(
    source: &mut impl PublicationSource,
    include_search: bool,
) -> Result<(Vec<SearchTextSection>, Vec<ImageIndexSection>), String> {
    let (opf_path, opf) = read_package_document(source)?;
    let opf_doc = roxmltree::Document::parse(&opf).map_err(|error| error.to_string())?;
    let opf_dir = parent_zip_path(&opf_path).to_string();

    let manifest = derived_manifest(&opf_doc);
    let nav_items = if include_search {
        read_search_text_nav_items(source, &opf_doc, &manifest, &opf_dir)
            .into_iter()
            .fold(HashMap::new(), |mut items, item| {
                items.entry(item.href.clone()).or_insert(item);
                items
            })
    } else {
        HashMap::new()
    };

    let mut sections = Vec::new();
    let mut image_sections = Vec::new();
    visit_derived_spine_documents(
        source,
        &opf_doc,
        &manifest,
        &opf_dir,
        |section_index, normalized_href, xhtml| {
            let (search_data, image_section) =
                parse_derived_section(section_index, normalized_href.clone(), xhtml, include_search);
            image_sections.push(image_section);
            let Some((text, title)) = search_data else {
                return Ok(());
            };
            let nav_item = nav_items.get(&normalized_href).cloned();

            sections.push(SearchTextSection {
                section_index,
                href: normalized_href,
                title: nav_item.as_ref().map(|item| item.label.clone()).or(title),
                nav_path: nav_item.map(|item| item.path).unwrap_or_default(),
                text,
            });
            Ok(())
        },
    )?;

    Ok((sections, image_sections))
}

#[derive(Default)]
struct WordCounter {
    non_whitespace_character_count: u64,
    non_cjk_token_count: u64,
    has_cjk: bool,
    token_has_alphanumeric: bool,
}

trait VisibleTextSink {
    fn push_text(&mut self, text: &str);
    fn boundary(&mut self);
}

impl VisibleTextSink for String {
    fn push_text(&mut self, text: &str) {
        self.push_str(text);
    }

    fn boundary(&mut self) {
        push_search_text_boundary(self);
    }
}

impl VisibleTextSink for WordCounter {
    fn push_text(&mut self, text: &str) {
        for character in text.chars() {
            if character.is_whitespace() {
                self.finish_token();
            } else {
                self.non_whitespace_character_count = self.non_whitespace_character_count.saturating_add(1);
                self.has_cjk |= is_cjk_character(character);
                self.token_has_alphanumeric |= character.is_alphanumeric();
            }
        }
    }

    fn boundary(&mut self) {
        self.finish_token();
    }
}

impl WordCounter {
    fn finish_token(&mut self) {
        if self.token_has_alphanumeric {
            self.non_cjk_token_count = self.non_cjk_token_count.saturating_add(1);
        }
        self.token_has_alphanumeric = false;
    }

    fn count(&self) -> u64 {
        if self.has_cjk {
            self.non_whitespace_character_count
        } else {
            self.non_cjk_token_count
        }
    }
}

fn is_cjk_character(character: char) -> bool {
    matches!(
        character as u32,
        0x1100..=0x11ff
            | 0x2e80..=0x2fdf
            | 0x3040..=0x30ff
            | 0x3130..=0x318f
            | 0x31f0..=0x31ff
            | 0x3400..=0x4dbf
            | 0x4e00..=0x9fff
            | 0xac00..=0xd7af
            | 0xf900..=0xfaff
            | 0x20000..=0x323af
    )
}

fn word_count_from_search_sections(sections: &[SearchTextSection]) -> u64 {
    let mut counter = WordCounter::default();
    for section in sections {
        counter.push_text(&section.text);
        counter.boundary();
    }
    counter.count()
}

fn count_words_in_xhtml(xhtml: &str, counter: &mut WordCounter) {
    let cleaned = remove_doctype_declaration(xhtml);
    let Ok(document) = roxmltree::Document::parse(&cleaned) else {
        counter.push_text(&strip_html_for_search_text(&cleaned));
        counter.boundary();
        return;
    };
    let body = document
        .descendants()
        .find(|node| node.is_element() && node.has_tag_name("body"))
        .unwrap_or_else(|| document.root_element());
    append_visible_text(body, counter);
    counter.boundary();
}

fn count_words_from_source(source: &mut impl PublicationSource) -> Result<u64, String> {
    let (opf_path, opf) = read_package_document(source)?;
    let opf_doc = roxmltree::Document::parse(&opf).map_err(|error| error.to_string())?;
    let opf_dir = parent_zip_path(&opf_path).to_string();
    let manifest = derived_manifest(&opf_doc);

    let mut counter = WordCounter::default();
    visit_derived_spine_documents(source, &opf_doc, &manifest, &opf_dir, |_, _, xhtml| {
        count_words_in_xhtml(xhtml, &mut counter);
        Ok(())
    })?;
    Ok(counter.count())
}

fn count_words_from_epub_package(path: &Path) -> Result<u64, String> {
    with_epub_package_source(path, count_words_from_source)
}

fn count_words_from_unpacked(unpacked_dir: &Path) -> Result<u64, String> {
    count_words_from_source(&mut UnpackedPublicationSource::new(unpacked_dir))
}

fn compute_book_word_count(storage: &AppStorage, tasks: &TaskService, book: &StoredBook) -> Result<u64, String> {
    if book.source_format == BookSourceFormat::Epub {
        return count_words_from_epub_package(&available_book_source_path(storage, book)?);
    }

    let unpacked_dir = storage.book_dir(&book.id).join(UNPACKED_DIR);
    ensure_book_package_path(storage, tasks, book)?;
    count_words_from_unpacked(&unpacked_dir)
}

pub(super) fn get_or_compute_book_word_count(
    storage: &AppStorage,
    tasks: &TaskService,
    id: &str,
) -> Result<u64, String> {
    let book = storage.stored_book(id)?;
    if let Some(word_count) = book.word_count {
        return Ok(word_count);
    }

    tasks.run_book_exclusive(id, TaskPriority::Foreground, || {
        let book = storage.stored_book(id)?;
        if let Some(word_count) = book.word_count {
            return Ok(word_count);
        }
        let word_count = tasks.run_cpu(TaskPriority::Foreground, || {
            compute_book_word_count(storage, tasks, &book)
        })?;
        storage.store_word_count_if_missing(id, book.source_revision, word_count)
    })
}

impl AppStorage {
    fn store_word_count_if_missing(&self, id: &str, source_revision: u32, word_count: u64) -> Result<u64, String> {
        let stored = {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;
            let book = state
                .library
                .books
                .iter_mut()
                .find(|book| book.id == id)
                .ok_or_else(|| "Book not found".to_string())?;
            if book.source_revision != source_revision {
                return Err("Book word count is stale".to_string());
            }
            if let Some(existing) = book.word_count {
                return Ok(existing);
            }
            book.word_count = Some(word_count);
            word_count
        };
        self.mark_library_dirty();
        Ok(stored)
    }
}

fn read_search_text_nav_items(
    source: &mut impl PublicationSource,
    opf_doc: &roxmltree::Document,
    manifest: &HashMap<String, DerivedManifestItem>,
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
    source: &mut impl PublicationSource,
    opf_dir: &str,
    nav_href: &str,
) -> Result<Vec<SearchTextNavItem>, String> {
    let normalized_href = normalize_zip_path(href_without_fragment(nav_href).replace('\\', "/"));
    if normalized_href.is_empty() {
        return Ok(Vec::new());
    }

    let nav_path = normalize_zip_path(join_zip_path(opf_dir, &normalized_href));
    let nav_text = source.read_xml(&nav_path)?;
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
            if let Some(href) = href {
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
    source: &mut impl PublicationSource,
    opf_dir: &str,
    ncx_href: &str,
) -> Result<Vec<SearchTextNavItem>, String> {
    let normalized_href = normalize_zip_path(href_without_fragment(ncx_href).replace('\\', "/"));
    if normalized_href.is_empty() {
        return Ok(Vec::new());
    }

    let ncx_path = normalize_zip_path(join_zip_path(opf_dir, &normalized_href));
    let ncx_text = source.read_xml(&ncx_path)?;
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
            if let Some(href) = href {
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

fn section_hrefs_match(left: &str, right: &str) -> bool {
    let left = href_without_fragment(left).trim_start_matches('/');
    let right = href_without_fragment(right).trim_start_matches('/');
    !left.is_empty()
        && !right.is_empty()
        && (left == right
            || left.strip_suffix(right).is_some_and(|prefix| prefix.ends_with('/'))
            || right.strip_suffix(left).is_some_and(|prefix| prefix.ends_with('/')))
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

#[cfg(test)]
pub(super) fn visible_search_text_from_xhtml(xhtml: &str) -> String {
    search_text_and_title_from_xhtml(xhtml).0
}

#[cfg(test)]
fn search_text_and_title_from_xhtml(xhtml: &str) -> (String, Option<String>) {
    let xhtml = remove_doctype_declaration(xhtml);
    let Ok(doc) = roxmltree::Document::parse(&xhtml) else {
        return (strip_html_for_search_text(&xhtml), None);
    };

    search_text_and_title_from_document(&doc)
}

fn parse_derived_section(
    section_index: usize,
    href: String,
    xhtml: &str,
    include_search: bool,
) -> (Option<(String, Option<String>)>, ImageIndexSection) {
    let cleaned = remove_doctype_declaration(xhtml);
    let Ok(document) = roxmltree::Document::parse(&cleaned) else {
        let search = include_search.then(|| (strip_html_for_search_text(&cleaned), None));
        return (
            search,
            ImageIndexSection {
                index: section_index,
                href,
                images: Vec::new(),
            },
        );
    };
    let search = include_search.then(|| search_text_and_title_from_document(&document));
    let image = image_index_section_from_document(section_index, href, &document);
    (search, image)
}

fn search_text_and_title_from_document(doc: &roxmltree::Document<'_>) -> (String, Option<String>) {
    let body = doc
        .descendants()
        .find(|node| node.is_element() && node.has_tag_name("body"))
        .unwrap_or_else(|| doc.root_element());

    let mut text = String::new();
    append_visible_text(body, &mut text);

    let title = body
        .descendants()
        .find(|node| node.is_element() && matches!(node.tag_name().name(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6"))
        .map(node_search_text)
        .filter(|title| !title.is_empty())
        .or_else(|| {
            doc.descendants()
                .find(|node| node.is_element() && node.has_tag_name("title"))
                .map(node_search_text)
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

fn append_visible_text(node: roxmltree::Node, output: &mut impl VisibleTextSink) {
    if node.is_text() {
        if let Some(text) = node.text() {
            output.push_text(text);
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
        output.boundary();
    }

    for child in node.children() {
        append_visible_text(child, output);
    }

    if block {
        output.boundary();
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
    search_text_in_cache_cancellable(cache, keyword, limit, || false)
}

pub(super) fn search_text_in_cache_cancellable(
    cache: &SearchTextCache,
    keyword: &str,
    limit: Option<usize>,
    cancelled: impl Fn() -> bool,
) -> Vec<SearchTextResult> {
    let started = Instant::now();
    let keyword = keyword.trim();
    if keyword.is_empty() || limit == Some(0) || cancelled() {
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
        if cancelled() {
            return Vec::new();
        }
        let fold_started = diagnostics_enabled.then(Instant::now);
        let (folded_text, original_char_offsets) = lowercase_with_original_char_offsets(&section.text);
        if let Some(fold_started) = fold_started {
            fold_elapsed += fold_started.elapsed();
        }
        let mut previous_folded_byte_offset = 0usize;
        let mut folded_char_offset = 0usize;
        let mut subitems = Vec::new();
        let mut text_chars = None;
        let mut paragraph_start = ParagraphCursor::default();
        let mut paragraph_end = ParagraphCursor::default();

        for (occurrence, (folded_byte_offset, _)) in folded_text.match_indices(&folded_keyword).enumerate() {
            if cancelled() {
                return Vec::new();
            }
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
            let chars = text_chars.get_or_insert_with(|| section.text.chars().collect::<Vec<_>>());
            let offset = char_offset.min(chars.len());
            let start = paragraph_start.at(chars, offset).start;
            let end = paragraph_end
                .at(chars, (offset + keyword_char_len).min(chars.len()))
                .end;
            let excerpt = search_text_excerpt(chars, offset, keyword_char_len, start, end);
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

    if cancelled() { Vec::new() } else { results }
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

#[derive(Default)]
struct ParagraphCursor {
    next: usize,
    bounds: std::ops::Range<usize>,
}

impl ParagraphCursor {
    fn at(&mut self, chars: &[char], offset: usize) -> &std::ops::Range<usize> {
        // Matches arrive in order; scan and trim each paragraph at most once per cursor.
        while self.next <= offset {
            let mut start = self.next;
            let mut end = chars[start..]
                .iter()
                .position(|ch| *ch == '\n')
                .map_or(chars.len(), |i| start + i);
            self.next = end + 1;
            while start < end && chars[start].is_whitespace() {
                start += 1;
            }
            while end > start && chars[end - 1].is_whitespace() {
                end -= 1;
            }
            self.bounds = start..end;
        }
        &self.bounds
    }
}

fn search_text_excerpt(
    chars: &[char],
    offset: usize,
    keyword_len: usize,
    paragraph_start: usize,
    paragraph_end: usize,
) -> String {
    if chars.is_empty() {
        return String::new();
    }

    let offset = offset.min(chars.len());
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

impl AppStorage {
    pub(super) fn derived_cache_is_active(&self, id: &str) -> Result<bool, String> {
        Ok(self
            .inner
            .derived_cache_states
            .lock()
            .map_err(|_| "derived cache state lock poisoned".to_string())?
            .get(id)
            .is_some_and(|state| state.active))
    }

    pub(super) fn set_derived_cache_active(&self, id: &str, active: bool) -> Result<(), String> {
        let persistent = self.stored_book(id)?.scope == BookScope::Library;
        let has_cache = self
            .inner
            .search_text_caches
            .lock()
            .map_err(|_| "search text cache lock poisoned".to_string())?
            .contains_key(id)
            || self
                .inner
                .image_index_caches
                .lock()
                .map_err(|_| "image index cache lock poisoned".to_string())?
                .contains_key(id);
        {
            let mut states = self
                .inner
                .derived_cache_states
                .lock()
                .map_err(|_| "derived cache state lock poisoned".to_string())?;
            let state = states
                .entry(id.to_string())
                .or_insert_with(|| DerivedCacheState::active(persistent));
            state.active = active;
            state.persistent = persistent;
            state.last_accessed = Instant::now();
            state.cold_since = (!active).then(Instant::now);
        }
        if !active && has_cache {
            self.flush_derived_cache(id)?;
        }
        Ok(())
    }

    fn touch_derived_cache(
        &self,
        id: &str,
        search_dirty: bool,
        image_dirty: bool,
        persistent: bool,
    ) -> Result<(), String> {
        let mut states = self
            .inner
            .derived_cache_states
            .lock()
            .map_err(|_| "derived cache state lock poisoned".to_string())?;
        let state = states
            .entry(id.to_string())
            .or_insert_with(|| DerivedCacheState::active(persistent));
        state.last_accessed = Instant::now();
        state.persistent = persistent;
        state.search_dirty |= persistent && search_dirty;
        state.image_dirty |= persistent && image_dirty;
        Ok(())
    }

    pub(super) fn update_derived_caches_after_edit(
        &self,
        previous_book: &StoredBook,
        book: &StoredBook,
        section_href: &str,
        xhtml: &str,
    ) -> Result<(), String> {
        if book.scope == BookScope::Library {
            let _ = fs::remove_file(self.search_text_cache_path(
                &book.id,
                previous_book.source_revision,
                previous_book.revision,
            ));
            let _ = fs::remove_file(self.image_index_cache_path(
                &book.id,
                previous_book.source_revision,
                previous_book.revision,
            ));
        }
        let has_search = self
            .inner
            .search_text_caches
            .lock()
            .map_err(|_| "search text cache lock poisoned".to_string())?
            .contains_key(&book.id);
        let has_image = self
            .inner
            .image_index_caches
            .lock()
            .map_err(|_| "image index cache lock poisoned".to_string())?
            .contains_key(&book.id);
        if !has_search && !has_image {
            return Ok(());
        }
        let (search_data, image_section) = parse_derived_section(0, section_href.to_string(), xhtml, has_search);
        let mut updated_search = false;
        {
            let mut caches = self
                .inner
                .search_text_caches
                .lock()
                .map_err(|_| "search text cache lock poisoned".to_string())?;
            if let Some(cache) = caches.get_mut(&book.id)
                && let Some(index) = cache
                    .sections
                    .iter()
                    .position(|section| section_hrefs_match(&section.href, section_href))
            {
                let cache = Arc::make_mut(cache);
                cache.revision = book.revision;
                let (text, title) = search_data.unwrap_or_default();
                cache.sections[index].text = text;
                if title.is_some() {
                    cache.sections[index].title = title;
                }
                updated_search = true;
            }
        }

        let mut updated_image = false;
        {
            let mut caches = self
                .inner
                .image_index_caches
                .lock()
                .map_err(|_| "image index cache lock poisoned".to_string())?;
            if let Some(cache) = caches.get_mut(&book.id)
                && let Some(index) = cache
                    .sections
                    .iter()
                    .position(|section| section_hrefs_match(&section.href, section_href))
            {
                let cache = Arc::make_mut(cache);
                cache.revision = book.revision;
                let section_index = cache.sections[index].index;
                cache.sections[index] = ImageIndexSection {
                    index: section_index,
                    href: cache.sections[index].href.clone(),
                    images: image_section.images,
                };
                finalize_image_index(&mut cache.sections);
                updated_image = true;
            }
        }

        if updated_search || updated_image {
            self.touch_derived_cache(
                &book.id,
                updated_search,
                updated_image,
                book.scope == BookScope::Library,
            )?;
        }
        Ok(())
    }

    pub(super) fn flush_all_derived_caches(&self) -> Result<(), String> {
        let ids = self
            .inner
            .derived_cache_states
            .lock()
            .map_err(|_| "derived cache state lock poisoned".to_string())?
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut errors = Vec::new();
        for id in ids {
            if let Err(error) = self.flush_derived_cache(&id) {
                errors.push(format!("{id}: {error}"));
            }
        }
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }
        Ok(())
    }

    fn flush_derived_cache(&self, id: &str) -> Result<(), String> {
        let _flush_guard = self
            .inner
            .derived_cache_flush_lock
            .lock()
            .map_err(|_| "derived cache flush lock poisoned".to_string())?;
        let (search_dirty, image_dirty) = self
            .inner
            .derived_cache_states
            .lock()
            .map_err(|_| "derived cache state lock poisoned".to_string())?
            .get(id)
            .map(|state| (state.search_dirty, state.image_dirty))
            .unwrap_or_default();
        let search = search_dirty
            .then(|| {
                self.inner
                    .search_text_caches
                    .lock()
                    .map_err(|_| "search text cache lock poisoned".to_string())
                    .map(|caches| caches.get(id).cloned())
            })
            .transpose()?
            .flatten();
        let image = image_dirty
            .then(|| {
                self.inner
                    .image_index_caches
                    .lock()
                    .map_err(|_| "image index cache lock poisoned".to_string())
                    .map(|caches| caches.get(id).cloned())
            })
            .transpose()?
            .flatten();

        let mut errors = Vec::new();
        let search_published = match &search {
            Some(cache) => match write_search_text_cache_if_current(self, id, cache) {
                Ok(published) => published,
                Err(error) => {
                    errors.push(format!("search: {error}"));
                    false
                }
            },
            None => false,
        };
        let image_published = match &image {
            Some(cache) => match write_image_index_cache_if_current(self, id, cache) {
                Ok(published) => published,
                Err(error) => {
                    errors.push(format!("image: {error}"));
                    false
                }
            },
            None => false,
        };

        let search_unchanged = if search_published {
            let caches = self
                .inner
                .search_text_caches
                .lock()
                .map_err(|_| "search text cache lock poisoned".to_string())?;
            search
                .as_ref()
                .is_some_and(|cache| caches.get(id).is_some_and(|current| Arc::ptr_eq(current, cache)))
        } else {
            false
        };
        let image_unchanged = if image_published {
            let caches = self
                .inner
                .image_index_caches
                .lock()
                .map_err(|_| "image index cache lock poisoned".to_string())?;
            image
                .as_ref()
                .is_some_and(|cache| caches.get(id).is_some_and(|current| Arc::ptr_eq(current, cache)))
        } else {
            false
        };

        let mut states = self
            .inner
            .derived_cache_states
            .lock()
            .map_err(|_| "derived cache state lock poisoned".to_string())?;
        if let Some(state) = states.get_mut(id) {
            if search_dirty && (search.is_none() || search_unchanged) {
                state.search_dirty = false;
            }
            if image_dirty && (image.is_none() || image_unchanged) {
                state.image_dirty = false;
            }
        }
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }
        Ok(())
    }

    fn derived_cache_usage(&self) -> Result<(usize, usize), String> {
        let search = self
            .inner
            .search_text_caches
            .lock()
            .map_err(|_| "search text cache lock poisoned".to_string())?;
        let image = self
            .inner
            .image_index_caches
            .lock()
            .map_err(|_| "image index cache lock poisoned".to_string())?;
        let ids = search.keys().chain(image.keys()).collect::<HashSet<_>>().len();
        let search_bytes = search
            .values()
            .map(|cache| search_cache_estimated_bytes(cache))
            .sum::<usize>();
        let image_bytes = image
            .values()
            .map(|cache| image_cache_estimated_bytes(cache))
            .sum::<usize>();
        Ok((ids, search_bytes.saturating_add(image_bytes)))
    }

    fn enforce_derived_cache_limits(&self) -> Result<(), String> {
        loop {
            let (count, bytes) = self.derived_cache_usage()?;
            if count <= DERIVED_CACHE_BOOK_LIMIT && bytes <= DERIVED_CACHE_MEMORY_SOFT_LIMIT {
                return Ok(());
            }
            let candidate = self
                .inner
                .derived_cache_states
                .lock()
                .map_err(|_| "derived cache state lock poisoned".to_string())?
                .iter()
                .min_by_key(|(_, state)| (state.active, state.persistent, state.last_accessed))
                .map(|(id, _)| id.clone());
            let Some(candidate) = candidate else {
                return Ok(());
            };
            self.flush_derived_cache(&candidate)?;
            self.remove_derived_memory_caches(&candidate);
        }
    }

    pub(super) fn maintain_derived_caches(&self) -> Result<(), String> {
        let now = Instant::now();
        let expired = self
            .inner
            .derived_cache_states
            .lock()
            .map_err(|_| "derived cache state lock poisoned".to_string())?
            .iter()
            .filter(|(_, state)| {
                !state.active
                    && state
                        .cold_since
                        .is_some_and(|cold_since| now.duration_since(cold_since) >= DERIVED_CACHE_COLD_TTL)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in expired {
            self.flush_derived_cache(&id)?;
            self.remove_derived_memory_caches(&id);
        }
        self.enforce_derived_cache_limits()
    }

    pub(crate) fn start_derived_cache_maintenance(&self) {
        let storage = self.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(60));
                if let Err(error) = storage.maintain_derived_caches() {
                    eprintln!("Failed to maintain derived book caches: {error}");
                }
            }
        });
    }
}

fn search_cache_estimated_bytes(cache: &SearchTextCache) -> usize {
    cache
        .sections
        .iter()
        .map(|section| {
            section.href.len()
                + section.title.as_ref().map_or(0, String::len)
                + section.nav_path.iter().map(String::len).sum::<usize>()
                + section.text.len()
                + 96
        })
        .sum()
}

fn image_cache_estimated_bytes(cache: &ImageIndexCache) -> usize {
    cache
        .sections
        .iter()
        .map(|section| {
            section.href.len()
                + section
                    .images
                    .iter()
                    .map(|image| image.src.len() + image.reason.as_ref().map_or(0, String::len) + 48)
                    .sum::<usize>()
                + 48
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        collections::HashMap,
        path::Path,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn cancelling_a_search_discards_only_its_results() {
        let requests = SearchRequests::default();
        let old = requests.start("old".into()).unwrap();
        let current = requests.start("current".into()).unwrap();
        requests.cancel("old").unwrap();
        let cache = SearchTextCache {
            version: 1,
            source_revision: 1,
            revision: 1,
            sections: vec![SearchTextSection {
                section_index: 0,
                href: "chapter.xhtml".into(),
                title: None,
                nav_path: vec![],
                text: "target target".into(),
            }],
        };
        assert!(search_text_in_cache_cancellable(&cache, "target", None, || old.cancelled()).is_empty());
        assert_eq!(
            search_text_in_cache_cancellable(&cache, "target", None, || current.cancelled())[0]
                .subitems
                .len(),
            2
        );
        drop(old);
        requests.cancel("old").unwrap();
        assert!(!current.cancelled());
    }

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("flow-reader-{label}-{}-{nonce}", std::process::id()))
    }

    fn test_book(id: &str, revision: u32) -> StoredBook {
        StoredBook {
            id: id.to_string(),
            scope: BookScope::Library,
            name: format!("{id}.epub"),
            size: 1,
            reading_status: None,
            source_format: BookSourceFormat::Epub,
            generated_cover: false,
            content_edited_at: None,
            word_count: None,
            source_hash: format!("hash-{revision}"),
            source_revision: revision,
            revision,
            latest_export_revision: None,
            latest_export_hash: None,
            content_mode: BookContentMode::Normal,
            editable: true,
            source_storage: SourceStorage::Managed,
            source_path: PathBuf::from(format!("{id}.epub")),
            metadata: empty_object(),
            created_at: 1,
            updated_at: None,
            last_read_at: None,
            cfi: None,
            percentage: None,
            tag_ids: Vec::new(),
        }
    }

    fn test_storage(root: &Path, books: Vec<StoredBook>) -> AppStorage {
        AppStorage {
            inner: Arc::new(StorageInner {
                root: root.to_path_buf(),
                state: Mutex::new(StorageState::new(
                    Library {
                        version: 1,
                        books,
                        tags: Vec::new(),
                        pins: LibraryPins::default(),
                        recent_book_ids: Vec::new(),
                    },
                    json!({}),
                )),
                dirty: Mutex::new(DirtyState::default()),
                flush_lock: Mutex::new(()),
                import_lock: Mutex::new(()),
                search_text_caches: Mutex::new(HashMap::new()),
                image_index_caches: Mutex::new(HashMap::new()),
                derived_cache_states: Mutex::new(HashMap::new()),
                derived_cache_flush_lock: Mutex::new(()),
                archive_resources: Mutex::new(HashMap::new()),
                text_import_prepare_runs: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepare_active: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepare_max_active: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepare_delay_ms: std::sync::atomic::AtomicU64::new(0),
                text_import_prepared_handoff_active: std::sync::atomic::AtomicUsize::new(0),
                text_import_prepared_handoff_max_active: std::sync::atomic::AtomicUsize::new(0),
            }),
        }
    }

    fn test_cache(book: &StoredBook, text: &str) -> SearchTextCache {
        SearchTextCache {
            version: SEARCH_TEXT_CACHE_VERSION,
            source_revision: book.source_revision,
            revision: book.revision,
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
    fn counts_cjk_characters_and_non_cjk_whitespace_tokens() {
        for (text, expected) in [
            ("你好，世界！", 6),
            ("你好 ， 世界", 5),
            ("version 2.0", 2),
            ("a - b", 2),
            ("a-b", 1),
        ] {
            let mut counter = WordCounter::default();
            counter.push_text(text);
            counter.boundary();
            assert_eq!(counter.count(), expected, "{text}");
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
    fn search_index_reuses_in_flight_build_for_same_book_revision() {
        let root = temp_root("search-idempotent-test");
        let storage = Arc::new(test_storage(&root, vec![test_book("book", 1)]));
        let tasks = Arc::new(TaskService::default());
        let runs = Arc::new(AtomicUsize::new(0));
        let book = storage.stored_book("book").unwrap();

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
        let book = storage.stored_book("book").unwrap();
        let cache = test_cache(&book, "old content");

        {
            let mut state = storage.inner.state.lock().unwrap();
            let book = state.library.books.iter_mut().find(|book| book.id == "book").unwrap();
            book.source_hash = "hash-2".to_string();
            book.source_revision = 2;
        }

        let published = write_search_text_cache_if_current(&storage, "book", &cache).unwrap();

        assert!(!published);
        assert!(
            !storage
                .search_text_cache_path("book", book.source_revision, book.revision)
                .exists()
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_memory_cache_is_bounded_by_book_count() {
        let root = temp_root("search-memory-bound-test");
        let books = (0..=DERIVED_CACHE_BOOK_LIMIT)
            .map(|index| test_book(&format!("book-{index}"), 1))
            .collect::<Vec<_>>();
        let storage = test_storage(&root, books.clone());

        for book in &books {
            store_search_text_memory_cache(
                &storage,
                book.id.clone(),
                Arc::new(test_cache(book, &book.id)),
                false,
                true,
            )
            .unwrap();
        }

        let caches = storage.inner.search_text_caches.lock().unwrap();

        assert!(caches.len() <= DERIVED_CACHE_BOOK_LIMIT);
        assert!(!caches.contains_key("book-0"));
        assert!(caches.contains_key(&format!("book-{DERIVED_CACHE_BOOK_LIMIT}")));

        let _ = fs::remove_dir_all(root);
    }
}
