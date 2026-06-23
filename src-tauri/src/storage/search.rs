use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};

use super::*;
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
    pub(super) section_index: usize,
    pub(super) href: String,
    pub(super) occurrence: usize,
    pub(super) offset: usize,
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

fn write_search_text_cache(
    storage: &AppStorage,
    id: &str,
    cache: &SearchTextCache,
) -> Result<(), String> {
    let path = storage.search_text_cache_path(id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let bytes = search_text_cache_to_bytes(cache)?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|error| error.to_string())?;
    fs::rename(&tmp, path).map_err(|error| error.to_string())
}

fn read_search_text_cache(
    storage: &AppStorage,
    book: &LibraryBook,
) -> Result<SearchTextCache, String> {
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
    book: &LibraryBook,
) -> Result<Arc<SearchTextCache>, String> {
    if let Some(cache) = storage
        .inner
        .search_text_caches
        .lock()
        .map_err(|_| "search text cache lock poisoned".to_string())?
        .get(&book.id)
        .filter(|cache| search_text_cache_matches_book(cache, book))
        .cloned()
    {
        return Ok(cache);
    }

    if let Ok(cache) = read_search_text_cache(storage, book) {
        let cache = Arc::new(cache);
        storage
            .inner
            .search_text_caches
            .lock()
            .map_err(|_| "search text cache lock poisoned".to_string())?
            .insert(book.id.clone(), cache.clone());
        return Ok(cache);
    }

    build_and_store_search_text_cache(storage, book)
}

fn build_and_store_search_text_cache(
    storage: &AppStorage,
    book: &LibraryBook,
) -> Result<Arc<SearchTextCache>, String> {
    let cache = build_and_write_search_text_cache(storage, book)?;
    let cache = Arc::new(cache);
    storage
        .inner
        .search_text_caches
        .lock()
        .map_err(|_| "search text cache lock poisoned".to_string())?
        .insert(book.id.clone(), cache.clone());
    Ok(cache)
}

pub(super) fn build_and_write_search_text_cache(
    storage: &AppStorage,
    book: &LibraryBook,
) -> Result<SearchTextCache, String> {
    let cache = build_search_text_cache(storage, book)?;
    write_search_text_cache(storage, &book.id, &cache)?;
    Ok(cache)
}

fn build_search_text_cache(
    storage: &AppStorage,
    book: &LibraryBook,
) -> Result<SearchTextCache, String> {
    let book_dir = storage.book_dir(&book.id);
    let unpacked_dir = book_dir.join(UNPACKED_DIR);

    if !unpacked_dir.exists() {
        let book_path = book_dir.join(BOOK_FILE);
        if book_path.exists() {
            unpack_epub(&book_path, &unpacked_dir)?;
        }
    }

    let sections = read_search_text_sections_from_unpacked(&unpacked_dir)?;
    Ok(SearchTextCache {
        version: SEARCH_TEXT_CACHE_VERSION,
        extractor_version: SEARCH_TEXT_EXTRACTOR_VERSION,
        book_hash: book.content_hash.clone(),
        content_version: book.content_version,
        sections,
    })
}

pub(super) fn read_search_text_sections_from_unpacked(
    unpacked_dir: &Path,
) -> Result<Vec<SearchTextSection>, String> {
    let opf_path = find_unpacked_opf_path(unpacked_dir)?;
    let opf = fs::read_to_string(&opf_path).map_err(|error| error.to_string())?;
    let opf_doc = roxmltree::Document::parse(&opf).map_err(|error| error.to_string())?;
    let opf_dir = opf_path.parent().unwrap_or(unpacked_dir);

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
    let nav_items = read_search_text_nav_items(&opf_doc, &manifest, opf_dir);

    let mut sections = Vec::new();
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

        let normalized_href =
            normalize_zip_path(href_without_fragment(&item.href).replace('\\', "/"));
        if normalized_href.is_empty() {
            continue;
        }

        let section_path = join_relative_unpacked_path(opf_dir, &normalized_href);
        let xhtml = read_text_file_lossy(&section_path)?;
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
    opf_doc: &roxmltree::Document,
    manifest: &HashMap<String, SearchManifestItem>,
    opf_dir: &Path,
) -> Vec<SearchTextNavItem> {
    if let Some(item) = manifest.values().find(|item| {
        item.properties
            .split_whitespace()
            .any(|value| value == "nav")
    }) {
        if let Ok(items) = read_epub3_search_nav_items(opf_dir, &item.href) {
            if !items.is_empty() {
                return items;
            }
        }
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
        .and_then(|item| read_ncx_search_nav_items(opf_dir, &item.href).ok())
        .unwrap_or_default()
}

fn read_epub3_search_nav_items(
    opf_dir: &Path,
    nav_href: &str,
) -> Result<Vec<SearchTextNavItem>, String> {
    let normalized_href = normalize_zip_path(href_without_fragment(nav_href).replace('\\', "/"));
    if normalized_href.is_empty() {
        return Ok(Vec::new());
    }

    let nav_path = join_relative_unpacked_path(opf_dir, &normalized_href);
    let nav_text = read_text_file_lossy(&nav_path)?;
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
    collect_epub3_search_nav_items(
        list,
        parent_zip_path(&normalized_href),
        &mut path,
        &mut items,
    );
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
        let label = label_node
            .map(node_search_text)
            .filter(|label| !label.is_empty());
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
    opf_dir: &Path,
    ncx_href: &str,
) -> Result<Vec<SearchTextNavItem>, String> {
    let normalized_href = normalize_zip_path(href_without_fragment(ncx_href).replace('\\', "/"));
    if normalized_href.is_empty() {
        return Ok(Vec::new());
    }

    let ncx_path = join_relative_unpacked_path(opf_dir, &normalized_href);
    let ncx_text = read_text_file_lossy(&ncx_path)?;
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
    collect_ncx_search_nav_items(
        nav_map,
        parent_zip_path(&normalized_href),
        &mut path,
        &mut items,
    );
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

fn join_relative_unpacked_path(base: &Path, href: &str) -> PathBuf {
    let mut path = base.to_path_buf();
    for part in href.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                path.pop();
            }
            _ => path.push(percent_decode_path_segment(part)),
        }
    }
    path
}

fn percent_decode_path_segment(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }

        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8(decoded).unwrap_or_else(|_| segment.to_string())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn read_text_file_lossy(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
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
        .find(|node| {
            node.is_element()
                && matches!(
                    node.tag_name().name(),
                    "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                )
        })
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
        if first_tag_end.map_or(true, |index| internal_subset_start < index) {
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
    if !output.ends_with(char::is_whitespace) {
        output.push(' ');
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
    value.split_whitespace().collect::<Vec<_>>().join(" ")
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
    limit: usize,
) -> Vec<SearchTextResult> {
    let keyword = keyword.trim();
    if keyword.is_empty() || limit == 0 {
        return Vec::new();
    }

    let folded_keyword = keyword.to_lowercase();
    let mut results = Vec::new();
    let mut total = 0usize;

    'sections: for section in &cache.sections {
        let folded_text = section.text.to_lowercase();
        let mut cursor = 0usize;
        let mut occurrence = 0usize;
        let mut subitems = Vec::new();

        while cursor <= folded_text.len() {
            let Some(relative_offset) = folded_text[cursor..].find(&folded_keyword) else {
                break;
            };
            let folded_byte_offset = cursor + relative_offset;
            let char_offset = folded_text[..folded_byte_offset].chars().count();
            let original_byte_offset = byte_index_for_char_offset(&section.text, char_offset);
            let excerpt = search_text_excerpt(&section.text, char_offset, keyword);
            let id = format!("{}:{}:{}", section.href, occurrence, char_offset);

            subitems.push(SearchTextHit {
                id,
                excerpt,
                cfi: None,
                section_index: section.section_index,
                href: section.href.clone(),
                occurrence,
                offset: char_offset,
            });

            total += 1;
            occurrence += 1;
            if total >= limit {
                break;
            }

            let next_cursor = folded_byte_offset + folded_keyword.len();
            cursor = if next_cursor > folded_byte_offset {
                next_cursor
            } else {
                folded_byte_offset + 1
            };

            if original_byte_offset >= section.text.len() {
                break;
            }
        }

        if !subitems.is_empty() {
            results.push(SearchTextResult {
                id: section.href.clone(),
                excerpt: section
                    .title
                    .clone()
                    .unwrap_or_else(|| section.href.clone()),
                description: (!section.nav_path.is_empty()).then(|| section.nav_path.join(" / ")),
                subitems,
                expanded: true,
            });
        }

        if total >= limit {
            break 'sections;
        }
    }

    results
}

fn byte_index_for_char_offset(text: &str, char_offset: usize) -> usize {
    text.char_indices()
        .nth(char_offset)
        .map(|(index, _)| index)
        .unwrap_or(text.len())
}

fn search_text_excerpt(text: &str, offset: usize, keyword: &str) -> String {
    let chars = text.chars().collect::<Vec<_>>();
    if chars.is_empty() {
        return String::new();
    }

    let keyword_len = keyword.chars().count().max(1);
    let start = offset.saturating_sub(SEARCH_TEXT_EXCERPT_RADIUS);
    let end = (offset + keyword_len + SEARCH_TEXT_EXCERPT_RADIUS).min(chars.len());
    let mut excerpt = String::new();

    if start > 0 {
        excerpt.push('…');
    }
    excerpt.extend(chars[start..end].iter());
    if end < chars.len() {
        excerpt.push('…');
    }

    excerpt
}
