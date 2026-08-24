use std::{collections::HashMap, fs, path::Path, time::Instant};

use crate::{
    diagnostics,
    tasks::{TaskPriority, TaskService},
};

use super::{
    AppStorage, decode_compressed_json, encode_compressed_json,
    epub_import::{join_zip_path, normalize_zip_path, parent_zip_path},
    model::{BookReaderSourceMode, ReadingMetrics, ReadingMetricsSection},
    publication::{ArchivePublicationSource, PublicationSource, UnpackedPublicationSource, read_package_document},
};

pub(super) const READING_METRICS_VERSION: u32 = 1;
const READING_METRICS_BYTES_PER_UNIT: u64 = 1_500;

fn reading_units_for_bytes(bytes: u64) -> u64 {
    bytes.div_ceil(READING_METRICS_BYTES_PER_UNIT).max(1)
}

fn reading_metrics_from_lengths(lengths: Vec<(String, u64)>) -> Result<ReadingMetrics, String> {
    let mut total_length = 0u64;
    let mut sections = Vec::with_capacity(lengths.len());

    for (href, length) in lengths {
        let start = total_length;
        total_length = total_length
            .checked_add(length.max(1))
            .ok_or_else(|| "Reading metrics length overflow".to_string())?;
        sections.push(ReadingMetricsSection {
            href,
            start,
            end: total_length,
        });
    }

    Ok(ReadingMetrics {
        version: READING_METRICS_VERSION,
        total_length,
        sections,
    })
}

fn href_without_fragment(href: &str) -> &str {
    href.split_once('#').map(|(path, _)| path).unwrap_or(href)
}

fn reading_metrics_are_valid(metrics: &ReadingMetrics) -> bool {
    if metrics.version != READING_METRICS_VERSION {
        return false;
    }
    let mut expected_start = 0;
    for section in &metrics.sections {
        if section.href.is_empty() || section.start != expected_start || section.end <= section.start {
            return false;
        }
        expected_start = section.end;
    }
    metrics.total_length == expected_start
}

fn reading_metrics_cache_from_bytes(bytes: &[u8]) -> Result<ReadingMetrics, String> {
    let metrics: ReadingMetrics = decode_compressed_json(bytes)?;
    reading_metrics_are_valid(&metrics)
        .then_some(metrics)
        .ok_or_else(|| "Reading metrics cache is invalid".to_string())
}

fn parse_spine_lengths(
    opf: &str,
    opf_dir: &str,
    mut byte_length: impl FnMut(&str) -> Result<u64, String>,
) -> Result<ReadingMetrics, String> {
    let opf_doc = roxmltree::Document::parse(opf).map_err(|error| error.to_string())?;
    let manifest = opf_doc
        .descendants()
        .filter(|node| node.is_element() && node.has_tag_name("item"))
        .filter_map(|node| Some((node.attribute("id")?, node.attribute("href")?)))
        .collect::<HashMap<_, _>>();
    let mut lengths = Vec::new();

    for itemref in opf_doc
        .descendants()
        .filter(|node| node.is_element() && node.has_tag_name("itemref"))
    {
        let Some(href) = itemref.attribute("idref").and_then(|idref| manifest.get(idref)) else {
            continue;
        };
        let normalized_href = normalize_zip_path(href_without_fragment(href).replace('\\', "/"));
        if normalized_href.is_empty() {
            continue;
        }
        let section_path = normalize_zip_path(join_zip_path(opf_dir, &normalized_href));
        let bytes = byte_length(&section_path).unwrap_or_default();
        lengths.push((normalized_href, reading_units_for_bytes(bytes)));
    }

    reading_metrics_from_lengths(lengths)
}

fn build_reading_metrics(source: &mut impl PublicationSource) -> Result<ReadingMetrics, String> {
    let (opf_path, opf) = read_package_document(source)?;
    let opf_dir = parent_zip_path(&opf_path).to_string();
    parse_spine_lengths(&opf, &opf_dir, |path| source.byte_length(path))
}

fn read_reading_metrics_cache(storage: &AppStorage, id: &str, source_revision: u32) -> Result<ReadingMetrics, String> {
    let bytes = fs::read(storage.reading_metrics_cache_path(id, source_revision)).map_err(|error| error.to_string())?;
    reading_metrics_cache_from_bytes(&bytes)
}

fn write_reading_metrics_cache(
    storage: &AppStorage,
    id: &str,
    source_revision: u32,
    metrics: &ReadingMetrics,
) -> Result<(), String> {
    let path = storage.reading_metrics_cache_path(id, source_revision);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, encode_compressed_json(metrics)?).map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|error| error.to_string())
}

pub(super) fn load_or_build_reading_metrics(
    storage: &AppStorage,
    tasks: &TaskService,
    id: &str,
    source_revision: u32,
    mode: BookReaderSourceMode,
    unpacked_dir: Option<&Path>,
) -> Result<ReadingMetrics, String> {
    let started = Instant::now();
    if let Ok(metrics) = read_reading_metrics_cache(storage, id, source_revision) {
        let mut fields = vec![
            ("book", id.to_string()),
            ("cache", "hit".to_string()),
            ("sections", metrics.sections.len().to_string()),
        ];
        fields.extend(tasks.diagnostic_fields());
        diagnostics::record_timing("reading-metrics", started.elapsed(), &fields);
        return Ok(metrics);
    }

    let storage = storage.clone();
    let id = id.to_string();
    let lock_id = id.clone();
    let unpacked_dir = unpacked_dir.map(Path::to_path_buf);
    let metrics = tasks.run_book_exclusive(&lock_id, TaskPriority::Foreground, || {
        if let Ok(metrics) = read_reading_metrics_cache(&storage, &id, source_revision) {
            return Ok(metrics);
        }
        let metrics = match mode {
            BookReaderSourceMode::Opf => build_reading_metrics(&mut UnpackedPublicationSource::new(
                unpacked_dir
                    .as_deref()
                    .ok_or_else(|| "Unpacked book root is missing".to_string())?,
            )),
            BookReaderSourceMode::Epub => {
                let archive = storage.open_archive_resource(&id)?;
                build_reading_metrics(&mut ArchivePublicationSource::new(archive))
            }
        }?;
        write_reading_metrics_cache(&storage, &id, source_revision, &metrics)?;
        Ok(metrics)
    })?;
    let mut fields = vec![
        ("book", id),
        ("cache", "built".to_string()),
        ("sections", metrics.sections.len().to_string()),
    ];
    fields.extend(tasks.diagnostic_fields());
    diagnostics::record_timing("reading-metrics", started.elapsed(), &fields);
    Ok(metrics)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_cumulative_boundaries_in_spine_order() {
        let opf = r#"<package><manifest>
            <item id="second" href="Text/second.xhtml"/>
            <item id="first" href="Text/first.xhtml"/>
          </manifest><spine>
            <itemref idref="first"/><itemref idref="second"/>
          </spine></package>"#;
        let metrics = parse_spine_lengths(opf, "OEBPS", |path| match path {
            "OEBPS/Text/first.xhtml" => Ok(1_500),
            "OEBPS/Text/second.xhtml" => Ok(3_001),
            _ => Err("unexpected spine path".to_string()),
        })
        .unwrap();

        assert_eq!(metrics.total_length, 4);
        assert_eq!(metrics.sections[0].href, "Text/first.xhtml");
        assert_eq!((metrics.sections[0].start, metrics.sections[0].end), (0, 1));
        assert_eq!((metrics.sections[1].start, metrics.sections[1].end), (1, 4));
    }

    #[test]
    fn cumulative_boundaries_are_self_contained_in_the_cache() {
        let metrics = reading_metrics_from_lengths(vec![
            ("chapter-1.xhtml".to_string(), 20),
            ("chapter-2.xhtml".to_string(), 60),
            ("chapter-3.xhtml".to_string(), 20),
        ])
        .unwrap();

        assert_eq!(metrics.total_length, 100);
        assert_eq!(metrics.sections[1].start, 20);
        assert_eq!(metrics.sections[1].end, 80);

        let bytes = encode_compressed_json(&metrics).unwrap();
        assert_eq!(reading_metrics_cache_from_bytes(&bytes).unwrap(), metrics);
        let json = zstd::stream::decode_all(bytes.as_slice()).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&json).unwrap();
        assert_eq!(json["version"], 1);
        assert_eq!(json["totalLength"], 100);
        assert_eq!(json["sections"][1]["start"], 20);
        assert_eq!(json["sections"][1]["end"], 80);
        assert!(json.get("contentVersion").is_none());
    }
}
