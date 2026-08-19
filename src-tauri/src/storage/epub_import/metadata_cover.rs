use super::access::inspect_epub_archive;
use super::*;

pub(super) fn inspect_epub_info(path: &Path) -> Result<(ParsedEpubInfo, BookContentMode), String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    let content_mode = inspect_epub_archive(&mut archive)?;
    let inspection = flow_epub_cover::inspect_epub_cover_archive(&mut archive).map_err(|error| error.to_string())?;
    let parsed = parse_epub_info(inspection, path)?;
    Ok((parsed, content_mode))
}

fn parse_epub_info_from_archive<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    path: &Path,
) -> Result<ParsedEpubInfo, String> {
    let inspection = flow_epub_cover::inspect_epub_cover_archive(archive).map_err(|error| error.to_string())?;
    parse_epub_info(inspection, path)
}

fn parse_epub_info(inspection: flow_epub_cover::EpubCoverInspection, path: &Path) -> Result<ParsedEpubInfo, String> {
    let opf_doc = roxmltree::Document::parse(&inspection.opf_xml).map_err(|error| error.to_string())?;
    let metadata = parse_opf_metadata(&opf_doc);
    let cover = inspection.cover.map(|asset| ParsedEpubCover {
        input: CoverInput {
            mime_type: asset.media_type,
            extension: asset.extension,
            data: asset.bytes,
        },
        archive_path: Some(asset.archive_path),
    });
    let generated_cover = cover.is_none();
    let cover = cover.or_else(|| {
        create_text_cover_input(&metadata, path.file_stem().and_then(|name| name.to_str())).map(|input| {
            ParsedEpubCover {
                input,
                archive_path: None,
            }
        })
    });

    Ok(ParsedEpubInfo {
        metadata,
        cover,
        generated_cover,
    })
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
            .map(|value| {
                if key == "creator" {
                    normalize_epub_creator(value)
                } else {
                    clean_xml_text(value)
                }
            })
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

pub(in crate::storage) fn normalize_epub_creator(value: &str) -> String {
    let value = clean_xml_text(value);
    value.strip_suffix(" 著").unwrap_or(&value).trim().to_string()
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

    let mut source = vec![0; reader.output_buffer_size()?];
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

pub(super) fn normalize_epub_cover_png(cover: &mut Option<ParsedEpubCover>) -> Option<String> {
    let cover = cover.as_mut()?;
    if cover.input.mime_type != "image/png" && !cover.input.extension.eq_ignore_ascii_case("png") {
        return None;
    }
    let archive_path = cover.archive_path.clone()?;
    let normalized = normalize_non_square_pixel_png(&cover.input.data)?;
    cover.input.data = normalized;
    Some(archive_path)
}

pub(super) fn read_epub_cover_png_repair(path: &Path) -> Result<Option<(String, Vec<u8>)>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut parsed = parse_epub_info_from_archive(&mut archive, path)?;
    let Some(archive_path) = normalize_epub_cover_png(&mut parsed.cover) else {
        return Ok(None);
    };
    Ok(parsed.cover.map(|cover| (archive_path, cover.input.data)))
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

pub(super) fn is_absolute_url(value: &str) -> bool {
    value.chars().next().is_some_and(|ch| ch.is_ascii_alphabetic()) && value.contains(':')
}

pub(super) fn extension_from_path(path: &str) -> String {
    path.rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default()
}
