use std::io::{Read, Seek};

use zip::ZipArchive;

use crate::{CoverError, path};

const EPUB_XML_READ_LIMIT: u64 = 8 * 1024 * 1024;
pub(crate) const EPUB_COVER_READ_LIMIT: u64 = 64 * 1024 * 1024;

pub(crate) fn read_xml_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    requested_path: &str,
) -> Result<(String, String), CoverError> {
    let (bytes, archive_path) = read_entry(archive, requested_path, EPUB_XML_READ_LIMIT)?;
    let text = decode_xml(bytes, &archive_path)?;
    Ok((text, archive_path))
}

fn decode_xml(bytes: Vec<u8>, entry: &str) -> Result<String, CoverError> {
    let invalid_encoding = || CoverError::InvalidXmlEncoding(entry.to_string());
    if let Some(bytes) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8(bytes.to_vec()).map_err(|_| invalid_encoding());
    }

    let (bytes, little_endian) = if let Some(bytes) = bytes.strip_prefix(&[0xff, 0xfe]) {
        (bytes, true)
    } else if let Some(bytes) = bytes.strip_prefix(&[0xfe, 0xff]) {
        (bytes, false)
    } else {
        return String::from_utf8(bytes).map_err(|_| invalid_encoding());
    };
    if bytes.len() % 2 != 0 {
        return Err(invalid_encoding());
    }
    let code_units = bytes
        .chunks_exact(2)
        .map(|bytes| {
            if little_endian {
                u16::from_le_bytes([bytes[0], bytes[1]])
            } else {
                u16::from_be_bytes([bytes[0], bytes[1]])
            }
        })
        .collect::<Vec<_>>();
    String::from_utf16(&code_units).map_err(|_| invalid_encoding())
}

pub(crate) fn read_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    requested_path: &str,
    limit: u64,
) -> Result<(Vec<u8>, String), CoverError> {
    let (raw_name, archive_path) = find_entry(archive, requested_path)?;
    let entry = archive.by_name(&raw_name)?;
    let bytes = read_bounded_bytes(entry, limit, archive_path.clone())?;
    Ok((bytes, archive_path))
}

pub(crate) fn read_bounded_bytes(
    reader: impl Read,
    limit: u64,
    entry: String,
) -> Result<Vec<u8>, CoverError> {
    let mut bytes =
        Vec::with_capacity(usize::try_from(limit.min(1024 * 1024)).unwrap_or(1024 * 1024));
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(CoverError::EntryTooLarge { entry, limit });
    }
    Ok(bytes)
}

fn find_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    requested_path: &str,
) -> Result<(String, String), CoverError> {
    let candidates = path::lookup_candidates(requested_path)?;

    for candidate in &candidates {
        if archive.by_name(candidate).is_ok() {
            return Ok((candidate.clone(), candidate.clone()));
        }
    }

    for index in 0..archive.len() {
        let raw_name = archive.by_index(index)?.name().to_string();
        let normalized_name = match path::lookup_candidates(&raw_name) {
            Ok(mut names) => names.remove(0),
            Err(_) => continue,
        };
        if candidates
            .iter()
            .any(|candidate| normalized_name.eq_ignore_ascii_case(candidate))
        {
            return Ok((raw_name, normalized_name));
        }
    }

    Err(CoverError::EntryNotFound(requested_path.to_string()))
}
