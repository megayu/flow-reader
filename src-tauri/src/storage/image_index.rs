use std::fs;

use serde::{Deserialize, Serialize};

use super::{AppStorage, LibraryBook, IMAGE_INDEX_CACHE_VERSION, IMAGE_INDEX_EXTRACTOR_VERSION};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageIndexCache {
    pub version: u32,
    pub extractor_version: u32,
    pub book_hash: String,
    pub content_version: u32,
    pub sections: Vec<ImageIndexSection>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageIndexSection {
    pub section_index: usize,
    pub href: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub nav_path: Vec<String>,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageIndexCacheInput {
    pub book_hash: String,
    pub content_version: u32,
    pub sections: Vec<ImageIndexSectionInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageIndexSectionInput {
    pub section_index: usize,
    pub href: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub nav_path: Vec<String>,
    #[serde(default)]
    pub images: Vec<ImageIndexEntryInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageIndexEntryInput {
    pub src: String,
    pub index: usize,
    #[serde(default)]
    pub hidden_by_default: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

pub(super) fn image_index_cache_to_bytes(cache: &ImageIndexCache) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(cache).map_err(|error| error.to_string())?;
    zstd::stream::encode_all(json.as_slice(), 3).map_err(|error| error.to_string())
}

pub(super) fn image_index_cache_from_bytes(bytes: &[u8]) -> Result<ImageIndexCache, String> {
    let json = zstd::stream::decode_all(bytes).map_err(|error| error.to_string())?;
    serde_json::from_slice(&json).map_err(|error| error.to_string())
}

fn image_index_cache_matches_book(cache: &ImageIndexCache, book: &LibraryBook) -> bool {
    cache.version == IMAGE_INDEX_CACHE_VERSION
        && cache.extractor_version == IMAGE_INDEX_EXTRACTOR_VERSION
        && cache.book_hash == book.content_hash
        && cache.content_version == book.content_version
}

fn image_index_input_matches_book(input: &ImageIndexCacheInput, book: &LibraryBook) -> bool {
    input.book_hash == book.content_hash && input.content_version == book.content_version
}

fn image_index_cache_from_input(
    input: ImageIndexCacheInput,
    book: &LibraryBook,
) -> ImageIndexCache {
    ImageIndexCache {
        version: IMAGE_INDEX_CACHE_VERSION,
        extractor_version: IMAGE_INDEX_EXTRACTOR_VERSION,
        book_hash: book.content_hash.clone(),
        content_version: book.content_version,
        sections: input
            .sections
            .into_iter()
            .map(|section| ImageIndexSection {
                section_index: section.section_index,
                href: section.href,
                title: section.title,
                nav_path: section.nav_path,
                images: section
                    .images
                    .into_iter()
                    .map(|image| ImageIndexEntry {
                        src: image.src,
                        index: image.index,
                        hidden_by_default: image.hidden_by_default,
                        reason: image.reason,
                    })
                    .collect(),
            })
            .collect(),
    }
}

pub(super) fn read_image_index_cache(
    storage: &AppStorage,
    book: &LibraryBook,
) -> Result<ImageIndexCache, String> {
    let path = storage.image_index_cache_path(&book.id);
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let cache = image_index_cache_from_bytes(&bytes)?;
    if image_index_cache_matches_book(&cache, book) {
        Ok(cache)
    } else {
        Err("Image index cache is stale".to_string())
    }
}

pub(super) fn write_image_index_cache_if_current(
    storage: &AppStorage,
    id: &str,
    input: ImageIndexCacheInput,
) -> Result<bool, String> {
    let current_book = storage.library_book(id)?;
    if !image_index_input_matches_book(&input, &current_book) {
        return Ok(false);
    }

    let cache = image_index_cache_from_input(input, &current_book);
    let path = storage.image_index_cache_path(id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let bytes = image_index_cache_to_bytes(&cache)?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|error| error.to_string())?;

    let current_book = storage.library_book(id)?;
    if !image_index_cache_matches_book(&cache, &current_book) {
        let _ = fs::remove_file(&tmp);
        return Ok(false);
    }

    fs::rename(&tmp, path).map_err(|error| error.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_index_cache_round_trips_as_zstd_payload() {
        let cache = ImageIndexCache {
            version: IMAGE_INDEX_CACHE_VERSION,
            extractor_version: IMAGE_INDEX_EXTRACTOR_VERSION,
            book_hash: "hash".to_string(),
            content_version: 3,
            sections: vec![ImageIndexSection {
                section_index: 1,
                href: "OEBPS/Text/chapter.xhtml".to_string(),
                title: Some("Chapter".to_string()),
                nav_path: vec!["Part".to_string()],
                images: vec![ImageIndexEntry {
                    src: "../Images/p001.jpg".to_string(),
                    index: 0,
                    hidden_by_default: false,
                    reason: None,
                }],
            }],
        };

        let bytes = image_index_cache_to_bytes(&cache).expect("cache should encode");
        let restored = image_index_cache_from_bytes(&bytes).expect("cache should decode");

        assert_eq!(restored, cache);
    }
}
