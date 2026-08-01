use super::access::inspect_epub_archive;
use super::*;

pub(super) fn inspect_epub_info(path: &Path) -> Result<(ParsedEpubInfo, EpubAccessInfo), String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    let access = inspect_epub_archive(&mut archive)?;
    let parsed = parse_epub_info_from_archive(&mut archive, path)?;
    Ok((parsed, access))
}

fn parse_epub_info_from_archive<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    path: &Path,
) -> Result<ParsedEpubInfo, String> {
    let container = read_zip_text(archive, "META-INF/container.xml")?;
    let container_doc = roxmltree::Document::parse(&container).map_err(|error| error.to_string())?;
    let opf_path = container_doc
        .descendants()
        .find(|node| node.has_tag_name("rootfile"))
        .and_then(|node| node.attribute("full-path"))
        .ok_or_else(|| "EPUB container has no rootfile".to_string())?
        .to_string();
    let opf = read_zip_text(archive, &opf_path)?;
    let opf_doc = roxmltree::Document::parse(&opf).map_err(|error| error.to_string())?;
    let metadata = parse_opf_metadata(&opf_doc);
    let cover = find_cover_input(archive, &opf_doc, &opf_path).or_else(|| {
        create_text_cover_input(&metadata, path.file_stem().and_then(|name| name.to_str())).map(|input| {
            ParsedEpubCover {
                input,
                archive_path: None,
            }
        })
    });

    Ok(ParsedEpubInfo { metadata, cover })
}

pub(super) fn read_zip_text<R: Read + Seek>(archive: &mut ZipArchive<R>, name: &str) -> Result<String, String> {
    let file = archive.by_name(name).map_err(|error| error.to_string())?;
    let data = read_bounded_bytes(file, EPUB_XML_READ_LIMIT, "EPUB XML entry")?;
    String::from_utf8(data).map_err(|error| error.to_string())
}

pub(super) fn read_zip_bytes<R: Read + Seek>(archive: &mut ZipArchive<R>, name: &str) -> Result<Vec<u8>, String> {
    let file = archive.by_name(name).map_err(|error| error.to_string())?;
    read_bounded_bytes(file, EPUB_COVER_READ_LIMIT, "EPUB cover entry")
}

pub(super) fn read_zip_bytes_with_resolved_path<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<(Vec<u8>, String), String> {
    let mut last_error = "EPUB entry not found".to_string();

    for candidate in zip_path_candidates(name) {
        match read_zip_bytes(archive, &candidate) {
            Ok(data) => return Ok((data, candidate)),
            Err(error) => {
                last_error = error;
            }
        }
    }

    Err(last_error)
}

pub(super) fn read_zip_text_with_path_candidates<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<String, String> {
    let mut last_error = "EPUB entry not found".to_string();
    for candidate in zip_path_candidates(name) {
        match archive.by_name(&candidate) {
            Ok(file) => {
                let data = read_bounded_bytes(file, EPUB_XML_READ_LIMIT, "EPUB XML entry")?;
                return Ok(String::from_utf8_lossy(&data).into_owned());
            }
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(last_error)
}

pub(super) fn parse_opf_metadata(doc: &roxmltree::Document) -> Value {
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
            .find(|node| node.is_element() && node.has_tag_name("meta") && node.attribute("property") == Some(property))
            .and_then(|node| node.text())
            .map(clean_xml_text)
            .filter(|value| !value.is_empty())
        {
            metadata.insert(key.to_string(), Value::String(value));
        }
    }

    Value::Object(metadata)
}

pub(in crate::storage) fn clean_xml_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn find_cover_path(doc: &roxmltree::Document) -> Option<(String, String)> {
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

    if let Some(cover_id) = cover_id
        && let Some(item) = manifest_items().find(|node| node.attribute("id") == Some(cover_id.as_str()))
    {
        return cover_item_to_path(item);
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

pub(super) fn find_cover_input<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    doc: &roxmltree::Document,
    opf_path: &str,
) -> Option<ParsedEpubCover> {
    let opf_parent = parent_zip_path(opf_path);
    let manifest = doc
        .descendants()
        .filter(|node| node.is_element() && node.has_tag_name("item"))
        .filter_map(|node| {
            Some(OpfManifestItem {
                id: node.attribute("id")?.to_string(),
                href: node.attribute("href")?.to_string(),
                media_type: node.attribute("media-type").unwrap_or("").to_string(),
                properties: node.attribute("properties").unwrap_or("").to_string(),
            })
        })
        .collect::<Vec<_>>();

    if let Some(input) = find_cover_path(doc)
        .and_then(|(href, mime_type)| read_cover_image_input(archive, opf_parent, &href, &mime_type))
    {
        return Some(input);
    }

    if let Some(input) = find_declared_cover_item(doc)
        .and_then(|item| cover_input_from_manifest_item(archive, opf_parent, item, &manifest))
    {
        return Some(input);
    }

    if let Some(input) = manifest
        .iter()
        .filter(|item| is_html_media_type(&item.media_type))
        .find(|item| is_cover_name(&item.id) || is_cover_name(&item.href))
        .and_then(|item| cover_input_from_html_item(archive, opf_parent, item, &manifest))
    {
        return Some(input);
    }

    first_spine_image_page(doc, &manifest)
        .and_then(|item| cover_input_from_html_item(archive, opf_parent, item, &manifest))
}

pub(super) fn find_declared_cover_item<'a>(doc: &'a roxmltree::Document) -> Option<roxmltree::Node<'a, 'a>> {
    let cover_id = doc.descendants().find_map(|node| {
        if !node.is_element() || !node.has_tag_name("meta") {
            return None;
        }
        node.attribute("name")
            .is_some_and(|name| name.eq_ignore_ascii_case("cover"))
            .then(|| node.attribute("content").map(str::to_string))
            .flatten()
    })?;

    doc.descendants()
        .find(|node| node.is_element() && node.has_tag_name("item") && node.attribute("id") == Some(&cover_id))
}

pub(super) fn cover_input_from_manifest_item<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    opf_parent: &str,
    item: roxmltree::Node,
    manifest: &[OpfManifestItem],
) -> Option<ParsedEpubCover> {
    let (href, mime_type) = cover_item_to_path(item)?;
    if is_image_media_type(&mime_type) || image_extension_from_href(&href).is_some() {
        return read_cover_image_input(archive, opf_parent, &href, &mime_type);
    }
    if is_html_media_type(&mime_type) || is_html_href(&href) {
        let item = OpfManifestItem {
            id: item.attribute("id").unwrap_or("").to_string(),
            href,
            media_type: mime_type,
            properties: item.attribute("properties").unwrap_or("").to_string(),
        };
        return cover_input_from_html_item(archive, opf_parent, &item, manifest);
    }
    None
}

pub(super) fn cover_input_from_html_item<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    opf_parent: &str,
    item: &OpfManifestItem,
    manifest: &[OpfManifestItem],
) -> Option<ParsedEpubCover> {
    let html_path = normalize_zip_path(join_zip_path(opf_parent, &item.href));
    let html = read_zip_text_with_path_candidates(archive, &html_path).ok()?;
    let image_href = find_first_html_image_href(&html)?;
    let image_path = normalize_zip_path(join_zip_path(parent_zip_path(&html_path), &image_href));
    let mime_type = manifest
        .iter()
        .find(|manifest_item| {
            let candidate = normalize_zip_path(join_zip_path(opf_parent, &manifest_item.href));
            candidate == image_path
        })
        .map(|manifest_item| manifest_item.media_type.as_str())
        .filter(|mime_type| !mime_type.is_empty())
        .unwrap_or_else(|| mime_type_from_image_href(&image_path));

    read_cover_image_input(archive, "", &image_path, mime_type)
}

pub(super) fn first_spine_image_page<'a>(
    doc: &roxmltree::Document,
    manifest: &'a [OpfManifestItem],
) -> Option<&'a OpfManifestItem> {
    doc.descendants()
        .filter(|node| node.is_element() && node.has_tag_name("itemref"))
        .filter_map(|node| node.attribute("idref"))
        .filter_map(|idref| manifest.iter().find(|item| item.id == idref))
        .take(3)
        .find(|item| is_html_media_type(&item.media_type) || is_html_href(&item.href))
}

pub(super) fn read_cover_image_input<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    parent: &str,
    href: &str,
    mime_type: &str,
) -> Option<ParsedEpubCover> {
    if !is_image_media_type(mime_type) && image_extension_from_href(href).is_none() {
        return None;
    }

    let cover_path = normalize_zip_path(join_zip_path(parent, href));
    let (data, resolved_cover_path) = read_zip_bytes_with_resolved_path(archive, &cover_path).ok()?;
    Some(ParsedEpubCover {
        input: CoverInput {
            mime_type: if mime_type.is_empty() {
                mime_type_from_image_href(&cover_path).to_string()
            } else {
                mime_type.to_string()
            },
            extension: extension_from_path(&cover_path),
            data,
        },
        archive_path: Some(resolved_cover_path),
    })
}

pub(in crate::storage) fn normalize_non_square_pixel_png(data: &[u8]) -> Option<Vec<u8>> {
    let mut decoder = png::Decoder::new(Cursor::new(data));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().ok()?;
    let info = reader.info();
    let dimensions = info.pixel_dims?;
    let (xppu, yppu) = (dimensions.xppu, dimensions.yppu);
    if xppu == 0 || yppu == 0 || xppu == yppu {
        return None;
    }
    let (source_width, height) = (info.width, info.height);
    let target_width = u64::from(source_width)
        .checked_mul(u64::from(yppu))?
        .checked_add(u64::from(xppu) / 2)?
        / u64::from(xppu);
    let target_width = u32::try_from(target_width).ok()?;
    if target_width == 0 || target_width == source_width {
        return None;
    }

    let mut source = vec![0; reader.output_buffer_size()];
    let frame = reader.next_frame(&mut source).ok()?;
    source.truncate(frame.buffer_size());
    let channels = match frame.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return None,
    };
    let output_len = (target_width as usize)
        .checked_mul(height as usize)?
        .checked_mul(channels)?;
    let mut resized = vec![0; output_len];
    for row in 0..height as usize {
        for x in 0..target_width as usize {
            let source_x = x * source_width as usize / target_width as usize;
            let from = (row * source_width as usize + source_x) * channels;
            let to = (row * target_width as usize + x) * channels;
            resized[to..to + channels].copy_from_slice(&source[from..from + channels]);
        }
    }

    let mut output = Vec::new();
    let mut encoder = png::Encoder::new(&mut output, target_width, height);
    encoder.set_color(frame.color_type);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().ok()?;
    writer.write_image_data(&resized).ok()?;
    drop(writer);
    Some(output)
}

pub(super) fn find_first_html_image_href(html: &str) -> Option<String> {
    let doc = roxmltree::Document::parse_with_options(
        html,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            ..roxmltree::ParsingOptions::default()
        },
    )
    .ok()?;

    doc.descendants()
        .find(|node| node.is_element() && node.has_tag_name("img"))
        .and_then(|node| node.attribute("src"))
        .or_else(|| {
            doc.descendants()
                .find(|node| node.is_element() && node.has_tag_name("image"))
                .and_then(|node| {
                    node.attributes()
                        .find(|attribute| attribute.name().eq_ignore_ascii_case("href"))
                        .map(|attribute| attribute.value())
                })
        })
        .map(str::to_string)
        .filter(|href| !href.is_empty() && !is_absolute_url(href))
}

pub(super) fn is_cover_name(value: &str) -> bool {
    value.to_ascii_lowercase().contains("cover")
}

pub(super) fn is_image_media_type(media_type: &str) -> bool {
    media_type.trim().to_ascii_lowercase().starts_with("image/")
}

pub(super) fn is_html_media_type(media_type: &str) -> bool {
    matches!(
        media_type.trim().to_ascii_lowercase().as_str(),
        "application/xhtml+xml" | "text/html"
    )
}

pub(super) fn is_html_href(href: &str) -> bool {
    matches!(extension_from_path(href).as_str(), "xhtml" | "html" | "htm")
}

pub(super) fn image_extension_from_href(href: &str) -> Option<&'static str> {
    match extension_from_path(href).as_str() {
        "jpg" | "jpeg" => Some("jpg"),
        "png" => Some("png"),
        "gif" => Some("gif"),
        "webp" => Some("webp"),
        "svg" => Some("svg"),
        _ => None,
    }
}

pub(super) fn mime_type_from_image_href(href: &str) -> &'static str {
    match extension_from_path(href).as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "",
    }
}

pub(super) fn is_absolute_url(value: &str) -> bool {
    value.chars().next().is_some_and(|ch| ch.is_ascii_alphabetic()) && value.contains(':')
}

pub(super) fn cover_id_starts_with_cover(id: &str) -> bool {
    id.to_ascii_lowercase().split('.').next() == Some("cover")
}

pub(super) fn cover_item_to_path(node: roxmltree::Node) -> Option<(String, String)> {
    let href = node.attribute("href")?.to_string();
    let mime_type = node.attribute("media-type").unwrap_or("").to_string();
    Some((href, mime_type))
}

pub(in crate::storage) fn parent_zip_path(path: &str) -> &str {
    path.rsplit_once('/').map(|(parent, _)| parent).unwrap_or("")
}

pub(in crate::storage) fn join_zip_path(parent: &str, child: &str) -> String {
    if parent.is_empty() || child.starts_with('/') {
        child.trim_start_matches('/').to_string()
    } else {
        format!("{parent}/{child}")
    }
}

pub(in crate::storage) fn normalize_zip_path(path: String) -> String {
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

pub(super) fn extension_from_path(path: &str) -> String {
    path.rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default()
}
