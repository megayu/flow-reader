use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::{decode_compressed_json, encode_compressed_json, join_zip_path, normalize_zip_path, parent_zip_path};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageIndexCache {
    pub version: u32,
    pub source_revision: u32,
    pub revision: u32,
    pub sections: Vec<ImageIndexSection>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageIndexSection {
    pub index: usize,
    pub href: String,
    pub images: Vec<ImageIndexEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageIndexEntry {
    pub src: String,
    pub index: usize,
    pub hidden_by_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub(super) fn image_index_cache_to_bytes(cache: &ImageIndexCache) -> Result<Vec<u8>, String> {
    encode_compressed_json(cache)
}

pub(super) fn image_index_cache_from_bytes(bytes: &[u8]) -> Result<ImageIndexCache, String> {
    decode_compressed_json(bytes)
}

pub(super) fn image_index_section_from_document(
    index: usize,
    href: String,
    document: &roxmltree::Document<'_>,
) -> ImageIndexSection {
    let images = document
        .descendants()
        .filter(|node| node.is_element() && node.has_tag_name("img"))
        .enumerate()
        .map(|(index, image)| {
            let mut entry = classify_image(image, index);
            entry.src = resolve_image_src(&href, &entry.src);
            entry
        })
        .collect();
    ImageIndexSection { index, href, images }
}

pub(super) fn finalize_image_index(sections: &mut [ImageIndexSection]) {
    let mut first_candidate_by_src = HashMap::<String, (usize, usize)>::new();
    let mut duplicate_srcs = HashSet::<String>::new();
    let mut title_art_candidates_by_src = HashMap::<String, Vec<(usize, usize)>>::new();

    for section_index in 0..sections.len() {
        for image_index in 0..sections[section_index].images.len() {
            let image = &sections[section_index].images[image_index];
            let duplicate_evidence = image.reason.as_deref() == Some("duplicate");
            let title_art_evidence = image.hidden_by_default && image.reason.as_deref() == Some("titleArt");
            if (image.hidden_by_default && !duplicate_evidence) || image.src.is_empty() {
                if title_art_evidence && !image.src.is_empty() {
                    title_art_candidates_by_src
                        .entry(normalize_image_source_key(&image.src))
                        .or_default()
                        .push((section_index, image_index));
                }
                continue;
            }

            let key = normalize_image_source_key(&image.src);
            if key.is_empty() {
                continue;
            }
            if duplicate_srcs.contains(&key) {
                mark_duplicate(&mut sections[section_index].images[image_index]);
                continue;
            }
            if let Some((first_section, first_image)) = first_candidate_by_src.remove(&key) {
                mark_duplicate(&mut sections[first_section].images[first_image]);
                mark_duplicate(&mut sections[section_index].images[image_index]);
                duplicate_srcs.insert(key);
                continue;
            }
            if duplicate_evidence {
                duplicate_srcs.insert(key);
                continue;
            }
            first_candidate_by_src.insert(key, (section_index, image_index));
        }
    }

    for (key, candidates) in title_art_candidates_by_src {
        if candidates.len() != 1 || duplicate_srcs.contains(&key) || first_candidate_by_src.contains_key(&key) {
            continue;
        }
        let (section_index, image_index) = candidates[0];
        let image = &mut sections[section_index].images[image_index];
        if image.hidden_by_default && image.reason.as_deref() == Some("titleArt") {
            image.hidden_by_default = false;
            image.reason = None;
        }
    }
}

fn classify_image(image: roxmltree::Node<'_, '_>, index: usize) -> ImageIndexEntry {
    let src = image
        .attribute("src")
        .filter(|src| !src.trim().is_empty())
        .or_else(|| {
            image
                .attribute("srcset")
                .and_then(|srcset| srcset.split(',').next())
                .and_then(|candidate| candidate.split_whitespace().next())
        })
        .unwrap_or_default()
        .to_string();
    let width =
        numeric_dimension(image.attribute("width")).or_else(|| style_dimension(image.attribute("style"), "width"));
    let height =
        numeric_dimension(image.attribute("height")).or_else(|| style_dimension(image.attribute("style"), "height"));
    let source_text = [
        Some(src.as_str()),
        image.attribute("alt"),
        image.attribute("class"),
        image.attribute("id"),
        image.parent_element().and_then(|parent| parent.attribute("class")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");
    let inline_parent = image.ancestors().any(|node| {
        node.is_element() && matches!(node.tag_name().name(), "p" | "span" | "a" | "em" | "strong" | "b" | "i")
    });
    let likely_inline_by_size = height.is_some_and(|value| value <= 48.0) || width.is_some_and(|value| value <= 48.0);
    let likely_small_icon = height.is_some_and(|value| value <= 72.0) && width.is_some_and(|value| value <= 72.0)
        || likely_inline_by_size && decorative_image_text(&source_text);

    let reason = if has_artifact_ancestor(image) || likely_small_icon {
        Some("icon")
    } else if inline_parent
        && (has_sibling_text(image)
            || likely_inline_by_size
                && image
                    .parent_element()
                    .is_some_and(|parent| has_text_at_least(parent, 8)))
    {
        Some("inlineGlyph")
    } else if has_title_ancestor(image)
        || is_leading_title_image(image)
        || is_near_document_start(image) && decorative_image_text(&source_text)
    {
        Some("titleArt")
    } else {
        None
    };

    ImageIndexEntry {
        src,
        index,
        hidden_by_default: reason.is_some(),
        reason: reason.map(str::to_string),
    }
}

fn has_artifact_ancestor(image: roxmltree::Node<'_, '_>) -> bool {
    image.ancestors().any(|node| {
        if !node.is_element() {
            return false;
        }
        if matches!(
            node.tag_name().name(),
            "sup" | "sub" | "ruby" | "rt" | "rp" | "small" | "aside" | "footer" | "header" | "nav"
        ) {
            return true;
        }
        if node
            .attribute("role")
            .is_some_and(|role| matches!(role, "doc-noteref" | "note"))
        {
            return true;
        }
        if epub_type_has(node, &["noteref", "footnote", "endnote", "annotation"]) {
            return true;
        }
        node.attribute("class").is_some_and(|class_name| {
            let class_name = class_name.to_lowercase();
            ["note", "footnote", "endnote", "annotation"]
                .iter()
                .any(|value| class_name.contains(value))
        })
    })
}

fn has_title_ancestor(image: roxmltree::Node<'_, '_>) -> bool {
    image.ancestors().any(|node| {
        if !node.is_element() {
            return false;
        }
        if matches!(
            node.tag_name().name(),
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "title"
        ) || epub_type_has(node, &["titlepage"])
        {
            return true;
        }
        node.has_tag_name("header")
            && node
                .parent_element()
                .is_some_and(|parent| epub_type_has(parent, &["chapter"]))
    })
}

fn epub_type_has(node: roxmltree::Node<'_, '_>, values: &[&str]) -> bool {
    node.attributes().any(|attribute| {
        attribute.name() == "type"
            && attribute
                .value()
                .split_whitespace()
                .any(|value| values.contains(&value))
    })
}

fn is_leading_title_image(image: roxmltree::Node<'_, '_>) -> bool {
    is_near_document_start(image) && is_image_only_block(image) && has_next_heading_text(image)
}

fn is_near_document_start(image: roxmltree::Node<'_, '_>) -> bool {
    let body = image
        .document()
        .descendants()
        .find(|node| node.is_element() && node.has_tag_name("body"));
    let Some(body) = body else {
        return false;
    };
    let mut meaningful = 0;
    for node in body.descendants().skip(1) {
        let accepted = if node == image {
            true
        } else if node.is_text() {
            node.text().is_some_and(has_text)
                && !node
                    .ancestors()
                    .any(|ancestor| ancestor.is_element() && matches!(ancestor.tag_name().name(), "script" | "style"))
        } else {
            node.is_element() && matches!(node.tag_name().name(), "img" | "svg" | "picture")
        };
        if !accepted {
            continue;
        }
        if node == image {
            return meaningful <= 3;
        }
        meaningful += 1;
        if meaningful >= 8 {
            break;
        }
    }
    false
}

fn is_image_only_block(image: roxmltree::Node<'_, '_>) -> bool {
    let block = image
        .ancestors()
        .find(|node| node.is_element() && matches!(node.tag_name().name(), "div" | "p" | "figure" | "section"))
        .or_else(|| image.parent_element());
    let Some(block) = block else {
        return true;
    };
    let has_media = block
        .descendants()
        .any(|node| node.is_element() && matches!(node.tag_name().name(), "img" | "svg" | "picture"));
    has_media && !has_text_at_least(block, 1)
}

fn has_next_heading_text(image: roxmltree::Node<'_, '_>) -> bool {
    let container = image
        .ancestors()
        .find(|node| node.is_element() && matches!(node.tag_name().name(), "div" | "p" | "figure" | "section"))
        .unwrap_or(image);
    let mut sibling = container.next_sibling_element();
    let mut scanned = 0;
    while let Some(current) = sibling {
        if matches!(current.tag_name().name(), "link" | "meta" | "script" | "style") {
            sibling = current.next_sibling_element();
            continue;
        }
        if matches!(current.tag_name().name(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
            return has_text_at_least(current, 1);
        }
        if let Some(heading) = current
            .descendants()
            .find(|node| node.is_element() && matches!(node.tag_name().name(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6"))
        {
            return has_text_at_least(heading, 1);
        }
        if has_text_at_least(current, 1) {
            scanned += 1;
            if scanned >= 8 {
                break;
            }
        }
        sibling = current.next_sibling_element();
    }
    false
}

fn has_sibling_text(image: roxmltree::Node<'_, '_>) -> bool {
    image
        .parent()
        .into_iter()
        .flat_map(|parent| parent.children())
        .filter(|node| *node != image)
        .any(|node| {
            if node.is_text() {
                has_text(node.text().unwrap_or_default())
            } else if node.is_element() && !matches!(node.tag_name().name(), "img" | "svg" | "picture") {
                has_text_at_least(node, 1)
            } else {
                false
            }
        })
}

fn has_text_at_least(node: roxmltree::Node<'_, '_>, minimum: usize) -> bool {
    node.descendants()
        .filter(|child| child.is_text())
        .filter_map(|child| child.text())
        .flat_map(str::chars)
        .filter(|character| !character.is_whitespace())
        .take(minimum)
        .count()
        == minimum
}

fn has_text(value: &str) -> bool {
    value.chars().any(|character| !character.is_whitespace())
}

fn numeric_dimension(value: Option<&str>) -> Option<f64> {
    let value = value?;
    let start = value.find(|character: char| character.is_ascii_digit() || character == '.')?;
    let numeric = value[start..]
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.')
        .collect::<String>();
    numeric.parse().ok()
}

fn style_dimension(style: Option<&str>, property: &str) -> Option<f64> {
    style?
        .split(';')
        .filter_map(|declaration| declaration.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case(property))
        .and_then(|(_, value)| numeric_dimension(Some(value.trim())))
}

fn decorative_image_text(value: &str) -> bool {
    let value = value.to_lowercase();
    [
        "cover", "decor", "divider", "flower", "glyph", "icon", "note", "ornament", "title", "zhu", "注", "题", "章",
        "節", "节",
    ]
    .iter()
    .any(|pattern| value.contains(pattern))
}

fn normalize_image_source_key(src: &str) -> String {
    super::percent_decode_path(src.split('#').next().unwrap_or(src))
}

fn is_absolute_resource_src(src: &str) -> bool {
    let Some((scheme, _)) = src.split_once(':') else {
        return false;
    };
    let mut characters = scheme.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic())
        && characters.all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.'))
}

fn resolve_image_src(section_href: &str, src: &str) -> String {
    let src = src.trim();
    if src.is_empty() || src.starts_with('#') || src.starts_with("//") || is_absolute_resource_src(src) {
        return src.to_string();
    }
    let path = src.split(['?', '#']).next().unwrap_or(src).replace('\\', "/");
    normalize_zip_path(join_zip_path(parent_zip_path(section_href), &path))
}

fn mark_duplicate(image: &mut ImageIndexEntry) {
    image.hidden_by_default = true;
    image.reason = Some("duplicate".to_string());
}
