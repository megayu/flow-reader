use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufReader, BufWriter, Read, Seek, Write},
    path::{Path, PathBuf},
};

use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use super::*;

const EPUB_SECTION_SPLIT_MIN_BYTES: u64 = 512 * 1024;
const EPUB_SECTION_SPLIT_MIN_NAV_POINTS: usize = 2;
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct EpubAccessInfo {
    pub(super) mode: BookContentMode,
    pub(super) flags: Vec<BookContentFlag>,
}

struct ParsedEpubInfo {
    metadata: Value,
    cover: Option<CoverInput>,
}

pub(super) fn inspect_epub_access(path: &Path) -> Result<EpubAccessInfo, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
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

fn non_portable_zip_path(path: &str) -> bool {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .any(non_portable_path_segment)
}

fn non_portable_path_segment(segment: &str) -> bool {
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

#[derive(Debug, Clone)]
struct OpfManifestItem {
    id: String,
    href: String,
    media_type: String,
}

#[derive(Debug, Clone)]
struct OpfSpineItem {
    idref: String,
}

#[derive(Debug, Clone)]
struct NcxReference {
    raw_src: String,
    path: String,
    fragment: String,
}

#[derive(Debug, Clone)]
struct SplitSection {
    original_id: String,
    original_abs_path: String,
    original_file_path: PathBuf,
    replacements: Vec<(String, String)>,
    link_targets: Vec<(String, String)>,
    split_items: Vec<SplitItem>,
}

#[derive(Debug, Clone)]
struct SplitItem {
    id: String,
    href: String,
    abs_path: String,
    content: String,
}

#[derive(Debug, Clone)]
struct OpenElement {
    name: String,
    open_tag: String,
    start: usize,
}

#[derive(Debug, Clone)]
struct AnchorSplitPoint {
    anchor_position: usize,
    split_start_position: usize,
    open_ancestors: Vec<OpenElement>,
}

pub(super) fn normalize_unpacked_epub_structure(unpacked_dir: &Path) -> Result<(), String> {
    let opf_path = find_unpacked_opf_path(unpacked_dir)?;
    let opf_xml = fs::read_to_string(&opf_path).map_err(|_| "skip".to_string());
    let Ok(opf_xml) = opf_xml else {
        return Ok(());
    };
    let opf_doc = match roxmltree::Document::parse(&opf_xml) {
        Ok(doc) => doc,
        Err(_) => return Ok(()),
    };
    if opf_declares_fixed_layout(&opf_doc) {
        return Ok(());
    }

    let opf_zip_path = opf_path
        .strip_prefix(unpacked_dir)
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let opf_parent = parent_zip_path(&opf_zip_path).to_string();
    let manifest = opf_manifest_items(&opf_doc);
    let spine = opf_spine_items(&opf_doc);
    let manifest_by_id = manifest
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect::<HashMap<_, _>>();

    let Some(ncx_item) = find_ncx_manifest_item(&opf_doc, &manifest) else {
        return Ok(());
    };
    let ncx_abs_path = normalize_zip_path(join_zip_path(&opf_parent, &ncx_item.href));
    let ncx_file_path = unpacked_resource_path(unpacked_dir, &ncx_abs_path);
    let Ok(ncx_xml) = fs::read_to_string(&ncx_file_path) else {
        return Ok(());
    };
    let ncx_parent = parent_zip_path(&ncx_abs_path).to_string();
    let ncx_references = ncx_content_references(&ncx_xml);
    if ncx_references.len() < EPUB_SECTION_SPLIT_MIN_NAV_POINTS {
        return Ok(());
    }

    let used_ids = manifest
        .iter()
        .map(|item| item.id.clone())
        .collect::<HashSet<_>>();
    let mut split_sections = Vec::new();

    for spine_item in spine {
        let Some(item) = manifest_by_id.get(spine_item.idref.as_str()) else {
            continue;
        };
        if !is_html_manifest_item(item) {
            continue;
        }

        let section_abs_path = normalize_zip_path(join_zip_path(&opf_parent, &item.href));
        let section_refs = ncx_references
            .iter()
            .filter(|reference| {
                let reference_abs = normalize_zip_path(join_zip_path(&ncx_parent, &reference.path));
                percent_decode_zip_path(&reference_abs)
                    == percent_decode_zip_path(&section_abs_path)
            })
            .cloned()
            .collect::<Vec<_>>();
        if section_refs.len() < EPUB_SECTION_SPLIT_MIN_NAV_POINTS {
            continue;
        }

        let section_path = unpacked_resource_path(unpacked_dir, &section_abs_path);
        let Ok(metadata) = fs::metadata(&section_path) else {
            continue;
        };
        if metadata.len() < EPUB_SECTION_SPLIT_MIN_BYTES {
            continue;
        }
        let Ok(xhtml) = fs::read_to_string(&section_path) else {
            continue;
        };
        if !xhtml_is_safe_to_split(&xhtml) {
            continue;
        }

        if let Some(split) = plan_split_section(
            &xhtml,
            item,
            &section_abs_path,
            &section_path,
            &section_refs,
            &ncx_parent,
            &opf_parent,
            &used_ids,
        ) {
            split_sections.push(split);
        }
    }

    if split_sections.is_empty() {
        return Ok(());
    }

    let mut updated_opf = opf_xml;
    for split in &split_sections {
        updated_opf = replace_manifest_item(&updated_opf, split)?;
        updated_opf = replace_spine_itemref(&updated_opf, split)?;
    }
    updated_opf = rewrite_current_package_link_values(&updated_opf, &opf_parent, &split_sections);

    let replacements = split_sections
        .iter()
        .flat_map(|split| split.replacements.iter().cloned())
        .collect::<Vec<_>>();
    let updated_ncx = replace_quoted_values(&ncx_xml, &replacements);
    rewrite_current_package_html_links(unpacked_dir, &split_sections)?;

    fs::write(&opf_path, updated_opf).map_err(|error| error.to_string())?;
    fs::write(&ncx_file_path, updated_ncx).map_err(|error| error.to_string())?;

    for split in &split_sections {
        for item in &split.split_items {
            let path = unpacked_resource_path(unpacked_dir, &item.abs_path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(path, item.content.as_bytes()).map_err(|error| error.to_string())?;
        }
        if split.original_file_path.exists() {
            fs::remove_file(&split.original_file_path).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn opf_declares_fixed_layout(doc: &roxmltree::Document) -> bool {
    doc.descendants().any(|node| {
        node.is_element()
            && node.has_tag_name("meta")
            && node.attribute("property") == Some("rendition:layout")
            && node.text().is_some_and(|text| {
                text.split_whitespace()
                    .any(|value| value.eq_ignore_ascii_case("pre-paginated"))
            })
    })
}

fn opf_manifest_items(doc: &roxmltree::Document) -> Vec<OpfManifestItem> {
    doc.descendants()
        .filter(|node| node.is_element() && node.has_tag_name("item"))
        .filter_map(|node| {
            Some(OpfManifestItem {
                id: node.attribute("id")?.to_string(),
                href: node.attribute("href")?.to_string(),
                media_type: node.attribute("media-type").unwrap_or("").to_string(),
            })
        })
        .collect()
}

fn opf_spine_items(doc: &roxmltree::Document) -> Vec<OpfSpineItem> {
    doc.descendants()
        .filter(|node| node.is_element() && node.has_tag_name("itemref"))
        .filter_map(|node| {
            Some(OpfSpineItem {
                idref: node.attribute("idref")?.to_string(),
            })
        })
        .collect()
}

fn find_ncx_manifest_item(
    doc: &roxmltree::Document,
    manifest: &[OpfManifestItem],
) -> Option<OpfManifestItem> {
    let spine_toc = doc
        .descendants()
        .find(|node| node.is_element() && node.has_tag_name("spine"))
        .and_then(|node| node.attribute("toc"));

    spine_toc
        .and_then(|toc| manifest.iter().find(|item| item.id == toc))
        .cloned()
        .or_else(|| {
            manifest
                .iter()
                .find(|item| item.media_type == "application/x-dtbncx+xml")
                .cloned()
        })
}

fn is_html_manifest_item(item: &OpfManifestItem) -> bool {
    item.media_type == "application/xhtml+xml"
        || item.media_type == "text/html"
        || matches!(
            extension_from_path(&item.href).as_str(),
            "html" | "htm" | "xhtml"
        )
}

fn ncx_content_references(ncx: &str) -> Vec<NcxReference> {
    let Ok(regex) = Regex::new(r#"(?is)<content\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"][^>]*/?>"#)
    else {
        return Vec::new();
    };

    regex
        .captures_iter(ncx)
        .filter_map(|captures| {
            let raw_src = captures.get(1)?.as_str().to_string();
            let (path, fragment) = split_href_fragment(&raw_src);
            if path.is_empty() || fragment.is_empty() {
                return None;
            }

            Some(NcxReference {
                raw_src,
                path,
                fragment,
            })
        })
        .collect()
}

fn split_href_fragment(href: &str) -> (String, String) {
    href.split_once('#')
        .map(|(path, fragment)| (path.to_string(), fragment.to_string()))
        .unwrap_or_else(|| (href.to_string(), String::new()))
}

fn unpacked_resource_path(unpacked_dir: &Path, zip_path: &str) -> PathBuf {
    unpacked_dir.join(zip_path.replace('/', std::path::MAIN_SEPARATOR_STR))
}

fn xhtml_is_safe_to_split(xhtml: &str) -> bool {
    let lower = xhtml.to_ascii_lowercase();
    let unsafe_tokens = [
        "<base",
        "<script",
        "<form",
        "<input",
        "<textarea",
        "<select",
        "<iframe",
        "<object",
        "<embed",
        "<canvas",
        "<svg",
        "<math",
    ];
    if unsafe_tokens.iter().any(|token| lower.contains(token)) {
        return false;
    }

    true
}

fn local_body_content_range(xhtml: &str) -> Option<(usize, usize)> {
    let lower = xhtml.to_ascii_lowercase();
    let body_tag_start = lower.find("<body")?;
    let body_content_start = lower[body_tag_start..].find('>')? + body_tag_start + 1;
    let body_content_end = lower[body_content_start..]
        .find("</body")
        .map(|index| body_content_start + index)
        .unwrap_or(xhtml.len());

    Some((body_content_start, body_content_end))
}

fn plan_split_section(
    xhtml: &str,
    item: &OpfManifestItem,
    section_abs_path: &str,
    section_path: &Path,
    section_refs: &[NcxReference],
    ncx_parent: &str,
    opf_parent: &str,
    used_ids: &HashSet<String>,
) -> Option<SplitSection> {
    let (body_start, body_end) = local_body_content_range(xhtml)?;
    let anchor_split_points = collect_anchor_split_points(xhtml, body_start, body_end)?;
    let mut anchor_positions = Vec::new();

    for reference in section_refs {
        let fragment = percent_decode_path(&reference.fragment);
        let split_point = anchor_split_points.get(&fragment)?.clone();
        anchor_positions.push((reference, split_point));
    }

    anchor_positions.sort_by_key(|(_, split_point)| split_point.split_start_position);
    anchor_positions.dedup_by_key(|(_, split_point)| split_point.split_start_position);
    if anchor_positions.len() < EPUB_SECTION_SPLIT_MIN_NAV_POINTS {
        return None;
    }

    let prefix = &xhtml[..body_start];
    let suffix = &xhtml[body_end..];
    let mut split_starts = Vec::with_capacity(anchor_positions.len());
    split_starts.push(AnchorSplitPoint {
        anchor_position: body_start,
        split_start_position: body_start,
        open_ancestors: Vec::new(),
    });
    split_starts.extend(
        anchor_positions
            .iter()
            .skip(1)
            .map(|(_, split_point)| (*split_point).clone()),
    );
    let stem = item
        .href
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(item.href.as_str());
    let extension = extension_from_path(&item.href);
    let extension = if extension.is_empty() {
        "xhtml".to_string()
    } else {
        extension
    };

    let mut split_items = Vec::new();
    for (index, start) in split_starts.iter().enumerate() {
        let end = split_starts
            .get(index + 1)
            .map(|split_start| split_start.split_start_position)
            .unwrap_or(body_end);
        if start.split_start_position >= end {
            return None;
        }

        let href = format!(
            "{stem}-flow-split-{index:04}.{extension}",
            index = index + 1
        );
        let id = unique_split_id(&item.id, index + 1, used_ids);
        let abs_path = normalize_zip_path(join_zip_path(opf_parent, &href));
        let close_ancestors = split_starts
            .get(index + 1)
            .map(|split_start| split_start.open_ancestors.as_slice())
            .unwrap_or(&[]);
        let synthetic_open_len = start
            .open_ancestors
            .iter()
            .map(|ancestor| ancestor.open_tag.len())
            .sum::<usize>();
        let synthetic_close_len = close_ancestors
            .iter()
            .map(|ancestor| ancestor.name.len() + 3)
            .sum::<usize>();
        let mut content = String::with_capacity(
            prefix.len()
                + synthetic_open_len
                + (end - start.split_start_position)
                + synthetic_close_len
                + suffix.len(),
        );
        content.push_str(prefix);
        for ancestor in &start.open_ancestors {
            content.push_str(&ancestor.open_tag);
        }
        content.push_str(&xhtml[start.split_start_position..end]);
        for ancestor in close_ancestors.iter().rev() {
            content.push_str("</");
            content.push_str(&ancestor.name);
            content.push('>');
        }
        content.push_str(suffix);

        split_items.push(SplitItem {
            id,
            href,
            abs_path,
            content,
        });
    }

    let mut replacements = Vec::new();
    for reference in section_refs {
        let fragment = percent_decode_path(&reference.fragment);
        let position = anchor_split_points.get(&fragment)?.anchor_position;
        let split_index =
            split_starts.partition_point(|start| start.split_start_position <= position) - 1;
        let split = split_items.get(split_index)?;
        let relative = relative_zip_path(ncx_parent, &split.abs_path);
        replacements.push((
            reference.raw_src.clone(),
            format!("{relative}#{}", reference.fragment),
        ));
    }

    let mut all_link_targets = Vec::new();
    for (fragment, split_point) in &anchor_split_points {
        let split_index = split_starts
            .partition_point(|start| start.split_start_position <= split_point.anchor_position)
            - 1;
        let split = split_items.get(split_index)?;
        all_link_targets.push((fragment.clone(), split.abs_path.clone()));
    }

    rewrite_split_item_links(&mut split_items, section_abs_path, &all_link_targets);
    if split_items
        .iter()
        .any(|item| parse_split_xhtml(&item.content).is_err())
    {
        return None;
    }

    Some(SplitSection {
        original_id: item.id.clone(),
        original_abs_path: section_abs_path.to_string(),
        original_file_path: section_path.to_path_buf(),
        replacements,
        link_targets: all_link_targets,
        split_items,
    })
}

fn parse_split_xhtml(xhtml: &str) -> Result<roxmltree::Document<'_>, roxmltree::Error> {
    roxmltree::Document::parse_with_options(
        xhtml,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            ..roxmltree::ParsingOptions::default()
        },
    )
}

fn rewrite_split_item_links(
    split_items: &mut [SplitItem],
    section_abs_path: &str,
    link_targets: &[(String, String)],
) {
    let section_file_name = section_abs_path
        .rsplit_once('/')
        .map(|(_, name)| name)
        .unwrap_or(section_abs_path);

    for item in split_items {
        let item_parent = parent_zip_path(&item.abs_path);
        let original_relative = relative_zip_path(item_parent, section_abs_path);
        let mut replacements = HashMap::new();

        for (fragment, target_abs_path) in link_targets {
            let target = format!(
                "{}#{}",
                relative_zip_path(item_parent, target_abs_path),
                fragment
            );
            replacements.insert(format!("{original_relative}#{fragment}"), target.clone());
            replacements.insert(format!("{section_file_name}#{fragment}"), target.clone());
            replacements.insert(format!("./{section_file_name}#{fragment}"), target.clone());

            if target_abs_path != &item.abs_path {
                replacements.insert(format!("#{fragment}"), target);
            }
        }

        item.content = replace_quoted_values_by_lookup(&item.content, &replacements);
    }
}

fn collect_anchor_split_points(
    xhtml: &str,
    body_start: usize,
    body_end: usize,
) -> Option<HashMap<String, AnchorSplitPoint>> {
    let tag_regex = Regex::new(r#"(?is)<[^>]+>"#).ok()?;
    let anchor_regex =
        Regex::new(r#"(?is)(?:\bid\s*=\s*["']([^"']+)["']|\bname\s*=\s*["']([^"']+)["'])"#).ok()?;
    let mut anchors = HashMap::new();
    let mut stack: Vec<OpenElement> = Vec::new();

    for tag_match in tag_regex.find_iter(&xhtml[body_start..body_end]) {
        let tag = tag_match.as_str();
        let tag_start = body_start + tag_match.start();
        let trimmed = tag.trim_start();
        if is_ignored_split_tag(trimmed) {
            continue;
        }

        if trimmed.starts_with("</") {
            if let Some(name) = xml_tag_name(trimmed) {
                let name = name.to_ascii_lowercase();
                if let Some(index) = stack
                    .iter()
                    .rposition(|element| element.name.eq_ignore_ascii_case(&name))
                {
                    stack.truncate(index);
                }
            }
            continue;
        }

        let Some(name) = xml_tag_name(trimmed) else {
            continue;
        };
        let name = name.to_ascii_lowercase();
        let current = OpenElement {
            name: name.clone(),
            open_tag: tag.to_string(),
            start: tag_start,
        };

        if let Some(captures) = anchor_regex.captures(tag) {
            if let Some(anchor) = captures.get(1).or_else(|| captures.get(2)) {
                let (split_start_position, open_ancestors) =
                    split_boundary_for_anchor(&stack, &current);
                anchors
                    .entry(anchor.as_str().to_string())
                    .or_insert(AnchorSplitPoint {
                        anchor_position: tag_start,
                        split_start_position,
                        open_ancestors,
                    });
            }
        }

        if !is_self_closing_split_tag(trimmed, &name) {
            stack.push(current);
        }
    }

    Some(anchors)
}

fn split_boundary_for_anchor(
    stack: &[OpenElement],
    current: &OpenElement,
) -> (usize, Vec<OpenElement>) {
    if let Some(parent_index) = stack.iter().rposition(|element| {
        is_split_container_tag(&element.name) && is_split_text_block_tag(&current.name)
    }) {
        return (stack[parent_index].start, stack[..parent_index].to_vec());
    }

    if is_split_block_tag(&current.name) {
        return (current.start, stack.to_vec());
    }

    if let Some(parent_index) = stack
        .iter()
        .rposition(|element| is_split_block_tag(&element.name))
    {
        return (stack[parent_index].start, stack[..parent_index].to_vec());
    }

    (current.start, stack.to_vec())
}

fn is_ignored_split_tag(tag: &str) -> bool {
    tag.starts_with("<!--")
        || tag.starts_with("<!")
        || tag.starts_with("<?")
        || tag.starts_with("</!")
        || tag.starts_with("</?")
}

fn xml_tag_name(tag: &str) -> Option<String> {
    let tag = tag.trim_start_matches('<').trim_start_matches('/');
    let name = tag
        .chars()
        .take_while(|character| {
            character.is_ascii_alphanumeric() || matches!(*character, '_' | '-' | ':' | '.')
        })
        .collect::<String>();
    (!name.is_empty()).then_some(name)
}

fn is_self_closing_split_tag(tag: &str, name: &str) -> bool {
    tag.trim_end().ends_with("/>")
        || matches!(
            name,
            "area"
                | "base"
                | "br"
                | "col"
                | "embed"
                | "hr"
                | "img"
                | "input"
                | "link"
                | "meta"
                | "param"
                | "source"
                | "track"
                | "wbr"
        )
}

fn is_split_text_block_tag(name: &str) -> bool {
    matches!(
        name,
        "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "dt" | "dd" | "figcaption"
    )
}

fn is_split_container_tag(name: &str) -> bool {
    matches!(
        name,
        "div"
            | "section"
            | "article"
            | "main"
            | "nav"
            | "aside"
            | "blockquote"
            | "figure"
            | "li"
            | "td"
            | "th"
    )
}

fn is_split_block_tag(name: &str) -> bool {
    is_split_text_block_tag(name)
        || is_split_container_tag(name)
        || matches!(name, "table" | "ul" | "ol" | "dl" | "pre")
}

#[cfg(test)]
fn collect_anchor_starts(
    xhtml: &str,
    body_start: usize,
    body_end: usize,
) -> Option<HashMap<String, usize>> {
    let regex = Regex::new(
        r#"(?is)<[^>]+(?:\bid\s*=\s*["']([^"']+)["']|\bname\s*=\s*["']([^"']+)["'])[^>]*>"#,
    )
    .ok()?;
    let mut anchors = HashMap::new();

    for captures in regex.captures_iter(&xhtml[body_start..body_end]) {
        let Some(match_) = captures.get(0) else {
            continue;
        };
        let Some(anchor) = captures.get(1).or_else(|| captures.get(2)) else {
            continue;
        };
        anchors
            .entry(anchor.as_str().to_string())
            .or_insert(body_start + match_.start());
    }

    Some(anchors)
}

fn unique_split_id(original_id: &str, index: usize, used_ids: &HashSet<String>) -> String {
    let base = original_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let mut id = format!("{base}_flow_split_{index:04}");
    let mut suffix = 1usize;
    while used_ids.contains(&id) {
        id = format!("{base}_flow_split_{index:04}_{suffix}");
        suffix += 1;
    }
    id
}

fn relative_zip_path(from_parent: &str, target: &str) -> String {
    let from = from_parent
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let target_parts = target
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let mut common = 0usize;
    while common < from.len() && common < target_parts.len() && from[common] == target_parts[common]
    {
        common += 1;
    }

    let mut relative = Vec::new();
    relative.extend(std::iter::repeat("..").take(from.len() - common));
    relative.extend(target_parts.iter().skip(common).copied());
    relative.join("/")
}

fn replace_manifest_item(opf: &str, split: &SplitSection) -> Result<String, String> {
    let Some((start, end)) = find_xml_start_tag_range(opf, "item", "id", &split.original_id) else {
        return Ok(opf.to_string());
    };
    let indent = line_indent_before(opf, start);
    let replacement = split
        .split_items
        .iter()
        .map(|item| {
            format!(
                r#"{indent}<item id="{}" href="{}" media-type="application/xhtml+xml"/>"#,
                escape_xml_attr_local(&item.id),
                escape_xml_attr_local(&item.href)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut updated = String::with_capacity(opf.len() + replacement.len());
    updated.push_str(&opf[..start]);
    updated.push_str(&replacement);
    updated.push_str(&opf[end..]);
    Ok(updated)
}

fn replace_spine_itemref(opf: &str, split: &SplitSection) -> Result<String, String> {
    let Some((start, end)) = find_xml_start_tag_range(opf, "itemref", "idref", &split.original_id)
    else {
        return Ok(opf.to_string());
    };
    let indent = line_indent_before(opf, start);
    let replacement = split
        .split_items
        .iter()
        .map(|item| {
            format!(
                r#"{indent}<itemref idref="{}"/>"#,
                escape_xml_attr_local(&item.id)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut updated = String::with_capacity(opf.len() + replacement.len());
    updated.push_str(&opf[..start]);
    updated.push_str(&replacement);
    updated.push_str(&opf[end..]);
    Ok(updated)
}

fn find_xml_start_tag_range(
    xml: &str,
    tag: &str,
    attr_name: &str,
    attr_value: &str,
) -> Option<(usize, usize)> {
    let lower = xml.to_ascii_lowercase();
    let needle = format!("<{}", tag.to_ascii_lowercase());
    let mut cursor = 0usize;
    while let Some(relative_start) = lower[cursor..].find(&needle) {
        let start = cursor + relative_start;
        let after_tag = start + needle.len();
        let next = lower[after_tag..].chars().next();
        if next.is_some_and(|character| {
            !(character.is_whitespace() || character == '>' || character == '/')
        }) {
            cursor = after_tag;
            continue;
        }

        let end = lower[start..].find('>')? + start + 1;
        let tag_xml = &xml[start..end];
        if xml_tag_has_attr_value(tag_xml, attr_name, attr_value) {
            return Some((start, end));
        }
        cursor = end;
    }

    None
}

fn xml_tag_has_attr_value(tag: &str, attr_name: &str, attr_value: &str) -> bool {
    let pattern = format!(
        r#"(?is)\b{}\s*=\s*['"]{}['"]"#,
        regex::escape(attr_name),
        regex::escape(attr_value)
    );
    Regex::new(&pattern)
        .ok()
        .is_some_and(|regex| regex.is_match(tag))
}

fn line_indent_before(text: &str, index: usize) -> &str {
    let line_start = text[..index]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let indent = &text[line_start..index];
    if indent
        .chars()
        .all(|character| character.is_ascii_whitespace())
    {
        indent
    } else {
        ""
    }
}

fn escape_xml_attr_local(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn replace_quoted_values(text: &str, replacements: &[(String, String)]) -> String {
    replacements
        .iter()
        .fold(text.to_string(), |current, (from, to)| {
            current
                .replace(&format!(r#""{from}""#), &format!(r#""{to}""#))
                .replace(&format!("'{from}'"), &format!("'{to}'"))
        })
}

fn replace_quoted_values_by_lookup(text: &str, replacements: &HashMap<String, String>) -> String {
    if replacements.is_empty() {
        return text.to_string();
    }

    let bytes = text.as_bytes();
    let mut cursor = 0usize;
    let mut last_written = 0usize;
    let mut updated = String::new();

    while cursor < bytes.len() {
        let quote = bytes[cursor];
        if quote != b'"' && quote != b'\'' {
            cursor += 1;
            continue;
        }

        let value_start = cursor + 1;
        let mut value_end = value_start;
        while value_end < bytes.len() && bytes[value_end] != quote {
            value_end += 1;
        }
        if value_end >= bytes.len() {
            break;
        }

        let value = &text[value_start..value_end];
        if let Some(replacement) = replacements.get(value) {
            updated.push_str(&text[last_written..value_start]);
            updated.push_str(replacement);
            last_written = value_end;
        }

        cursor = value_end + 1;
    }

    if updated.is_empty() {
        return text.to_string();
    }

    updated.push_str(&text[last_written..]);
    updated
}

fn rewrite_current_package_html_links(
    unpacked_dir: &Path,
    split_sections: &[SplitSection],
) -> Result<(), String> {
    let removed_paths = split_sections
        .iter()
        .map(|split| split.original_abs_path.clone())
        .collect::<HashSet<_>>();

    for path in collect_unpacked_html_files(unpacked_dir)? {
        let relative = path
            .strip_prefix(unpacked_dir)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if removed_paths.contains(&relative) {
            continue;
        }

        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let parent = parent_zip_path(&relative);
        let updated = rewrite_current_package_link_values(&text, parent, split_sections);
        if updated != text {
            fs::write(path, updated).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn rewrite_current_package_link_values(
    text: &str,
    current_parent: &str,
    split_sections: &[SplitSection],
) -> String {
    let mut replacements = HashMap::new();

    for split in split_sections {
        let original_relative = relative_zip_path(current_parent, &split.original_abs_path);
        let section_file_name = split
            .original_abs_path
            .rsplit_once('/')
            .map(|(_, name)| name)
            .unwrap_or(split.original_abs_path.as_str());

        if let Some(first_split) = split.split_items.first() {
            let target = relative_zip_path(current_parent, &first_split.abs_path);
            replacements.insert(original_relative.clone(), target.clone());
            replacements.insert(section_file_name.to_string(), target.clone());
            replacements.insert(format!("./{section_file_name}"), target);
        }

        for (fragment, target_abs_path) in &split.link_targets {
            let target = format!(
                "{}#{}",
                relative_zip_path(current_parent, target_abs_path),
                fragment
            );
            replacements.insert(format!("{original_relative}#{fragment}"), target.clone());
            replacements.insert(format!("{section_file_name}#{fragment}"), target.clone());
            replacements.insert(format!("./{section_file_name}#{fragment}"), target);
        }
    }

    replace_quoted_values_by_lookup(text, &replacements)
}

fn collect_unpacked_html_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_unpacked_html_files_into(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_unpacked_html_files_into(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_unpacked_html_files_into(&path, files)?;
            continue;
        }

        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase());
        if matches!(extension.as_deref(), Some("html" | "htm" | "xhtml")) {
            files.push(path);
        }
    }

    Ok(())
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
            read_zip_bytes_with_path_candidates(&mut archive, &cover_path)
                .ok()
                .map(|data| {
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

fn read_zip_bytes_with_path_candidates<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<Vec<u8>, String> {
    let mut last_error = "EPUB entry not found".to_string();

    for candidate in zip_path_candidates(name) {
        match read_zip_bytes(archive, &candidate) {
            Ok(data) => return Ok(data),
            Err(error) => {
                last_error = error;
            }
        }
    }

    Err(last_error)
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
                && (node
                    .attribute("href")
                    .is_some_and(|href| href.to_ascii_lowercase().contains("cover"))
                    || node.attribute("id").is_some_and(cover_id_starts_with_cover))
        })
        .and_then(cover_item_to_path)
}

fn cover_id_starts_with_cover(id: &str) -> bool {
    id.to_ascii_lowercase().split('.').next() == Some("cover")
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
    let access = inspect_epub_access(path)?;
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
                    book.content_mode = access.mode;
                    book.content_flags = access.flags.clone();
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
                book.content_mode = access.mode;
                book.content_flags = access.flags.clone();
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
                    content_mode: access.mode,
                    content_flags: access.flags.clone(),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn split_test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "flow-reader-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        if root.exists() {
            fs::remove_dir_all(&root).unwrap();
        }
        fs::create_dir_all(root.join("OEBPS/Text")).unwrap();
        root
    }

    fn write_split_fixture(root: &Path, nav_point_count: usize) {
        fs::write(
            root.join("OEBPS/content.opf"),
            r#"<package>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="part" href="Text/part0000.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="part"/>
  </spine>
</package>"#,
        )
        .unwrap();

        let mut ncx = String::from("<ncx><navMap>");
        for index in 0..nav_point_count {
            ncx.push_str(&format!(
                r#"<navPoint id="nav{index}"><content src="Text/part0000.xhtml#nav_point_{index}"/></navPoint>"#
            ));
        }
        ncx.push_str("</navMap></ncx>");
        fs::write(root.join("OEBPS/toc.ncx"), ncx).unwrap();

        let mut xhtml = String::from(
            r##"<?xml version="1.0" encoding="utf-8"?><html><head><title>Split</title></head><body>
<p><a href="part0000.xhtml#nav_point_7">file target</a><a href="#nav_point_7">local target</a><a href="./part0000.xhtml#nav_point_1">dot target</a><a href="Text/part0000.xhtml#nav_point_2">raw target</a></p>
<table><tr><td>table should not block splitting</td></tr></table>
"##,
        );
        let filler = "x".repeat(70_000);
        for index in 0..nav_point_count {
            xhtml.push_str(&format!(
                r#"<h1 id="nav_point_{index}">Section {index}</h1><p>{filler}</p>"#
            ));
        }
        xhtml.push_str("</body></html>");
        fs::write(root.join("OEBPS/Text/part0000.xhtml"), xhtml).unwrap();
    }

    #[test]
    fn normalize_splits_table_sections_and_rewrites_internal_links() {
        let root = split_test_root("split-table-links");
        write_split_fixture(&root, 8);

        normalize_unpacked_epub_structure(&root).unwrap();

        assert!(!root.join("OEBPS/Text/part0000.xhtml").exists());
        assert!(root
            .join("OEBPS/Text/part0000-flow-split-0008.xhtml")
            .exists());

        let first_split =
            fs::read_to_string(root.join("OEBPS/Text/part0000-flow-split-0001.xhtml")).unwrap();
        assert!(first_split.contains("<table>"));
        assert!(!first_split.contains(r#"href="part0000.xhtml#nav_point_7""#));
        assert!(!first_split.contains(r##"href="#nav_point_7""##));
        assert!(!first_split.contains(r#"href="./part0000.xhtml#nav_point_1""#));
        assert!(!first_split.contains(r#"href="Text/part0000.xhtml#nav_point_2""#));
        assert!(first_split.contains(r#"href="part0000-flow-split-0008.xhtml#nav_point_7""#));
        assert!(first_split.contains(r#"href="part0000-flow-split-0002.xhtml#nav_point_1""#));
        assert!(first_split.contains(r#"href="part0000-flow-split-0003.xhtml#nav_point_2""#));

        let ncx = fs::read_to_string(root.join("OEBPS/toc.ncx")).unwrap();
        assert!(ncx.contains("Text/part0000-flow-split-0008.xhtml#nav_point_7"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_splits_two_anchor_oversized_section() {
        let root = split_test_root("split-two-anchors");
        write_split_fixture(&root, 2);

        normalize_unpacked_epub_structure(&root).unwrap();

        assert!(!root.join("OEBPS/Text/part0000.xhtml").exists());
        assert!(root
            .join("OEBPS/Text/part0000-flow-split-0002.xhtml")
            .exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_splits_xhtml_doctype_section() {
        let root = split_test_root("split-xhtml-doctype");
        write_split_fixture(&root, 2);
        let xhtml_path = root.join("OEBPS/Text/part0000.xhtml");
        let xhtml = fs::read_to_string(&xhtml_path).unwrap();
        fs::write(
            &xhtml_path,
            xhtml.replacen(
                r#"<?xml version="1.0" encoding="utf-8"?>"#,
                r#"<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">"#,
                1,
            ),
        )
        .unwrap();

        normalize_unpacked_epub_structure(&root).unwrap();

        assert!(!root.join("OEBPS/Text/part0000.xhtml").exists());
        assert!(root
            .join("OEBPS/Text/part0000-flow-split-0002.xhtml")
            .exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_splits_rewrites_existing_nav_and_guide_links() {
        let root = split_test_root("split-nav-links");
        write_split_fixture(&root, 3);
        fs::write(
            root.join("OEBPS/content.opf"),
            r#"<package>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="nav" href="Text/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="part" href="Text/part0000.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="part"/>
  </spine>
  <guide>
    <reference type="toc" href="Text/part0000.xhtml#book_toc"/>
  </guide>
</package>"#,
        )
        .unwrap();
        fs::write(
            root.join("OEBPS/Text/nav.xhtml"),
            r#"<?xml version="1.0" encoding="utf-8"?><html><body>
<nav><ol>
  <li><a href="part0000.xhtml#book_toc">Contents</a></li>
  <li><a href="part0000.xhtml#nav_point_0">One</a></li>
  <li><a href="part0000.xhtml#nav_point_1">Two</a></li>
  <li><a href="part0000.xhtml#nav_point_2">Three</a></li>
</ol></nav>
</body></html>"#,
        )
        .unwrap();

        let xhtml_path = root.join("OEBPS/Text/part0000.xhtml");
        let xhtml = fs::read_to_string(&xhtml_path).unwrap();
        fs::write(
            &xhtml_path,
            xhtml.replacen("<body>", r#"<body><div id="book_toc">Contents</div>"#, 1),
        )
        .unwrap();

        normalize_unpacked_epub_structure(&root).unwrap();

        let nav = fs::read_to_string(root.join("OEBPS/Text/nav.xhtml")).unwrap();
        assert!(!nav.contains("part0000.xhtml#"));
        assert!(nav.contains("part0000-flow-split-0001.xhtml#book_toc"));
        assert!(nav.contains("part0000-flow-split-0001.xhtml#nav_point_0"));
        assert!(nav.contains("part0000-flow-split-0002.xhtml#nav_point_1"));
        assert!(nav.contains("part0000-flow-split-0003.xhtml#nav_point_2"));

        let opf = fs::read_to_string(root.join("OEBPS/content.opf")).unwrap();
        assert!(opf.contains(r#"href="Text/part0000-flow-split-0001.xhtml#book_toc""#));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_splits_from_block_boundaries_when_anchor_is_wrapped() {
        let root = split_test_root("split-block-boundary");
        fs::write(
            root.join("OEBPS/content.opf"),
            r#"<package>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="part" href="Text/part0000.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="part"/>
  </spine>
</package>"#,
        )
        .unwrap();

        let mut ncx = String::from("<ncx><navMap>");
        for index in 0..8 {
            ncx.push_str(&format!(
                r#"<navPoint id="nav{index}"><content src="Text/part0000.xhtml#nav_point_{index}"/></navPoint>"#
            ));
        }
        ncx.push_str("</navMap></ncx>");
        fs::write(root.join("OEBPS/toc.ncx"), ncx).unwrap();

        let filler = "x".repeat(70_000);
        let mut xhtml =
            String::from(r#"<?xml version="1.0" encoding="utf-8"?><html><body><div id="book">"#);
        for index in 0..8 {
            xhtml.push_str(&format!(
                r#"<div class="text"><p id="nav_point_{index}">Section {index}</p><p>{filler}</p></div>"#
            ));
        }
        xhtml.push_str("</div></body></html>");
        fs::write(root.join("OEBPS/Text/part0000.xhtml"), xhtml).unwrap();

        normalize_unpacked_epub_structure(&root).unwrap();

        assert!(!root.join("OEBPS/Text/part0000.xhtml").exists());
        for index in 1..=8 {
            let split_path = root.join(format!("OEBPS/Text/part0000-flow-split-{index:04}.xhtml"));
            let split = fs::read_to_string(split_path).unwrap();
            roxmltree::Document::parse(&split).expect("split XHTML should be well formed");
            assert!(
                !split.contains("</body></html></div>"),
                "split should not contain trailing orphan closing tags"
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_skips_split_when_generated_xhtml_has_undeclared_namespace_prefix() {
        let root = split_test_root("split-undeclared-prefix");
        fs::write(
            root.join("OEBPS/content.opf"),
            r#"<package>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="part" href="Text/part0000.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="part"/>
  </spine>
</package>"#,
        )
        .unwrap();
        fs::write(
            root.join("OEBPS/toc.ncx"),
            r#"<ncx><navMap>
  <navPoint id="nav0"><content src="Text/part0000.xhtml#nav_point_0"/></navPoint>
  <navPoint id="nav1"><content src="Text/part0000.xhtml#nav_point_1"/></navPoint>
</navMap></ncx>"#,
        )
        .unwrap();

        let filler = "x".repeat(270_000);
        fs::write(
            root.join("OEBPS/Text/part0000.xhtml"),
            format!(
                r#"<?xml version="1.0" encoding="utf-8"?><html><body><div><mbp:pagebreak/><h1 id="nav_point_0">One</h1><p>{filler}</p><h1 id="nav_point_1">Two</h1><p>{filler}</p></div></body></html>"#
            ),
        )
        .unwrap();

        normalize_unpacked_epub_structure(&root).unwrap();

        assert!(root.join("OEBPS/Text/part0000.xhtml").exists());
        assert!(!root
            .join("OEBPS/Text/part0000-flow-split-0002.xhtml")
            .exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replace_quoted_values_by_lookup_scans_text_once() {
        let replacements = HashMap::from([
            (
                "part0000.xhtml#nav_point_2".to_string(),
                "part0000-flow-split-0003.xhtml#nav_point_2".to_string(),
            ),
            (
                "#nav_point_7".to_string(),
                "part0000-flow-split-0008.xhtml#nav_point_7".to_string(),
            ),
        ]);

        let updated = replace_quoted_values_by_lookup(
            r#"<a href="part0000.xhtml#nav_point_2">two</a><a href='#nav_point_7'>seven</a><span title="keep">x</span>"#,
            &replacements,
        );

        assert_eq!(
            updated,
            r#"<a href="part0000-flow-split-0003.xhtml#nav_point_2">two</a><a href='part0000-flow-split-0008.xhtml#nav_point_7'>seven</a><span title="keep">x</span>"#
        );
    }

    #[test]
    fn collect_anchor_starts_scans_body_once() {
        let xhtml = r#"<html><body><p id="first">One</p><a name='second'></a><span id="first">Later</span></body></html>"#;
        let (body_start, body_end) = local_body_content_range(xhtml).unwrap();
        let anchors = collect_anchor_starts(xhtml, body_start, body_end).unwrap();

        assert_eq!(
            anchors.get("first"),
            Some(&xhtml.find(r#"<p id="first""#).unwrap())
        );
        assert_eq!(
            anchors.get("second"),
            Some(&xhtml.find(r#"<a name='second'"#).unwrap())
        );
    }

    #[test]
    fn find_cover_path_falls_back_to_image_manifest_id_prefix() {
        let doc = roxmltree::Document::parse(
            r#"<package>
  <manifest>
    <item id="cover.jpg" href="Images/obfuscated-image.jpg" media-type="image/jpeg"/>
  </manifest>
</package>"#,
        )
        .unwrap();

        assert_eq!(
            find_cover_path(&doc),
            Some((
                "Images/obfuscated-image.jpg".to_string(),
                "image/jpeg".to_string()
            ))
        );
    }
}
