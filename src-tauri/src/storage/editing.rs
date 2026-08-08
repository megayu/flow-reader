use super::*;

pub(super) fn escape_xml_text(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub(super) fn unescape_xml_text(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut cursor = 0usize;

    while let Some(relative_start) = value[cursor..].find('&') {
        let start = cursor + relative_start;
        result.push_str(&value[cursor..start]);
        let Some(relative_end) = value[start..].find(';') else {
            result.push_str(&value[start..]);
            return result;
        };
        let end = start + relative_end;
        let entity = &value[start + 1..end];
        match entity {
            "amp" => result.push('&'),
            "lt" => result.push('<'),
            "gt" => result.push('>'),
            "quot" => result.push('"'),
            "apos" => result.push('\''),
            "nbsp" => result.push('\u{00a0}'),
            entity if entity.starts_with("#x") || entity.starts_with("#X") => {
                if let Ok(codepoint) = u32::from_str_radix(&entity[2..], 16) {
                    if let Some(character) = char::from_u32(codepoint) {
                        result.push(character);
                    } else {
                        result.push_str(&value[start..=end]);
                    }
                } else {
                    result.push_str(&value[start..=end]);
                }
            }
            entity if entity.starts_with('#') => {
                if let Ok(codepoint) = entity[1..].parse::<u32>() {
                    if let Some(character) = char::from_u32(codepoint) {
                        result.push(character);
                    } else {
                        result.push_str(&value[start..=end]);
                    }
                } else {
                    result.push_str(&value[start..=end]);
                }
            }
            _ => result.push_str(&value[start..=end]),
        }
        cursor = end + 1;
    }

    result.push_str(&value[cursor..]);
    result
}

pub(super) fn escape_xml_attr(value: &str) -> String {
    escape_xml_text(value).replace('"', "&quot;").replace('\'', "&apos;")
}

pub(super) fn metadata_string(metadata: &Value, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
}

pub(super) fn normalize_xml_declaration_to_utf8(xml: &str) -> String {
    let Some(end) = xml.find("?>") else {
        return xml.to_string();
    };
    let declaration = &xml[..end + 2];
    if !declaration.trim_start().starts_with("<?xml") {
        return xml.to_string();
    }

    if let Some(updated_declaration) = replace_quoted_attr_value(declaration, "encoding", "UTF-8") {
        format!("{updated_declaration}{}", &xml[end + 2..])
    } else {
        xml.to_string()
    }
}

pub(super) fn replace_quoted_attr_value(text: &str, attr: &str, value: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let marker = format!("{attr}={quote}");
        if let Some(value_start) = text.find(&marker).map(|start| start + marker.len()) {
            let value_end = text[value_start..].find(quote)? + value_start;
            let mut updated = String::with_capacity(text.len() + value.len());
            updated.push_str(&text[..value_start]);
            updated.push_str(&escape_xml_attr(value));
            updated.push_str(&text[value_end..]);
            return Some(updated);
        }
    }

    None
}

pub(super) fn copy_until_closing_tag(lines: &[&str], index: &mut usize, closing: &str) -> String {
    let mut block = lines[*index].to_string();
    while !block.contains(closing) && *index + 1 < lines.len() {
        *index += 1;
        block.push_str(lines[*index]);
    }
    block
}

pub(super) fn compact_open_tag(open_tag: &str) -> String {
    if open_tag.contains('\n') {
        open_tag.split_whitespace().collect::<Vec<_>>().join(" ")
    } else {
        open_tag.to_string()
    }
}

pub(super) fn replace_metadata_block(block: &str, value: &str, closing: &str, update_file_as: bool) -> String {
    let Some(open_start) = block.find('<') else {
        return block.to_string();
    };
    let Some(open_end) = block.find('>') else {
        return block.to_string();
    };
    let Some(close_start) = block[open_end + 1..].find(closing).map(|offset| open_end + 1 + offset) else {
        return block.to_string();
    };
    let Some(close_end) = block[close_start..].find('>').map(|offset| close_start + offset + 1) else {
        return block.to_string();
    };

    let mut open_tag = compact_open_tag(&block[open_start..open_end + 1]);
    if update_file_as {
        open_tag = replace_quoted_attr_value(&open_tag, "opf:file-as", value).unwrap_or(open_tag);
    }

    let mut updated = String::with_capacity(block.len() + value.len());
    updated.push_str(&block[..open_start]);
    updated.push_str(&open_tag);
    updated.push_str(&escape_xml_text(value));
    updated.push_str(&block[close_start..close_end]);
    updated.push_str(&block[close_end..]);
    updated
}

pub(super) fn remove_block_keep_tail(block: &str, closing: &str) -> String {
    let Some(close_start) = block.find(closing) else {
        return block.to_string();
    };
    let Some(close_end) = block[close_start..].find('>').map(|offset| close_start + offset + 1) else {
        return block.to_string();
    };

    block[close_end..].to_string()
}

pub(super) fn update_opf_metadata_xml(xml: &str, metadata: &Value) -> String {
    let title = metadata_string(metadata, "title");
    let creator = metadata_string(metadata, "creator");
    if title.is_none() && creator.is_none() {
        return xml.to_string();
    }

    let lines = xml.split_inclusive('\n').collect::<Vec<_>>();
    let lines = if lines.is_empty() { vec![xml] } else { lines };
    let mut updated = String::with_capacity(xml.len());
    let mut title_done = title.is_none();
    let mut creator_done = creator.is_none();
    let mut index = 0usize;

    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim_start();

        if !title_done && (trimmed.starts_with("<dc:title") || trimmed.starts_with("<title")) {
            let closing = if trimmed.starts_with("<dc:title") {
                "</dc:title"
            } else {
                "</title"
            };
            let block = copy_until_closing_tag(&lines, &mut index, closing);
            updated.push_str(&replace_metadata_block(
                &block,
                title.as_deref().unwrap_or_default(),
                closing,
                false,
            ));
            title_done = true;
            index += 1;
            continue;
        }

        if trimmed.starts_with("<dc:creator") || trimmed.starts_with("<creator") {
            let closing = if trimmed.starts_with("<dc:creator") {
                "</dc:creator"
            } else {
                "</creator"
            };
            let block = copy_until_closing_tag(&lines, &mut index, closing);
            match creator.as_deref() {
                Some("") => updated.push_str(&remove_block_keep_tail(&block, closing)),
                Some(creator) if !creator_done => {
                    updated.push_str(&replace_metadata_block(&block, creator, closing, true));
                    creator_done = true;
                }
                _ => updated.push_str(&block),
            }
            index += 1;
            continue;
        }

        updated.push_str(line);
        index += 1;
    }

    updated
}

pub(super) fn sync_unpacked_opf_metadata(unpacked_dir: &Path, metadata: &Value) -> Result<(), String> {
    if !unpacked_dir.exists() {
        return Ok(());
    }

    let opf_path = find_unpacked_opf_path(unpacked_dir)?;
    let bytes = fs::read(&opf_path).map_err(|error| error.to_string())?;
    let decoded = decode_text_bytes(&bytes, None);
    let xml = normalize_xml_declaration_to_utf8(&decoded.text);
    let updated = update_opf_metadata_xml(&xml, metadata);
    if updated != xml || decoded.encoding != "utf-8" {
        fs::write(opf_path, updated.as_bytes()).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) fn body_content_range(xhtml: &str) -> Option<(usize, usize)> {
    let lower = xhtml.to_ascii_lowercase();
    let body_tag_start = lower.find("<body")?;
    let body_content_start = lower[body_tag_start..].find('>')? + body_tag_start + 1;
    let body_content_end = lower[body_content_start..]
        .find("</body")
        .map(|index| body_content_start + index)
        .unwrap_or(xhtml.len());

    Some((body_content_start, body_content_end))
}

pub(super) fn utf16_offset_to_byte_index(text: &str, offset: usize) -> Option<usize> {
    let mut utf16_offset = 0usize;
    for (byte_index, character) in text.char_indices() {
        if utf16_offset == offset {
            return Some(byte_index);
        }
        utf16_offset += character.len_utf16();
        if utf16_offset > offset {
            return None;
        }
    }

    if utf16_offset == offset { Some(text.len()) } else { None }
}

pub(super) fn replace_text_by_utf16_offsets(
    text: &str,
    start_offset: usize,
    end_offset: usize,
    old_text: &str,
    new_text: &str,
) -> Result<String, String> {
    if start_offset > end_offset {
        return Err(TEXT_REPLACE_TEXT_STALE_ERROR.to_string());
    }
    let start =
        utf16_offset_to_byte_index(text, start_offset).ok_or_else(|| TEXT_REPLACE_TEXT_STALE_ERROR.to_string())?;
    let end = utf16_offset_to_byte_index(text, end_offset).ok_or_else(|| TEXT_REPLACE_TEXT_STALE_ERROR.to_string())?;
    if &text[start..end] != old_text {
        return Err(TEXT_REPLACE_TEXT_STALE_ERROR.to_string());
    }

    let mut updated = String::with_capacity(text.len() + new_text.len());
    updated.push_str(&text[..start]);
    updated.push_str(new_text);
    updated.push_str(&text[end..]);
    Ok(updated)
}

pub(super) fn replace_xhtml_text_node(
    xhtml: &str,
    target: &BookTextReplaceTarget,
    old_text: &str,
    new_text: &str,
) -> Result<String, String> {
    if old_text.is_empty() {
        return Err(TEXT_REPLACE_EMPTY_ERROR.to_string());
    }
    if old_text == new_text {
        return Ok(xhtml.to_string());
    }

    let (body_start, body_end) =
        body_content_range(xhtml).ok_or_else(|| TEXT_REPLACE_SECTION_BODY_NOT_FOUND.to_string())?;
    let mut text_node_index = 0usize;
    let mut cursor = body_start;

    while cursor < body_end {
        let Some(relative_text_end) = xhtml[cursor..body_end].find('<') else {
            break;
        };
        let text_end = cursor + relative_text_end;
        if text_end > cursor {
            if text_node_index == target.text_node_index {
                let raw_text = &xhtml[cursor..text_end];
                let decoded_text = unescape_xml_text(raw_text);
                if decoded_text != target.text_node_text {
                    return Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string());
                }
                let updated_text = replace_text_by_utf16_offsets(
                    &decoded_text,
                    target.start_offset,
                    target.end_offset,
                    old_text,
                    new_text,
                )?;

                let mut updated = String::with_capacity(xhtml.len() + new_text.len());
                updated.push_str(&xhtml[..cursor]);
                updated.push_str(&escape_xml_text(&updated_text));
                updated.push_str(&xhtml[text_end..]);
                return Ok(updated);
            }
            text_node_index += 1;
        }

        let Some(relative_tag_end) = xhtml[text_end..body_end].find('>') else {
            break;
        };
        cursor = text_end + relative_tag_end + 1;
    }

    Err(TEXT_REPLACE_NODE_NOT_FOUND_ERROR.to_string())
}

pub(super) struct XhtmlTextReplacement {
    xhtml: String,
    heading_update: Option<(String, String)>,
    paragraph_index: Option<usize>,
}

pub(super) fn replace_generated_txt_paragraph_xhtml(
    xhtml: &str,
    target: &BookTextReplaceTarget,
    old_text: &str,
    new_text: &str,
    paragraph_index: usize,
) -> Result<Option<String>, String> {
    let Some(body_marker) = xhtml.find("data-flow-body-text") else {
        return Ok(None);
    };
    let body = &xhtml[body_marker..];
    let body_end = body
        .find("</div>")
        .map(|index| body_marker + index)
        .unwrap_or(xhtml.len());
    let mut cursor = body_marker;
    let mut current_paragraph_index = 0usize;

    while let Some(relative_start) = xhtml[cursor..body_end].find("<p>") {
        let start = cursor + relative_start + "<p>".len();
        let Some(relative_end) = xhtml[start..body_end].find("</p>") else {
            break;
        };
        let end = start + relative_end;
        if current_paragraph_index == paragraph_index {
            let decoded_text = unescape_xml_text(&xhtml[start..end]);
            if decoded_text != target.text_node_text {
                return Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string());
            }

            let updated_text = replace_text_by_utf16_offsets(
                &decoded_text,
                target.start_offset,
                target.end_offset,
                old_text,
                new_text,
            )?;

            let mut updated = String::with_capacity(xhtml.len() + new_text.len());
            updated.push_str(&xhtml[..start]);
            updated.push_str(&escape_xml_text(&updated_text));
            updated.push_str(&xhtml[end..]);
            return Ok(Some(updated));
        }

        current_paragraph_index += 1;
        cursor = end + "</p>".len();
    }

    Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string())
}

pub(super) fn replace_first_tag_text(
    xhtml: &str,
    tag_name: &str,
    expected_text: &str,
    updated_text: &str,
) -> Result<Option<String>, String> {
    let open_tag = format!("<{tag_name}");
    let close_tag = format!("</{tag_name}>");
    let Some(tag_start) = xhtml.find(&open_tag) else {
        return Ok(None);
    };
    let content_start = xhtml[tag_start..]
        .find('>')
        .map(|index| tag_start + index + 1)
        .ok_or_else(|| TEXT_REPLACE_NODE_STALE_ERROR.to_string())?;
    let content_end = xhtml[content_start..]
        .find(&close_tag)
        .map(|index| content_start + index)
        .ok_or_else(|| TEXT_REPLACE_NODE_STALE_ERROR.to_string())?;
    let decoded_text = unescape_xml_text(&xhtml[content_start..content_end]);
    if decoded_text != expected_text {
        return Ok(None);
    }

    let mut updated = String::with_capacity(xhtml.len() + updated_text.len());
    updated.push_str(&xhtml[..content_start]);
    updated.push_str(&escape_xml_text(updated_text));
    updated.push_str(&xhtml[content_end..]);
    Ok(Some(updated))
}

pub(super) fn replace_generated_txt_heading_xhtml(
    xhtml: &str,
    target: &BookTextReplaceTarget,
    old_text: &str,
    new_text: &str,
) -> Result<Option<XhtmlTextReplacement>, String> {
    if !xhtml.contains("flow-txt-chapter") {
        return Ok(None);
    }

    let Some(heading) = extract_first_tag_text(xhtml, "h2") else {
        return Ok(None);
    };
    if heading != target.text_node_text {
        return Ok(None);
    }

    let updated_heading =
        replace_text_by_utf16_offsets(&heading, target.start_offset, target.end_offset, old_text, new_text)?;
    let Some(mut updated_xhtml) = replace_first_tag_text(xhtml, "h2", &heading, &updated_heading)? else {
        return Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string());
    };
    if let Some(with_title) = replace_first_tag_text(&updated_xhtml, "title", &heading, &updated_heading)? {
        updated_xhtml = with_title;
    }

    Ok(Some(XhtmlTextReplacement {
        xhtml: updated_xhtml,
        heading_update: Some((heading, updated_heading)),
        paragraph_index: None,
    }))
}

pub(super) fn replace_xhtml_text(
    xhtml: &str,
    source_format: BookSourceFormat,
    target: &BookTextReplaceTarget,
    old_text: &str,
    new_text: &str,
) -> Result<XhtmlTextReplacement, String> {
    if old_text.is_empty() {
        return Err(TEXT_REPLACE_EMPTY_ERROR.to_string());
    }
    if old_text == new_text {
        return Ok(XhtmlTextReplacement {
            xhtml: xhtml.to_string(),
            heading_update: None,
            paragraph_index: None,
        });
    }

    if source_format != BookSourceFormat::Txt {
        return replace_xhtml_text_node(xhtml, target, old_text, new_text).map(|xhtml| XhtmlTextReplacement {
            xhtml,
            heading_update: None,
            paragraph_index: None,
        });
    }

    if let Some(paragraph_index) = target.paragraph_index
        && let Some(xhtml) = replace_generated_txt_paragraph_xhtml(xhtml, target, old_text, new_text, paragraph_index)?
    {
        return Ok(XhtmlTextReplacement {
            xhtml,
            heading_update: None,
            paragraph_index: Some(paragraph_index),
        });
    }

    if let Some(replacement) = replace_generated_txt_heading_xhtml(xhtml, target, old_text, new_text)? {
        return Ok(replacement);
    }

    Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string())
}

pub(super) const TEXT_REPLACE_EMPTY_ERROR: &str = "TEXT_REPLACE_EMPTY";
pub(super) const TEXT_REPLACE_SECTION_BODY_NOT_FOUND: &str = "TEXT_REPLACE_SECTION_BODY_NOT_FOUND";
pub(super) const TEXT_REPLACE_NODE_STALE_ERROR: &str = "TEXT_REPLACE_NODE_STALE";
pub(super) const TEXT_REPLACE_TEXT_STALE_ERROR: &str = "TEXT_REPLACE_TEXT_STALE";
pub(super) const TEXT_REPLACE_NODE_NOT_FOUND_ERROR: &str = "TEXT_REPLACE_NODE_NOT_FOUND";

#[derive(Debug, Clone)]
pub(super) enum SourceTextUpdate {
    Patch { offset: u64, bytes: Vec<u8> },
    Splice { offset: u64, old_len: u64, bytes: Vec<u8> },
}

pub(super) fn generated_text_section_index(href: &str) -> Option<usize> {
    let filename = href.rsplit(['/', '\\']).next()?;
    let number = filename
        .strip_prefix("part")?
        .strip_suffix(".xhtml")?
        .parse::<usize>()
        .ok()?;
    number.checked_sub(1)
}

pub(super) fn extract_first_tag_text(xhtml: &str, tag_name: &str) -> Option<String> {
    let open_tag = format!("<{tag_name}");
    let close_tag = format!("</{tag_name}>");
    let tag_start = xhtml.find(&open_tag)?;
    let content_start = xhtml[tag_start..].find('>')? + tag_start + 1;
    let content_end = xhtml[content_start..].find(&close_tag)? + content_start;
    Some(unescape_xml_text(&xhtml[content_start..content_end]))
}

pub(super) struct SourceTextLine {
    text: String,
    offset: u64,
    old_len: u64,
}

pub(super) fn source_bom_len(bytes: &[u8]) -> usize {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        3
    } else if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        2
    } else {
        0
    }
}

pub(super) fn streaming_source_encoding(metadata: &Value) -> Result<String, String> {
    source_encoding_id_from_metadata(metadata).ok_or_else(|| "TXT_SOURCE_ENCODING_MISSING".to_string())
}

pub(super) fn encoded_line_delimiter(encoding: &str) -> &'static [u8] {
    match encoding {
        "utf-16le" => &[0x0a, 0x00],
        "utf-16be" => &[0x00, 0x0a],
        _ => b"\n",
    }
}

pub(super) fn read_until_encoded_newline<R: Read>(
    reader: &mut BufReader<R>,
    encoding: &str,
    buffer: &mut Vec<u8>,
) -> io::Result<usize> {
    let delimiter = encoded_line_delimiter(encoding);
    if delimiter.len() == 1 {
        return reader.read_until(delimiter[0], buffer);
    }

    let mut total = 0usize;
    let mut byte = [0u8; 1];
    while reader.read(&mut byte)? != 0 {
        buffer.push(byte[0]);
        total += 1;
        if buffer.ends_with(delimiter) {
            break;
        }
    }
    Ok(total)
}

pub(super) fn strip_encoded_line_end<'a>(bytes: &'a [u8], encoding: &str) -> &'a [u8] {
    match encoding {
        "utf-16le" => bytes
            .strip_suffix(&[0x0a, 0x00])
            .unwrap_or(bytes)
            .strip_suffix(&[0x0d, 0x00])
            .unwrap_or_else(|| bytes.strip_suffix(&[0x0a, 0x00]).unwrap_or(bytes)),
        "utf-16be" => bytes
            .strip_suffix(&[0x00, 0x0a])
            .unwrap_or(bytes)
            .strip_suffix(&[0x00, 0x0d])
            .unwrap_or_else(|| bytes.strip_suffix(&[0x00, 0x0a]).unwrap_or(bytes)),
        _ => bytes
            .strip_suffix(b"\n")
            .unwrap_or(bytes)
            .strip_suffix(b"\r")
            .unwrap_or_else(|| bytes.strip_suffix(b"\n").unwrap_or(bytes)),
    }
}

pub(super) fn decode_source_line(
    bytes: &[u8],
    encoding: &str,
    first_line: bool,
) -> Result<Option<SourceTextLine>, String> {
    let line_end = strip_encoded_line_end(bytes, encoding);
    let bom_len = if first_line { source_bom_len(line_end) } else { 0 };
    let decoded = decode_text_bytes(&line_end[bom_len..], Some(encoding)).text;
    let trimmed_start = decoded.len() - decoded.trim_start().len();
    let trimmed_end = decoded.trim_end().len();
    if trimmed_start >= trimmed_end {
        return Ok(None);
    }

    let prefix_len = encode_text_bytes(&decoded[..trimmed_start], encoding, false)?.len();
    let trimmed_len = encode_text_bytes(&decoded[trimmed_start..trimmed_end], encoding, false)?.len();
    Ok(Some(SourceTextLine {
        text: decoded[trimmed_start..trimmed_end].to_string(),
        offset: (bom_len + prefix_len) as u64,
        old_len: trimmed_len as u64,
    }))
}

pub(super) fn push_unique_text(values: &mut Vec<String>, value: Option<String>) {
    let Some(value) = value else {
        return;
    };
    if !value.is_empty() && !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

pub(super) fn generated_txt_section_source_heading_candidates(
    text_dir: &Path,
    section_index: usize,
    section_href: &str,
) -> Result<Vec<String>, String> {
    let mut candidates = Vec::new();
    let path = text_dir.join(format!("part{:04}.xhtml", section_index + 1));
    let xhtml = fs::read_to_string(path).map_err(|_| TEXT_REPLACE_NODE_STALE_ERROR.to_string())?;
    push_unique_text(&mut candidates, extract_first_tag_text(&xhtml, "h2"));

    let nav_path = text_dir
        .parent()
        .map(|oebps| oebps.join("nav.xhtml"))
        .ok_or_else(|| TEXT_REPLACE_NODE_STALE_ERROR.to_string())?;
    if nav_path.exists() {
        let nav_xhtml = fs::read_to_string(nav_path).map_err(|error| error.to_string())?;
        push_unique_text(&mut candidates, generated_txt_nav_heading(&nav_xhtml, section_href));
    }

    if candidates.is_empty() {
        return Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string());
    }
    Ok(candidates)
}

pub(super) fn generated_txt_matching_heading_occurrences_before(
    text_dir: &Path,
    target_section_index: usize,
    target_candidates: &[String],
) -> Result<usize, String> {
    let mut occurrences = 0usize;
    for section_index in 0..target_section_index {
        let href = format!("Text/part{:04}.xhtml", section_index + 1);
        let candidates = generated_txt_section_source_heading_candidates(text_dir, section_index, &href)?;
        if candidates
            .iter()
            .any(|candidate| target_candidates.iter().any(|target| target == candidate))
        {
            occurrences += 1;
        }
    }
    Ok(occurrences)
}

pub(super) fn source_update_for_streamed_line(
    line: SourceTextLine,
    old_text: &str,
    new_text: &str,
    encoding: &str,
    target: &BookTextReplaceTarget,
) -> Result<SourceTextUpdate, String> {
    if line.text != target.text_node_text {
        return Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string());
    }
    let updated_line =
        replace_text_by_utf16_offsets(&line.text, target.start_offset, target.end_offset, old_text, new_text)?;
    let bytes = encode_text_bytes(&updated_line, encoding, false)?;
    if bytes.len() as u64 == line.old_len {
        Ok(SourceTextUpdate::Patch {
            offset: line.offset,
            bytes,
        })
    } else {
        Ok(SourceTextUpdate::Splice {
            offset: line.offset,
            old_len: line.old_len,
            bytes,
        })
    }
}

pub(super) fn generated_txt_source_update_streaming(
    source_path: &Path,
    metadata: &Value,
    text_dir: &Path,
    target: &BookTextReplaceTarget,
    old_text: &str,
    new_text: &str,
    heading_update: Option<&(String, String)>,
) -> Result<SourceTextUpdate, String> {
    if old_text.is_empty() {
        return Err(TEXT_REPLACE_EMPTY_ERROR.to_string());
    }
    if old_text == new_text {
        return Err(TEXT_REPLACE_TEXT_STALE_ERROR.to_string());
    }

    let encoding = streaming_source_encoding(metadata)?;
    let target_section_index =
        generated_text_section_index(&target.section_href).ok_or_else(|| TEXT_REPLACE_NODE_STALE_ERROR.to_string())?;
    let target_heading_candidates =
        generated_txt_section_source_heading_candidates(text_dir, target_section_index, &target.section_href)?;
    let mut matching_heading_occurrences_before =
        generated_txt_matching_heading_occurrences_before(text_dir, target_section_index, &target_heading_candidates)?;
    let target_paragraph_index = target.paragraph_index;
    let mut paragraph_index = 0usize;
    let mut inside_target_section = false;
    let mut first_line = true;
    let mut line_offset = 0u64;
    let mut reader = BufReader::new(fs::File::open(source_path).map_err(|error| error.to_string())?);
    let mut bytes = Vec::new();

    loop {
        bytes.clear();
        let read = read_until_encoded_newline(&mut reader, &encoding, &mut bytes).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }

        if let Some(mut line) = decode_source_line(&bytes, &encoding, first_line)? {
            line.offset = line.offset.saturating_add(line_offset);
            if !inside_target_section {
                if target_heading_candidates.contains(&line.text) {
                    if matching_heading_occurrences_before > 0 {
                        matching_heading_occurrences_before -= 1;
                    } else {
                        inside_target_section = true;
                        if heading_update.is_some() {
                            return source_update_for_streamed_line(line, old_text, new_text, &encoding, target);
                        }
                    }
                }
            } else if target_paragraph_index == Some(paragraph_index) {
                return source_update_for_streamed_line(line, old_text, new_text, &encoding, target);
            } else {
                paragraph_index += 1;
            }
        }

        first_line = false;
        line_offset = line_offset.saturating_add(read as u64);
    }

    Err(TEXT_REPLACE_NODE_STALE_ERROR.to_string())
}

pub(super) fn quoted_attr_value(text: &str, attr: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let marker = format!("{attr}={quote}");
        if let Some(value_start) = text.find(&marker).map(|start| start + marker.len()) {
            let value_end = text[value_start..].find(quote)? + value_start;
            return Some(unescape_xml_text(&text[value_start..value_end]));
        }
    }

    None
}

pub(super) fn same_generated_txt_href(left: &str, right: &str) -> bool {
    let left = normalize_zip_path(percent_decode_path(left.split('#').next().unwrap_or("")));
    let right = normalize_zip_path(percent_decode_path(right.split('#').next().unwrap_or("")));
    if left.trim_start_matches('/') == right.trim_start_matches('/') {
        return true;
    }
    generated_text_section_index(&left)
        .zip(generated_text_section_index(&right))
        .is_some_and(|(left_index, right_index)| left_index == right_index)
}

pub(super) fn generated_txt_nav_heading(nav_xhtml: &str, target_href: &str) -> Option<String> {
    let mut cursor = 0usize;
    while let Some(relative_anchor_start) = nav_xhtml[cursor..].find("<a") {
        let anchor_start = cursor + relative_anchor_start;
        let relative_tag_end = nav_xhtml[anchor_start..].find('>')?;
        let content_start = anchor_start + relative_tag_end + 1;
        let tag = &nav_xhtml[anchor_start..content_start];
        let Some(href) = quoted_attr_value(tag, "href") else {
            cursor = content_start;
            continue;
        };
        let relative_anchor_end = nav_xhtml[content_start..].find("</a>")?;
        let content_end = content_start + relative_anchor_end;
        if same_generated_txt_href(&href, target_href) {
            return Some(unescape_xml_text(&nav_xhtml[content_start..content_end]));
        }

        cursor = content_end + "</a>".len();
    }

    None
}

pub(super) fn replace_generated_txt_nav_heading(
    nav_xhtml: &str,
    target_href: &str,
    old_heading: &str,
    new_heading: &str,
) -> Result<String, String> {
    let mut cursor = 0usize;
    while let Some(relative_anchor_start) = nav_xhtml[cursor..].find("<a") {
        let anchor_start = cursor + relative_anchor_start;
        let Some(relative_tag_end) = nav_xhtml[anchor_start..].find('>') else {
            break;
        };
        let content_start = anchor_start + relative_tag_end + 1;
        let tag = &nav_xhtml[anchor_start..content_start];
        let Some(href) = quoted_attr_value(tag, "href") else {
            cursor = content_start;
            continue;
        };
        let Some(relative_anchor_end) = nav_xhtml[content_start..].find("</a>") else {
            break;
        };
        let content_end = content_start + relative_anchor_end;
        if same_generated_txt_href(&href, target_href)
            && unescape_xml_text(&nav_xhtml[content_start..content_end]) == old_heading
        {
            let mut updated = String::with_capacity(nav_xhtml.len() + new_heading.len());
            updated.push_str(&nav_xhtml[..content_start]);
            updated.push_str(&escape_xml_text(new_heading));
            updated.push_str(&nav_xhtml[content_end..]);
            return Ok(updated);
        }

        cursor = content_end + "</a>".len();
    }

    Ok(nav_xhtml.to_string())
}

pub(super) fn source_text_temp_path(path: &Path) -> PathBuf {
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("source.txt");
    path.with_file_name(format!("{file_name}.tmp"))
}

pub(super) fn write_source_text_splice(path: &Path, offset: u64, old_len: u64, bytes: &[u8]) -> Result<(), String> {
    let tmp = source_text_temp_path(path);
    let mut input = BufReader::new(fs::File::open(path).map_err(|error| error.to_string())?);
    let mut output = BufWriter::new(fs::File::create(&tmp).map_err(|error| error.to_string())?);

    io::copy(&mut input.by_ref().take(offset), &mut output).map_err(|error| error.to_string())?;
    output.write_all(bytes).map_err(|error| error.to_string())?;
    input
        .seek(SeekFrom::Start(offset.saturating_add(old_len)))
        .map_err(|error| error.to_string())?;
    io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())?;
    drop(output);
    drop(input);

    fs::remove_file(path).map_err(|error| error.to_string())?;
    fs::rename(&tmp, path).map_err(|error| error.to_string())
}

pub(super) fn write_source_text_update(path: &Path, update: &SourceTextUpdate) -> Result<(), String> {
    match update {
        SourceTextUpdate::Patch { offset, bytes } => {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .open(path)
                .map_err(|error| error.to_string())?;
            file.seek(SeekFrom::Start(*offset)).map_err(|error| error.to_string())?;
            file.write_all(bytes).map_err(|error| error.to_string())
        }
        SourceTextUpdate::Splice { offset, old_len, bytes } => write_source_text_splice(path, *offset, *old_len, bytes),
    }
}

pub(super) fn edited_book_content_hash(id: &str, content_version: u32, edited_at: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"edited\0");
    hasher.update(id.as_bytes());
    hasher.update(b"\0");
    hasher.update(content_version.to_le_bytes());
    hasher.update(edited_at.to_le_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(super) fn mark_library_book_content_updated(storage: &AppStorage, id: &str) -> Result<Option<LibraryBook>, String> {
    let updated = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let Some(book) = state.library.books.iter_mut().find(|book| book.id == id) else {
            return Ok(None);
        };
        let now = now_ms();
        book.content_version = book.content_version.saturating_add(1).max(1);
        book.content_edited_at = Some(now);
        book.content_hash = edited_book_content_hash(&book.id, book.content_version, now);
        book.updated_at = Some(now);
        book.clone()
    };
    storage.mark_library_dirty();
    Ok(Some(updated))
}

pub(super) fn replace_book_text_impl(
    storage: &AppStorage,
    id: String,
    target: BookTextReplaceTarget,
    old_text: String,
    new_text: String,
) -> Result<BookTextReplaceResult, String> {
    let initial_book = storage.library_book(&id)?;
    let source_format = initial_book.source_format;
    let content_mode = inspect_and_store_book_content_access(storage, &initial_book)?;
    if source_format == BookSourceFormat::Epub && content_mode == BookContentMode::ArchiveOnly {
        return Err("Archive-only EPUB text editing is not supported".to_string());
    }
    let book_dir = storage.book_dir(&id);
    let unpacked_dir = book_dir.join(UNPACKED_DIR);
    if !unpacked_dir.exists() {
        let book_path = book_dir.join(BOOK_FILE);
        if book_path.exists() {
            unpack_epub(&book_path, &unpacked_dir)?;
            normalize_unpacked_epub_structure(&unpacked_dir)?;
        }
    }

    let section_path = resolve_unpacked_resource_path(&unpacked_dir, &target.section_href)?;
    let xhtml = fs::read_to_string(&section_path).map_err(|error| error.to_string())?;
    let xhtml_update = replace_xhtml_text(&xhtml, source_format, &target, &old_text, &new_text)?;
    let heading_update = xhtml_update.heading_update.clone();
    let mut source_target = target.clone();
    if source_target.paragraph_index.is_none() {
        source_target.paragraph_index = xhtml_update.paragraph_index;
    }
    let updated_xhtml = xhtml_update.xhtml;
    if updated_xhtml == xhtml {
        return Ok(BookTextReplaceResult {
            book: storage.compose_book(&initial_book)?,
            section_href: target.section_href,
            changed: false,
        });
    }

    let source_update =
        if source_format == BookSourceFormat::Txt && initial_book.source_storage == SourceStorage::Managed {
            let source_path = book_dir.join(SOURCE_TEXT_FILE);
            let text_dir = section_path
                .parent()
                .ok_or_else(|| TEXT_REPLACE_NODE_STALE_ERROR.to_string())?;
            let source_update = generated_txt_source_update_streaming(
                &source_path,
                &initial_book.metadata,
                text_dir,
                &source_target,
                &old_text,
                &new_text,
                heading_update.as_ref(),
            )?;
            Some((source_path, source_update))
        } else {
            None
        };

    let nav_update = if let Some((old_heading, new_heading)) = &heading_update {
        let nav_path = section_path
            .parent()
            .and_then(Path::parent)
            .map(|oebps| oebps.join("nav.xhtml"))
            .ok_or_else(|| TEXT_REPLACE_NODE_STALE_ERROR.to_string())?;
        if nav_path.exists() {
            let nav_xhtml = fs::read_to_string(&nav_path).map_err(|error| error.to_string())?;
            let updated_nav =
                replace_generated_txt_nav_heading(&nav_xhtml, &target.section_href, old_heading, new_heading)?;
            (updated_nav != nav_xhtml).then_some((nav_path, updated_nav))
        } else {
            None
        }
    } else {
        None
    };

    if let Some((path, update)) = &source_update {
        write_source_text_update(path, update)?;
    }
    if let Some((path, updated_nav)) = &nav_update {
        fs::write(path, updated_nav).map_err(|error| error.to_string())?;
    }
    fs::write(&section_path, &updated_xhtml).map_err(|error| error.to_string())?;

    let mut book = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let Some(book) = state.library.books.iter_mut().find(|book| book.id == id) else {
            return Err("Book not found".to_string());
        };
        let now = now_ms();
        book.source_format = source_format;
        book.content_version = book.content_version.saturating_add(1).max(1);
        book.content_edited_at = Some(now);
        book.content_hash = edited_book_content_hash(&book.id, book.content_version, now);
        book.updated_at = Some(now);
        book.last_read_at = book.last_read_at.or(Some(now));
        book.clone()
    };

    if source_format == BookSourceFormat::Txt && initial_book.source_storage == SourceStorage::Managed {
        book.size = fs::metadata(book_dir.join(SOURCE_TEXT_FILE))
            .map_err(|error| error.to_string())?
            .len();
    }

    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let Some(stored_book) = state.library.books.iter_mut().find(|stored| stored.id == id) else {
            return Err("Book not found".to_string());
        };
        stored_book.content_hash = book.content_hash.clone();
        stored_book.size = book.size;
    }

    storage.update_derived_caches_after_edit(&book, &target.section_href, &updated_xhtml)?;
    storage.mark_library_dirty();
    storage.flush_dirty()?;

    Ok(BookTextReplaceResult {
        book: storage.compose_book(&book)?,
        section_href: target.section_href,
        changed: true,
    })
}
