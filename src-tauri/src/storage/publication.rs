use std::{
    fs,
    io::{Read, Seek},
    path::{Component, Path, PathBuf},
};

use zip::ZipArchive;

use super::{
    epub_import::{
        access::{EPUB_SEARCH_DOCUMENT_READ_LIMIT, EPUB_XML_READ_LIMIT, read_bounded_bytes},
        normalize_zip_path,
    },
    export::{percent_decode_path, zip_path_candidates},
    text_import::decode_text_bytes,
};

pub(super) trait PublicationSource {
    fn read_bytes(&mut self, path: &str, limit: u64, description: &str) -> Result<Vec<u8>, String>;
    fn byte_length(&mut self, path: &str) -> Result<u64, String>;

    fn read_xml(&mut self, path: &str) -> Result<String, String> {
        self.read_bytes(path, EPUB_XML_READ_LIMIT, "EPUB XML entry")
            .map(decode_publication_text)
    }

    fn read_document(&mut self, path: &str) -> Result<String, String> {
        let bytes = self.read_bytes(path, EPUB_SEARCH_DOCUMENT_READ_LIMIT, "EPUB derived-cache document")?;
        Ok(decode_publication_text(bytes))
    }
}

fn decode_publication_text(bytes: Vec<u8>) -> String {
    match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => decode_text_bytes(error.as_bytes(), None).text,
    }
}

pub(super) struct UnpackedPublicationSource<'a> {
    root: &'a Path,
}

impl<'a> UnpackedPublicationSource<'a> {
    pub(super) fn new(root: &'a Path) -> Self {
        Self { root }
    }
}

impl PublicationSource for UnpackedPublicationSource<'_> {
    fn read_bytes(&mut self, path: &str, limit: u64, description: &str) -> Result<Vec<u8>, String> {
        let file =
            fs::File::open(resolve_unpacked_publication_path(self.root, path)?).map_err(|error| error.to_string())?;
        read_bounded_bytes(file, limit, description)
    }

    fn byte_length(&mut self, path: &str) -> Result<u64, String> {
        fs::metadata(resolve_unpacked_publication_path(self.root, path)?)
            .map(|metadata| metadata.len())
            .map_err(|error| error.to_string())
    }
}

pub(super) struct ArchivePublicationSource<R: Read + Seek> {
    archive: ZipArchive<R>,
}

impl<R: Read + Seek> ArchivePublicationSource<R> {
    pub(super) fn new(archive: ZipArchive<R>) -> Self {
        Self { archive }
    }
}

impl<R: Read + Seek> PublicationSource for ArchivePublicationSource<R> {
    fn read_bytes(&mut self, path: &str, limit: u64, description: &str) -> Result<Vec<u8>, String> {
        let mut last_error = "EPUB entry not found".to_string();
        for candidate in zip_path_candidates(path) {
            match self.archive.by_name(&candidate) {
                Ok(file) => return read_bounded_bytes(file, limit, description),
                Err(error) => last_error = error.to_string(),
            }
        }
        Err(last_error)
    }

    fn byte_length(&mut self, path: &str) -> Result<u64, String> {
        let mut last_error = "EPUB entry not found".to_string();
        for candidate in zip_path_candidates(path) {
            match self.archive.by_name(&candidate) {
                Ok(entry) => return Ok(entry.size()),
                Err(error) => last_error = error.to_string(),
            }
        }
        Err(last_error)
    }
}

pub(super) fn read_package_document(source: &mut impl PublicationSource) -> Result<(String, String), String> {
    let container = source.read_xml("META-INF/container.xml")?;
    let container_doc = roxmltree::Document::parse(&container).map_err(|error| error.to_string())?;
    let opf_path = container_doc
        .descendants()
        .find(|node| node.has_tag_name("rootfile"))
        .and_then(|node| node.attribute("full-path"))
        .map(|path| normalize_zip_path(path.replace('\\', "/")))
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "EPUB container has no rootfile".to_string())?;
    let opf = source.read_xml(&opf_path)?;
    Ok((opf_path, opf))
}

fn resolve_unpacked_publication_path(root: &Path, href: &str) -> Result<PathBuf, String> {
    let decoded = percent_decode_path(&href.replace('\\', "/")).replace('\\', "/");
    if decoded.is_empty() || decoded.contains('%') {
        return Err("EPUB derived resource has an invalid encoded path".to_string());
    }

    let relative = Path::new(&decoded);
    if relative.components().any(|component| {
        matches!(
            component,
            Component::Prefix(_) | Component::RootDir | Component::ParentDir
        )
    }) {
        return Err("EPUB derived resource path escapes the unpacked book".to_string());
    }

    // Extraction creates only regular entries from enclosed ZIP paths, so repeating
    // filesystem canonicalization for every spine document adds no containment guarantee.
    Ok(root.join(relative))
}
