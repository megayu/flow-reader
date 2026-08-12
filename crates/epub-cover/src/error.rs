use std::io;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoverError {
    #[error("invalid EPUB: {0}")]
    InvalidEpub(String),
    #[error("unsafe EPUB archive path: {0}")]
    UnsafePath(String),
    #[error("EPUB entry not found: {0}")]
    EntryNotFound(String),
    #[error("EPUB entry exceeds the supported size limit: {entry} (limit {limit} bytes)")]
    EntryTooLarge { entry: String, limit: u64 },
    #[error("invalid XML in {entry}: {message}")]
    InvalidXml { entry: String, message: String },
    #[error("EPUB XML entry has an invalid or unsupported encoding: {0}")]
    InvalidXmlEncoding(String),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Zip(#[from] zip::result::ZipError),
}
