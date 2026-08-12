use std::io::{Read, Seek};

use zip::ZipArchive;

use crate::{
    CoverAsset, CoverError,
    archive::{EPUB_COVER_READ_LIMIT, read_entry, read_xml_entry},
    container::parse_xml,
    path,
};

#[derive(Debug, Clone)]
struct ManifestItem {
    id: String,
    href: String,
    media_type: String,
    properties: String,
}

pub(crate) fn inspect_cover<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    opf_path: &str,
    opf_xml: &str,
) -> Result<Option<CoverAsset>, CoverError> {
    let document = parse_xml(opf_xml, opf_path)?;
    let manifest = manifest_items(&document);
    Ok(find_cover(archive, &document, opf_path, &manifest))
}

fn manifest_items(document: &roxmltree::Document<'_>) -> Vec<ManifestItem> {
    document
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "item")
        .filter_map(|node| {
            Some(ManifestItem {
                id: node.attribute("id")?.to_string(),
                href: node.attribute("href")?.to_string(),
                media_type: node.attribute("media-type").unwrap_or("").to_string(),
                properties: node.attribute("properties").unwrap_or("").to_string(),
            })
        })
        .collect()
}

fn find_cover<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    document: &roxmltree::Document<'_>,
    opf_path: &str,
    manifest: &[ManifestItem],
) -> Option<CoverAsset> {
    let opf_parent = path::parent(opf_path);

    let epub3_cover = manifest.iter().find(|item| {
        item.properties
            .split_whitespace()
            .any(|property| property.eq_ignore_ascii_case("cover-image"))
    });
    if let Some(cover) =
        epub3_cover.and_then(|item| cover_from_item(archive, opf_parent, item, manifest))
    {
        return Some(cover);
    }

    let epub2_cover_id = document.descendants().find_map(|node| {
        (node.is_element()
            && node.tag_name().name() == "meta"
            && node
                .attribute("name")
                .is_some_and(|name| name.eq_ignore_ascii_case("cover")))
        .then(|| node.attribute("content"))
        .flatten()
    });
    if let Some(cover) = epub2_cover_id
        .and_then(|id| manifest.iter().find(|item| item.id == id))
        .and_then(|item| cover_from_item(archive, opf_parent, item, manifest))
    {
        return Some(cover);
    }

    let guide_cover = document.descendants().find_map(|node| {
        (node.is_element()
            && node.tag_name().name() == "reference"
            && node
                .attribute("type")
                .is_some_and(|kind| kind.eq_ignore_ascii_case("cover")))
        .then(|| node.attribute("href"))
        .flatten()
    });
    if let Some(cover) =
        guide_cover.and_then(|href| cover_from_href(archive, opf_parent, href, "", manifest))
    {
        return Some(cover);
    }

    if let Some(cover) = manifest
        .iter()
        .filter(|item| is_image(&item.media_type, &item.href))
        .find(|item| cover_id_starts_with_cover(&item.id) || is_cover_name(&item.href))
        .and_then(|item| cover_from_item(archive, opf_parent, item, manifest))
    {
        return Some(cover);
    }

    if let Some(cover) = manifest
        .iter()
        .filter(|item| is_html(&item.media_type, &item.href))
        .find(|item| is_cover_name(&item.id) || is_cover_name(&item.href))
        .and_then(|item| cover_from_item(archive, opf_parent, item, manifest))
    {
        return Some(cover);
    }

    document
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "itemref")
        .filter_map(|node| node.attribute("idref"))
        .filter_map(|id| manifest.iter().find(|item| item.id == id))
        .take(3)
        .find(|item| is_html(&item.media_type, &item.href))
        .and_then(|item| cover_from_item(archive, opf_parent, item, manifest))
}

fn cover_from_item<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    opf_parent: &str,
    item: &ManifestItem,
    manifest: &[ManifestItem],
) -> Option<CoverAsset> {
    cover_from_href(archive, opf_parent, &item.href, &item.media_type, manifest)
}

fn cover_from_href<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    parent: &str,
    href: &str,
    media_type: &str,
    manifest: &[ManifestItem],
) -> Option<CoverAsset> {
    if is_image(media_type, href) {
        return read_image(archive, parent, href, media_type);
    }
    if !is_html(media_type, href) {
        return None;
    }

    let html_path = path::resolve_href(parent, href).ok()?;
    let (html, resolved_html_path) = read_xml_entry(archive, &html_path).ok()?;
    let image_href = first_html_image_href(&html, &resolved_html_path)?;
    let image_path = path::resolve_href(path::parent(&resolved_html_path), &image_href).ok()?;
    let image_media_type = manifest
        .iter()
        .find_map(|item| {
            let candidate = path::resolve_href(parent, &item.href).ok()?;
            path::equivalent(&candidate, &image_path).then_some(item.media_type.as_str())
        })
        .unwrap_or("");
    read_image(archive, "", &image_path, image_media_type)
}

fn read_image<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    parent: &str,
    href: &str,
    media_type: &str,
) -> Option<CoverAsset> {
    let requested_path = path::resolve_href(parent, href).ok()?;
    let (bytes, archive_path) = read_entry(archive, &requested_path, EPUB_COVER_READ_LIMIT).ok()?;
    let extension = extension(&archive_path);
    let media_type = if media_type.trim().is_empty() {
        media_type_for_extension(&extension)
    } else {
        media_type.trim()
    };
    if !is_image(media_type, &archive_path) {
        return None;
    }
    Some(CoverAsset {
        bytes,
        media_type: media_type.to_string(),
        extension,
        archive_path,
    })
}

fn first_html_image_href(html: &str, entry: &str) -> Option<String> {
    let document = parse_xml(html, entry).ok()?;
    document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "img")
        .and_then(|node| node.attribute("src"))
        .or_else(|| {
            document
                .descendants()
                .find(|node| node.is_element() && node.tag_name().name() == "image")
                .and_then(|node| {
                    node.attributes()
                        .find(|attribute| attribute.name().eq_ignore_ascii_case("href"))
                        .map(|attribute| attribute.value())
                })
        })
        .map(str::to_string)
}

fn is_cover_name(value: &str) -> bool {
    value.to_ascii_lowercase().contains("cover")
}

fn cover_id_starts_with_cover(value: &str) -> bool {
    value.to_ascii_lowercase().split('.').next() == Some("cover")
}

fn is_image(media_type: &str, href: &str) -> bool {
    media_type.trim().to_ascii_lowercase().starts_with("image/")
        || matches!(
            extension(href).as_str(),
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg"
        )
}

fn is_html(media_type: &str, href: &str) -> bool {
    matches!(
        media_type.trim().to_ascii_lowercase().as_str(),
        "application/xhtml+xml" | "text/html"
    ) || matches!(extension(href).as_str(), "xhtml" | "html" | "htm")
}

fn extension(value: &str) -> String {
    let value = value.split(['?', '#']).next().unwrap_or(value);
    value
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default()
}

fn media_type_for_extension(extension: &str) -> &'static str {
    match extension {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "",
    }
}
