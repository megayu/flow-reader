use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
    sync::Arc,
};

use zip::{ZipArchive, read::ZipArchiveMetadata};

use super::{
    AppStorage,
    export::zip_path_candidates,
    publication::{ArchivePublicationSource, read_package_document},
};

#[derive(Clone)]
pub(super) struct PositionedFile {
    file: Arc<File>,
    len: u64,
    position: u64,
}

impl PositionedFile {
    fn open(path: &Path) -> io::Result<Self> {
        let file = Arc::new(File::open(path)?);
        let len = file.metadata()?.len();
        Ok(Self { file, len, position: 0 })
    }
}

impl Read for PositionedFile {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = read_file_at(&self.file, buffer, self.position)?;
        self.position += read as u64;
        Ok(read)
    }
}

impl Seek for PositionedFile {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let position = match position {
            SeekFrom::Start(position) => i128::from(position),
            SeekFrom::End(offset) => i128::from(self.len) + i128::from(offset),
            SeekFrom::Current(offset) => i128::from(self.position) + i128::from(offset),
        };
        if !(0..=i128::from(u64::MAX)).contains(&position) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid seek"));
        }
        self.position = position as u64;
        Ok(self.position)
    }
}

#[cfg(windows)]
fn read_file_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buffer, offset)
}

#[cfg(unix)]
fn read_file_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buffer, offset)
}

#[derive(Clone)]
pub(super) struct ArchiveResourceSession {
    reader: PositionedFile,
    metadata: Arc<ZipArchiveMetadata>,
}

pub(super) struct ArchiveResourceUrls {
    pub(super) package: String,
    pub(super) root: String,
}

impl AppStorage {
    pub(super) fn register_archive_resource(&self, book_id: &str, path: &Path) -> Result<ArchiveResourceUrls, String> {
        let reader = PositionedFile::open(path).map_err(|error| error.to_string())?;
        let archive = ZipArchive::new(reader.clone()).map_err(|error| error.to_string())?;
        let metadata = archive.metadata();
        let (package_path, _) = read_package_document(&mut ArchivePublicationSource::new(archive))?;
        let session = ArchiveResourceSession { reader, metadata };
        self.inner
            .archive_resources
            .lock()
            .map_err(|_| "archive resource state lock poisoned".to_string())?
            .insert(book_id.to_string(), session);

        let root = archive_resource_root_url(book_id);
        Ok(ArchiveResourceUrls {
            package: format!("{root}{}", percent_encode_path(&package_path)),
            root,
        })
    }

    pub(super) fn read_archive_resource(&self, book_id: &str, path: &str) -> Result<Vec<u8>, String> {
        let mut archive = self.open_archive_resource(book_id)?;
        let mut last_error = "EPUB entry not found".to_string();
        for candidate in zip_path_candidates(path) {
            match archive.by_name(&candidate) {
                Ok(mut entry) => {
                    let mut bytes = Vec::with_capacity(entry.size().try_into().unwrap_or_default());
                    entry.read_to_end(&mut bytes).map_err(|error| error.to_string())?;
                    return Ok(bytes);
                }
                Err(error) => last_error = error.to_string(),
            }
        }
        Err(last_error)
    }

    pub(super) fn open_archive_resource(&self, book_id: &str) -> Result<ZipArchive<PositionedFile>, String> {
        let session = self
            .inner
            .archive_resources
            .lock()
            .map_err(|_| "archive resource state lock poisoned".to_string())?
            .get(book_id)
            .cloned()
            .ok_or_else(|| "EPUB reader source is no longer open".to_string())?;
        // SAFETY: Both the metadata and every positioned reader retain the same
        // open file handle owned by this reader session.
        Ok(unsafe { ZipArchive::unsafe_new_with_metadata(session.reader, session.metadata) })
    }

    pub(super) fn release_archive_resource(&self, book_id: &str) {
        if let Ok(mut sessions) = self.inner.archive_resources.lock() {
            sessions.remove(book_id);
        }
    }
}

pub fn archive_resource_protocol_response<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::Manager;

    let result = request
        .uri()
        .path()
        .trim_start_matches('/')
        .split_once('/')
        .ok_or_else(|| "Invalid EPUB resource path".to_string())
        .and_then(|(book_id, path)| {
            let path = super::export::percent_decode_path(path);
            app.state::<AppStorage>()
                .read_archive_resource(book_id, &path)
                .map(|bytes| (bytes, archive_resource_mime_type(&path)))
        });

    match result {
        Ok((bytes, mime_type)) => tauri::http::Response::builder()
            .status(200)
            .header("Access-Control-Allow-Origin", "*")
            .header("Content-Type", mime_type)
            .body(bytes)
            .unwrap(),
        Err(error) => tauri::http::Response::builder()
            .status(404)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(error.into_bytes())
            .unwrap(),
    }
}

fn archive_resource_root_url(book_id: &str) -> String {
    #[cfg(any(windows, target_os = "android"))]
    let origin = "http://epub.localhost";
    #[cfg(not(any(windows, target_os = "android")))]
    let origin = "epub://localhost";
    format!("{origin}/{book_id}/")
}

fn percent_encode_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn archive_resource_mime_type(path: &str) -> &'static str {
    match path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
    {
        Some(extension) => match extension.as_str() {
            "xhtml" | "xht" => "application/xhtml+xml",
            "html" | "htm" => "text/html; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "xml" | "opf" | "ncx" => "application/xml",
            "js" | "mjs" => "text/javascript; charset=utf-8",
            "json" => "application/json",
            "smil" => "application/smil+xml",
            "txt" => "text/plain; charset=utf-8",
            "vtt" => "text/vtt; charset=utf-8",
            "svg" | "svgz" => "image/svg+xml",
            "jpg" | "jpeg" | "jpe" => "image/jpeg",
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "avif" => "image/avif",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            "tif" | "tiff" => "image/tiff",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            "ttf" => "font/ttf",
            "otf" => "font/otf",
            "eot" => "application/vnd.ms-fontobject",
            "mp3" => "audio/mpeg",
            "m4a" => "audio/mp4",
            "ogg" | "opus" => "audio/ogg",
            "aac" => "audio/aac",
            "flac" => "audio/flac",
            "wav" => "audio/wav",
            "mp4" | "m4v" => "video/mp4",
            "ogv" => "video/ogg",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            "pdf" => "application/pdf",
            _ => "application/octet-stream",
        },
        None => "application/octet-stream",
    }
}
