use super::*;

pub(in crate::storage) fn normalize_unpacked_epub_structure(unpacked_dir: &Path) -> Result<bool, String> {
    let opf_path = find_unpacked_opf_path(unpacked_dir)?;
    let opf_xml = fs::read_to_string(&opf_path).map_err(|_| "skip".to_string());
    let Ok(mut opf_xml) = opf_xml else {
        return Ok(false);
    };
    let mut changed = deobfuscate_unpacked_idpf_fonts(unpacked_dir, &opf_xml)?;

    let opf_zip_path = opf_path
        .strip_prefix(unpacked_dir)
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let opf_parent = parent_zip_path(&opf_zip_path).to_string();

    let ncx_context = {
        let opf_doc = match roxmltree::Document::parse(&opf_xml) {
            Ok(doc) => doc,
            Err(_) => return Ok(changed),
        };
        if opf_declares_fixed_layout(&opf_doc) {
            return Ok(changed);
        }

        let manifest = opf_manifest_items(&opf_doc);
        let spine = opf_spine_items(&opf_doc);
        let Some(ncx_item) = find_ncx_manifest_item(&opf_doc, &manifest) else {
            return Ok(changed);
        };
        let ncx_abs_path = normalize_zip_path(join_zip_path(&opf_parent, &ncx_item.href));
        let ncx_file_path = unpacked_resource_path(unpacked_dir, &ncx_abs_path);
        let Ok(ncx_xml) = fs::read_to_string(&ncx_file_path) else {
            return Ok(changed);
        };
        let ncx_parent = parent_zip_path(&ncx_abs_path).to_string();
        let mut toc_target_abs_paths = ncx_content_paths(&ncx_xml)
            .into_iter()
            .map(|path| normalize_zip_path(join_zip_path(&ncx_parent, &path)))
            .collect::<Vec<_>>();

        if let Some(nav_item) = find_nav_manifest_item(&manifest) {
            let nav_abs_path = normalize_zip_path(join_zip_path(&opf_parent, &nav_item.href));
            let nav_file_path = unpacked_resource_path(unpacked_dir, &nav_abs_path);
            if let Ok(nav_xml) = fs::read_to_string(&nav_file_path) {
                let nav_parent = parent_zip_path(&nav_abs_path);
                toc_target_abs_paths.extend(
                    nav_toc_href_paths(&nav_xml)
                        .into_iter()
                        .map(|path| normalize_zip_path(join_zip_path(nav_parent, &path))),
                );
            }
        }
        for guide_toc_href in opf_guide_toc_hrefs(&opf_doc) {
            let toc_abs_path = normalize_zip_path(join_zip_path(&opf_parent, &guide_toc_href));
            let toc_file_path = unpacked_resource_path(unpacked_dir, &toc_abs_path);
            if let Ok(toc_html) = fs::read_to_string(&toc_file_path) {
                let toc_parent = parent_zip_path(&toc_abs_path);
                toc_target_abs_paths.extend(
                    html_href_paths(&toc_html)
                        .into_iter()
                        .map(|path| normalize_zip_path(join_zip_path(toc_parent, &path))),
                );
            }
        }

        drop(opf_doc);
        if let Some(updated_opf) = repair_missing_spine_nav_targets(
            &opf_xml,
            unpacked_dir,
            &opf_parent,
            &manifest,
            &spine,
            &ncx_xml,
            &ncx_parent,
        ) {
            fs::write(&opf_path, updated_opf.as_bytes()).map_err(|error| error.to_string())?;
            opf_xml = updated_opf;
            changed = true;
        }
        if let Some(updated_opf) = repair_linear_no_toc_targets(
            &opf_xml,
            unpacked_dir,
            &opf_parent,
            &manifest,
            &spine,
            &toc_target_abs_paths,
        ) {
            fs::write(&opf_path, updated_opf.as_bytes()).map_err(|error| error.to_string())?;
            opf_xml = updated_opf;
            changed = true;
        }

        (ncx_file_path, ncx_xml, ncx_parent)
    };

    let opf_doc = match roxmltree::Document::parse(&opf_xml) {
        Ok(doc) => doc,
        Err(_) => return Ok(changed),
    };
    let manifest = opf_manifest_items(&opf_doc);
    let spine = opf_spine_items(&opf_doc);
    let manifest_by_id = manifest
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect::<HashMap<_, _>>();
    let (ncx_file_path, ncx_xml, ncx_parent) = ncx_context;
    let ncx_references = ncx_content_references(&ncx_xml);
    if ncx_references.len() < EPUB_SECTION_SPLIT_MIN_NAV_POINTS {
        return Ok(changed);
    }

    let used_ids = manifest.iter().map(|item| item.id.clone()).collect::<HashSet<_>>();
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
                percent_decode_zip_path(&reference_abs) == percent_decode_zip_path(&section_abs_path)
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
        return Ok(changed);
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

    Ok(true)
}

pub(in crate::storage) fn deobfuscate_unpacked_idpf_fonts(unpacked_dir: &Path, opf_xml: &str) -> Result<bool, String> {
    const IDPF_EMBEDDING_ALGORITHM: &str = "http://www.idpf.org/2008/embedding";
    const IDPF_OBFUSCATION_BYTES: usize = 1_040;

    let encryption_path = unpacked_dir.join("META-INF").join("encryption.xml");
    let Ok(encryption_xml) = fs::read_to_string(&encryption_path) else {
        return Ok(false);
    };
    if !encryption_xml.contains(IDPF_EMBEDDING_ALGORITHM) {
        return Ok(false);
    }
    let Ok(opf_doc) = roxmltree::Document::parse(opf_xml) else {
        return Ok(false);
    };
    let Ok(encryption_doc) = roxmltree::Document::parse(&encryption_xml) else {
        return Ok(false);
    };
    let Some(identifier) = package_unique_identifier(&opf_doc) else {
        return Ok(false);
    };
    let identifier = identifier
        .chars()
        .filter(|character| !matches!(character, '\u{0009}' | '\u{000a}' | '\u{000d}' | '\u{0020}'))
        .collect::<String>();
    if identifier.is_empty() {
        return Ok(false);
    }
    let key = Sha1::digest(identifier.as_bytes());
    let mut changed = false;
    let mut handled_ranges = Vec::new();

    for encrypted_data in encryption_doc
        .descendants()
        .filter(|node| node.is_element() && node.has_tag_name("EncryptedData"))
    {
        let uses_idpf_embedding = encrypted_data.descendants().any(|node| {
            node.is_element()
                && node.has_tag_name("EncryptionMethod")
                && node.attribute("Algorithm") == Some(IDPF_EMBEDDING_ALGORITHM)
        });
        if !uses_idpf_embedding {
            continue;
        }
        let Some(uri) = encrypted_data
            .descendants()
            .find(|node| node.is_element() && node.has_tag_name("CipherReference"))
            .and_then(|node| node.attribute("URI"))
        else {
            continue;
        };
        let uri = uri.split(['?', '#']).next().unwrap_or("");
        let path = normalize_zip_path(percent_decode_zip_path(uri));
        if path.is_empty() {
            continue;
        }
        let font_path = unpacked_resource_path(unpacked_dir, &path);
        let Ok(mut bytes) = fs::read(&font_path) else {
            continue;
        };
        if has_supported_font_signature(&bytes) {
            handled_ranges.push(encrypted_data.range());
            continue;
        }
        for (index, byte) in bytes.iter_mut().take(IDPF_OBFUSCATION_BYTES).enumerate() {
            *byte ^= key[index % key.len()];
        }
        if !has_supported_font_signature(&bytes) {
            continue;
        }
        fs::write(&font_path, bytes).map_err(|error| error.to_string())?;
        handled_ranges.push(encrypted_data.range());
        changed = true;
    }

    if !handled_ranges.is_empty() {
        drop(encryption_doc);
        let mut updated_encryption = encryption_xml;
        for range in handled_ranges.into_iter().rev() {
            updated_encryption.replace_range(range, "");
        }
        fs::write(encryption_path, updated_encryption).map_err(|error| error.to_string())?;
        changed = true;
    }

    Ok(changed)
}

pub(super) fn package_unique_identifier<'a>(doc: &'a roxmltree::Document) -> Option<&'a str> {
    let package = doc
        .descendants()
        .find(|node| node.is_element() && node.has_tag_name("package"))?;
    let identifier_id = package.attribute("unique-identifier")?;

    doc.descendants()
        .find(|node| {
            node.is_element() && node.has_tag_name("identifier") && node.attribute("id") == Some(identifier_id)
        })
        .and_then(|node| node.text())
}

pub(super) fn has_supported_font_signature(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x00, 0x01, 0x00, 0x00])
        || bytes.starts_with(b"OTTO")
        || bytes.starts_with(b"true")
        || bytes.starts_with(b"typ1")
        || bytes.starts_with(b"wOFF")
        || bytes.starts_with(b"wOF2")
}

pub(super) fn opf_declares_fixed_layout(doc: &roxmltree::Document) -> bool {
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

pub(super) fn opf_manifest_items(doc: &roxmltree::Document) -> Vec<OpfManifestItem> {
    doc.descendants()
        .filter(|node| node.is_element() && node.has_tag_name("item"))
        .filter_map(|node| {
            Some(OpfManifestItem {
                id: node.attribute("id")?.to_string(),
                href: node.attribute("href")?.to_string(),
                media_type: node.attribute("media-type").unwrap_or("").to_string(),
                properties: node.attribute("properties").unwrap_or("").to_string(),
            })
        })
        .collect()
}

pub(super) fn opf_spine_items(doc: &roxmltree::Document) -> Vec<OpfSpineItem> {
    doc.descendants()
        .filter(|node| node.is_element() && node.has_tag_name("itemref"))
        .filter_map(|node| {
            Some(OpfSpineItem {
                idref: node.attribute("idref")?.to_string(),
                linear: node.attribute("linear").map(|value| value.to_string()),
            })
        })
        .collect()
}

pub(super) fn find_ncx_manifest_item(
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

pub(super) fn find_nav_manifest_item(manifest: &[OpfManifestItem]) -> Option<OpfManifestItem> {
    manifest
        .iter()
        .find(|item| {
            item.properties
                .split_whitespace()
                .any(|property| property.eq_ignore_ascii_case("nav"))
        })
        .cloned()
}

pub(super) fn opf_guide_toc_hrefs(doc: &roxmltree::Document) -> Vec<String> {
    doc.descendants()
        .filter(|node| node.is_element() && node.has_tag_name("reference"))
        .filter(|node| {
            node.attribute("type")
                .is_some_and(|type_| type_.eq_ignore_ascii_case("toc"))
        })
        .filter_map(|node| node.attribute("href"))
        .filter_map(normalize_local_href_path)
        .collect()
}

pub(super) fn is_html_manifest_item(item: &OpfManifestItem) -> bool {
    item.media_type == "application/xhtml+xml"
        || item.media_type == "text/html"
        || matches!(extension_from_path(&item.href).as_str(), "html" | "htm" | "xhtml")
}

pub(super) fn repair_linear_no_toc_targets(
    opf: &str,
    unpacked_dir: &Path,
    opf_parent: &str,
    manifest: &[OpfManifestItem],
    spine: &[OpfSpineItem],
    toc_target_abs_paths: &[String],
) -> Option<String> {
    let manifest_by_abs_path = manifest
        .iter()
        .filter(|item| is_html_manifest_item(item))
        .map(|item| {
            let abs_path = normalize_zip_path(join_zip_path(opf_parent, &item.href));
            (percent_decode_zip_path(&abs_path), item)
        })
        .collect::<HashMap<_, _>>();
    let spine_by_id = spine
        .iter()
        .map(|item| (item.idref.as_str(), item))
        .collect::<HashMap<_, _>>();

    let mut target_ids = Vec::new();
    let mut seen_ids = HashSet::new();
    for abs_path in toc_target_abs_paths {
        let decoded_abs_path = percent_decode_zip_path(abs_path);
        let Some(item) = manifest_by_abs_path.get(&decoded_abs_path) else {
            continue;
        };
        let Some(spine_item) = spine_by_id.get(item.id.as_str()) else {
            continue;
        };
        if !spine_item_is_linear_no(spine_item) || !seen_ids.insert(item.id.clone()) {
            continue;
        }
        if !unpacked_resource_path(unpacked_dir, abs_path).exists() {
            continue;
        }

        target_ids.push(item.id.clone());
    }

    if target_ids.is_empty() {
        return None;
    }

    Some(set_spine_itemrefs_linear_yes(opf, &target_ids))
}

pub(super) fn repair_missing_spine_nav_targets(
    opf: &str,
    unpacked_dir: &Path,
    opf_parent: &str,
    manifest: &[OpfManifestItem],
    spine: &[OpfSpineItem],
    ncx_xml: &str,
    ncx_parent: &str,
) -> Option<String> {
    let spine_ids = spine.iter().map(|item| item.idref.as_str()).collect::<HashSet<_>>();
    let manifest_by_id = manifest
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect::<HashMap<_, _>>();
    let readable_html_spine_count = spine
        .iter()
        .filter(|spine_item| !spine_item_is_linear_no(spine_item))
        .filter_map(|spine_item| manifest_by_id.get(spine_item.idref.as_str()))
        .filter(|item| is_html_manifest_item(item))
        .count();

    let manifest_by_abs_path = manifest
        .iter()
        .filter(|item| is_html_manifest_item(item))
        .map(|item| {
            let abs_path = normalize_zip_path(join_zip_path(opf_parent, &item.href));
            (percent_decode_zip_path(&abs_path), item)
        })
        .collect::<HashMap<_, _>>();

    let mut missing_ids = Vec::new();
    let mut seen_ids = HashSet::new();
    for path in ncx_content_paths(ncx_xml) {
        let abs_path = normalize_zip_path(join_zip_path(ncx_parent, &path));
        let decoded_abs_path = percent_decode_zip_path(&abs_path);
        let Some(item) = manifest_by_abs_path.get(&decoded_abs_path) else {
            continue;
        };
        if spine_ids.contains(item.id.as_str()) || !seen_ids.insert(item.id.clone()) {
            continue;
        }
        if !unpacked_resource_path(unpacked_dir, &abs_path).exists() {
            continue;
        }

        missing_ids.push(item.id.clone());
    }

    // This repair is only for converter-broken packages where the navigation
    // clearly points at real chapter documents but the spine contains only
    // cover/toc-like entries. A few missing nav targets in an otherwise full
    // spine are usually intentional non-linear resources, so leave them alone.
    if missing_ids.len() < EPUB_MISSING_SPINE_MIN_NAV_TARGETS {
        return None;
    }
    if readable_html_spine_count > EPUB_MISSING_SPINE_MAX_SMALL_READABLE_SPINE
        && missing_ids.len() <= readable_html_spine_count.saturating_mul(2)
    {
        return None;
    }

    append_spine_itemrefs(opf, &missing_ids)
}

pub(super) fn set_spine_itemrefs_linear_yes(opf: &str, idrefs: &[String]) -> String {
    let mut updated = opf.to_string();
    for idref in idrefs {
        let Some((start, end)) = find_xml_start_tag_range(&updated, "itemref", "idref", idref) else {
            continue;
        };
        let replacement = set_xml_start_tag_attr(&updated[start..end], "linear", "yes");
        updated.replace_range(start..end, &replacement);
    }

    updated
}

pub(super) fn set_xml_start_tag_attr(tag: &str, attr_name: &str, attr_value: &str) -> String {
    let pattern = format!(r#"(?is)\b{}\s*=\s*['"][^'"]*['"]"#, regex::escape(attr_name));
    if let Ok(regex) = Regex::new(&pattern)
        && let Some(match_) = regex.find(tag)
    {
        let mut updated = String::with_capacity(tag.len() + attr_value.len());
        updated.push_str(&tag[..match_.start()]);
        updated.push_str(attr_name);
        updated.push_str(r#"=""#);
        updated.push_str(&escape_xml_attr_local(attr_value));
        updated.push('"');
        updated.push_str(&tag[match_.end()..]);
        return updated;
    }

    let Some(end) = tag.rfind('>') else {
        return tag.to_string();
    };
    let insert_at = if tag[..end].trim_end().ends_with('/') {
        tag[..end].rfind('/').unwrap_or(end)
    } else {
        end
    };
    let mut updated = String::with_capacity(tag.len() + attr_name.len() + attr_value.len() + 4);
    updated.push_str(&tag[..insert_at]);
    if !updated.ends_with(char::is_whitespace) {
        updated.push(' ');
    }
    updated.push_str(attr_name);
    updated.push_str(r#"=""#);
    updated.push_str(&escape_xml_attr_local(attr_value));
    updated.push('"');
    updated.push_str(&tag[insert_at..]);
    updated
}

pub(super) fn spine_item_is_linear_no(item: &OpfSpineItem) -> bool {
    item.linear
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("no"))
}

pub(super) fn nav_toc_href_paths(nav: &str) -> Vec<String> {
    let (Ok(nav_start_regex), Ok(type_regex)) = (
        Regex::new(r#"(?is)<nav\b[^>]*>"#),
        Regex::new(r#"(?is)\b(?:epub:)?type\s*=\s*['"]([^'"]*)['"]"#),
    ) else {
        return Vec::new();
    };

    let Some(start_match) = nav_start_regex.find_iter(nav).find(|nav_match| {
        type_regex
            .captures(nav_match.as_str())
            .and_then(|captures| captures.get(1))
            .is_some_and(|types| types.as_str().split_whitespace().any(|value| value == "toc"))
    }) else {
        return Vec::new();
    };
    let content_start = start_match.end();
    let content_end = nav[content_start..]
        .to_ascii_lowercase()
        .find("</nav>")
        .map(|index| content_start + index)
        .unwrap_or(nav.len());

    html_href_paths(&nav[content_start..content_end])
}

pub(super) fn html_href_paths(html: &str) -> Vec<String> {
    let Ok(regex) = Regex::new(r#"(?is)<a\b[^>]*\bhref\s*=\s*['"]([^'"]+)['"][^>]*>"#) else {
        return Vec::new();
    };

    regex
        .captures_iter(html)
        .filter_map(|captures| captures.get(1).map(|match_| match_.as_str()))
        .filter_map(normalize_local_href_path)
        .collect()
}

pub(super) fn normalize_local_href_path(href: &str) -> Option<String> {
    let (path, _) = split_href_fragment(href.trim());
    if path.is_empty() || is_absolute_url(&path) {
        return None;
    }

    Some(path)
}

pub(super) fn ncx_content_paths(ncx: &str) -> Vec<String> {
    let Ok(regex) = Regex::new(r#"(?is)<content\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"][^>]*/?>"#) else {
        return Vec::new();
    };

    regex
        .captures_iter(ncx)
        .filter_map(|captures| {
            let raw_src = captures.get(1)?.as_str();
            let (path, _) = split_href_fragment(raw_src);
            (!path.is_empty()).then_some(path)
        })
        .collect()
}

pub(super) fn append_spine_itemrefs(opf: &str, idrefs: &[String]) -> Option<String> {
    let lower = opf.to_ascii_lowercase();
    let spine_close = lower.find("</spine>")?;
    let indent = spine_itemref_insert_indent(opf, spine_close);
    let mut insertion = String::new();
    if !opf[..spine_close].ends_with('\n') {
        insertion.push('\n');
    }
    for idref in idrefs {
        insertion.push_str(&indent);
        insertion.push_str(r#"<itemref idref=""#);
        insertion.push_str(&escape_xml_attr_local(idref));
        insertion.push_str(r#""/>"#);
        insertion.push('\n');
    }

    let mut updated = String::with_capacity(opf.len() + insertion.len());
    updated.push_str(&opf[..spine_close]);
    updated.push_str(&insertion);
    updated.push_str(&opf[spine_close..]);
    Some(updated)
}

pub(super) fn spine_itemref_insert_indent(opf: &str, spine_close: usize) -> String {
    let lower = opf[..spine_close].to_ascii_lowercase();
    if let Some(itemref_start) = lower.rfind("<itemref") {
        let indent = line_indent_before(opf, itemref_start);
        if !indent.is_empty() {
            return indent.to_string();
        }
    }

    let spine_indent = line_indent_before(opf, spine_close);
    if spine_indent.is_empty() {
        String::new()
    } else {
        format!("{spine_indent}  ")
    }
}

pub(super) fn ncx_content_references(ncx: &str) -> Vec<NcxReference> {
    let Ok(regex) = Regex::new(r#"(?is)<content\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"][^>]*/?>"#) else {
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

pub(super) fn split_href_fragment(href: &str) -> (String, String) {
    href.split_once('#')
        .map(|(path, fragment)| (path.to_string(), fragment.to_string()))
        .unwrap_or_else(|| (href.to_string(), String::new()))
}

pub(super) fn unpacked_resource_path(unpacked_dir: &Path, zip_path: &str) -> PathBuf {
    unpacked_dir.join(zip_path.replace('/', std::path::MAIN_SEPARATOR_STR))
}

pub(super) fn local_body_content_range(xhtml: &str) -> Option<(usize, usize)> {
    let lower = xhtml.to_ascii_lowercase();
    let body_tag_start = lower.find("<body")?;
    let body_content_start = lower[body_tag_start..].find('>')? + body_tag_start + 1;
    let body_content_end = lower[body_content_start..]
        .find("</body")
        .map(|index| body_content_start + index)
        .unwrap_or(xhtml.len());

    Some((body_content_start, body_content_end))
}

// Split planning keeps path, navigation, and ID inputs explicit so their invariants remain visible.
#[allow(clippy::too_many_arguments)]
pub(super) fn plan_split_section(
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

        let href = format!("{stem}-flow-split-{index:04}.{extension}", index = index + 1);
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
            prefix.len() + synthetic_open_len + (end - start.split_start_position) + synthetic_close_len + suffix.len(),
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
        let split_index = split_starts.partition_point(|start| start.split_start_position <= position) - 1;
        let split = split_items.get(split_index)?;
        let relative = relative_zip_path(ncx_parent, &split.abs_path);
        replacements.push((reference.raw_src.clone(), format!("{relative}#{}", reference.fragment)));
    }

    let mut all_link_targets = Vec::new();
    for (fragment, split_point) in &anchor_split_points {
        let split_index =
            split_starts.partition_point(|start| start.split_start_position <= split_point.anchor_position) - 1;
        let split = split_items.get(split_index)?;
        all_link_targets.push((fragment.clone(), split.abs_path.clone()));
    }

    rewrite_split_item_links(&mut split_items, section_abs_path, opf_parent, &all_link_targets);

    Some(SplitSection {
        original_id: item.id.clone(),
        original_abs_path: section_abs_path.to_string(),
        original_file_path: section_path.to_path_buf(),
        replacements,
        link_targets: all_link_targets,
        split_items,
    })
}

pub(super) fn rewrite_split_item_links(
    split_items: &mut [SplitItem],
    section_abs_path: &str,
    opf_parent: &str,
    link_targets: &[(String, String)],
) {
    let section_file_name = section_abs_path
        .rsplit_once('/')
        .map(|(_, name)| name)
        .unwrap_or(section_abs_path);

    for item in split_items {
        let item_parent = parent_zip_path(&item.abs_path);
        let original_relative = relative_zip_path(item_parent, section_abs_path);
        let original_opf_relative = relative_zip_path(opf_parent, section_abs_path);
        let mut replacements = HashMap::new();

        for (fragment, target_abs_path) in link_targets {
            let target = format!("{}#{}", relative_zip_path(item_parent, target_abs_path), fragment);
            replacements.insert(format!("{original_relative}#{fragment}"), target.clone());
            replacements.insert(format!("{original_opf_relative}#{fragment}"), target.clone());
            replacements.insert(format!("{section_file_name}#{fragment}"), target.clone());
            replacements.insert(format!("./{section_file_name}#{fragment}"), target.clone());

            if target_abs_path != &item.abs_path {
                replacements.insert(format!("#{fragment}"), target);
            }
        }

        item.content = replace_quoted_values_by_lookup(&item.content, &replacements);
    }
}

pub(super) fn collect_anchor_split_points(
    xhtml: &str,
    body_start: usize,
    body_end: usize,
) -> Option<HashMap<String, AnchorSplitPoint>> {
    let tag_regex = Regex::new(r#"(?is)<[^>]+>"#).ok()?;
    let anchor_regex = Regex::new(r#"(?is)(?:\bid\s*=\s*["']([^"']+)["']|\bname\s*=\s*["']([^"']+)["'])"#).ok()?;
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

        if let Some(captures) = anchor_regex.captures(tag)
            && let Some(anchor) = captures.get(1).or_else(|| captures.get(2))
        {
            let (split_start_position, open_ancestors) = split_boundary_for_anchor(&stack, &current);
            anchors.entry(anchor.as_str().to_string()).or_insert(AnchorSplitPoint {
                anchor_position: tag_start,
                split_start_position,
                open_ancestors,
            });
        }

        if !is_self_closing_split_tag(trimmed, &name) {
            stack.push(current);
        }
    }

    Some(anchors)
}

pub(super) fn split_boundary_for_anchor(stack: &[OpenElement], current: &OpenElement) -> (usize, Vec<OpenElement>) {
    if let Some(parent_index) = stack
        .iter()
        .rposition(|element| is_split_container_tag(&element.name) && is_split_text_block_tag(&current.name))
    {
        return (stack[parent_index].start, stack[..parent_index].to_vec());
    }

    if is_split_block_tag(&current.name) {
        return (current.start, stack.to_vec());
    }

    if let Some(parent_index) = stack.iter().rposition(|element| is_split_block_tag(&element.name)) {
        return (stack[parent_index].start, stack[..parent_index].to_vec());
    }

    (current.start, stack.to_vec())
}

pub(super) fn is_ignored_split_tag(tag: &str) -> bool {
    tag.starts_with("<!--")
        || tag.starts_with("<!")
        || tag.starts_with("<?")
        || tag.starts_with("</!")
        || tag.starts_with("</?")
}

pub(super) fn xml_tag_name(tag: &str) -> Option<String> {
    let tag = tag.trim_start_matches('<').trim_start_matches('/');
    let name = tag
        .chars()
        .take_while(|character| character.is_ascii_alphanumeric() || matches!(*character, '_' | '-' | ':' | '.'))
        .collect::<String>();
    (!name.is_empty()).then_some(name)
}

pub(super) fn is_self_closing_split_tag(tag: &str, name: &str) -> bool {
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

pub(super) fn is_split_text_block_tag(name: &str) -> bool {
    matches!(
        name,
        "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "dt" | "dd" | "figcaption"
    )
}

pub(super) fn is_split_container_tag(name: &str) -> bool {
    matches!(
        name,
        "div" | "section" | "article" | "main" | "nav" | "aside" | "blockquote" | "figure" | "li" | "td" | "th"
    )
}

pub(super) fn is_split_block_tag(name: &str) -> bool {
    is_split_text_block_tag(name)
        || is_split_container_tag(name)
        || matches!(name, "table" | "ul" | "ol" | "dl" | "pre")
}

#[cfg(test)]
pub(super) fn collect_anchor_starts(xhtml: &str, body_start: usize, body_end: usize) -> Option<HashMap<String, usize>> {
    let regex = Regex::new(r#"(?is)<[^>]+(?:\bid\s*=\s*["']([^"']+)["']|\bname\s*=\s*["']([^"']+)["'])[^>]*>"#).ok()?;
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

pub(super) fn unique_split_id(original_id: &str, index: usize, used_ids: &HashSet<String>) -> String {
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

pub(in crate::storage) fn relative_zip_path(from_parent: &str, target: &str) -> String {
    let from = from_parent
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let target_parts = target
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let mut common = 0usize;
    while common < from.len() && common < target_parts.len() && from[common] == target_parts[common] {
        common += 1;
    }

    let mut relative = Vec::new();
    relative.extend(std::iter::repeat_n("..", from.len() - common));
    relative.extend(target_parts.iter().skip(common).copied());
    relative.join("/")
}

pub(super) fn replace_manifest_item(opf: &str, split: &SplitSection) -> Result<String, String> {
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

pub(super) fn replace_spine_itemref(opf: &str, split: &SplitSection) -> Result<String, String> {
    let Some((start, end)) = find_xml_start_tag_range(opf, "itemref", "idref", &split.original_id) else {
        return Ok(opf.to_string());
    };
    let indent = line_indent_before(opf, start);
    let replacement = split
        .split_items
        .iter()
        .map(|item| format!(r#"{indent}<itemref idref="{}"/>"#, escape_xml_attr_local(&item.id)))
        .collect::<Vec<_>>()
        .join("\n");

    let mut updated = String::with_capacity(opf.len() + replacement.len());
    updated.push_str(&opf[..start]);
    updated.push_str(&replacement);
    updated.push_str(&opf[end..]);
    Ok(updated)
}

pub(super) fn find_xml_start_tag_range(
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
        if next.is_some_and(|character| !(character.is_whitespace() || character == '>' || character == '/')) {
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

pub(super) fn xml_tag_has_attr_value(tag: &str, attr_name: &str, attr_value: &str) -> bool {
    let pattern = format!(
        r#"(?is)\b{}\s*=\s*['"]{}['"]"#,
        regex::escape(attr_name),
        regex::escape(attr_value)
    );
    Regex::new(&pattern).ok().is_some_and(|regex| regex.is_match(tag))
}

pub(super) fn line_indent_before(text: &str, index: usize) -> &str {
    let line_start = text[..index].rfind('\n').map(|index| index + 1).unwrap_or(0);
    let indent = &text[line_start..index];
    if indent.chars().all(|character| character.is_ascii_whitespace()) {
        indent
    } else {
        ""
    }
}

pub(super) fn escape_xml_attr_local(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(super) fn replace_quoted_values(text: &str, replacements: &[(String, String)]) -> String {
    replacements.iter().fold(text.to_string(), |current, (from, to)| {
        current
            .replace(&format!(r#""{from}""#), &format!(r#""{to}""#))
            .replace(&format!("'{from}'"), &format!("'{to}'"))
    })
}

pub(super) fn replace_quoted_values_by_lookup(text: &str, replacements: &HashMap<String, String>) -> String {
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

pub(super) fn rewrite_current_package_html_links(
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

pub(super) fn rewrite_current_package_link_values(
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
            let target = format!("{}#{}", relative_zip_path(current_parent, target_abs_path), fragment);
            replacements.insert(format!("{original_relative}#{fragment}"), target.clone());
            replacements.insert(format!("{section_file_name}#{fragment}"), target.clone());
            replacements.insert(format!("./{section_file_name}#{fragment}"), target);
        }
    }

    replace_quoted_values_by_lookup(text, &replacements)
}

pub(super) fn collect_unpacked_html_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_unpacked_html_files_into(root, &mut files)?;
    files.sort();
    Ok(files)
}

pub(super) fn collect_unpacked_html_files_into(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
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
