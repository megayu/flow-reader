use std::{
    ffi::OsString,
    fs::{File, OpenOptions},
    sync::atomic::{AtomicU64, Ordering},
};

use tauri::{
    State,
    ipc::{InvokeBody, Request},
};

use super::*;

const OUTPUT_PATH_HEADER: &str = "flow-image-output-path";
static DOWNLOAD_TEMP_NONCE: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub async fn download_reader_image(
    storage: State<'_, AppStorage>,
    id: String,
    src: String,
    output_path: String,
) -> Result<bool, String> {
    let storage = (*storage).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let output_path = PathBuf::from(output_path);
        if let Some(resource_path) = archive_resource_path(&id, &src)? {
            let bytes = storage.read_archive_resource(&id, &resource_path)?;
            write_download_bytes(&output_path, &bytes)?;
            return Ok(true);
        }

        if let Some(source_path) = unpacked_resource_path(&storage, &id, &src)? {
            copy_download_file(&source_path, &output_path)?;
            return Ok(true);
        }

        Ok(false)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn write_image_download(request: Request<'_>) -> Result<(), String> {
    let output_path = request
        .headers()
        .get(OUTPUT_PATH_HEADER)
        .ok_or_else(|| "image download path header is missing".to_string())?
        .to_str()
        .map_err(|error| error.to_string())?;
    let output_path = PathBuf::from(percent_decode_path(output_path));
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err("image download requires a binary IPC payload".to_string()),
    };

    tauri::async_runtime::spawn_blocking(move || write_download_bytes(&output_path, &bytes))
        .await
        .map_err(|error| error.to_string())?
}

fn archive_resource_path(id: &str, src: &str) -> Result<Option<String>, String> {
    let Some(resource) = strip_url_origin(src, &["http://epub.localhost/", "epub://localhost/"]) else {
        return Ok(None);
    };
    let (source_id, path) = resource
        .split_once('/')
        .ok_or_else(|| "image URL does not contain an EPUB resource path".to_string())?;
    if source_id != id {
        return Err("image URL belongs to a different book".to_string());
    }
    let path = strip_url_suffix(path);
    if path.is_empty() {
        return Err("image URL does not contain an EPUB resource path".to_string());
    }
    Ok(Some(percent_decode_path(path)))
}

fn unpacked_resource_path(storage: &AppStorage, id: &str, src: &str) -> Result<Option<PathBuf>, String> {
    let Some(encoded_path) = strip_url_origin(src, &["http://asset.localhost/", "asset://localhost/"]) else {
        return Ok(None);
    };
    let source_path = PathBuf::from(percent_decode_path(strip_url_suffix(encoded_path)));
    let unpacked_dir = fs::canonicalize(storage.book_dir(id).join(UNPACKED_DIR)).map_err(|error| error.to_string())?;
    let source_path = fs::canonicalize(source_path).map_err(|error| error.to_string())?;
    if !source_path.starts_with(&unpacked_dir) {
        return Err("image source is outside the open book".to_string());
    }
    if !source_path.is_file() {
        return Err("image source is not a file".to_string());
    }
    Ok(Some(source_path))
}

fn strip_url_origin<'a>(value: &'a str, origins: &[&str]) -> Option<&'a str> {
    origins.iter().find_map(|origin| value.strip_prefix(origin))
}

fn strip_url_suffix(value: &str) -> &str {
    value.split(['?', '#']).next().unwrap_or(value)
}

fn write_download_bytes(output_path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_download_file(output_path, |file| file.write_all(bytes))
}

fn copy_download_file(source_path: &Path, output_path: &Path) -> Result<(), String> {
    let mut source = File::open(source_path).map_err(|error| error.to_string())?;
    write_download_file(output_path, |file| io::copy(&mut source, file).map(|_| ()))
}

fn write_download_file(output_path: &Path, write: impl FnOnce(&mut File) -> io::Result<()>) -> Result<(), String> {
    if !output_path.is_absolute() {
        return Err("image download path must be absolute".to_string());
    }
    let (temp_path, mut temp_file) = create_download_temp(output_path)?;
    let result = (|| {
        write(&mut temp_file).map_err(|error| error.to_string())?;
        temp_file.sync_all().map_err(|error| error.to_string())?;
        drop(temp_file);
        replace_download_file(&temp_path, output_path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn create_download_temp(output_path: &Path) -> Result<(PathBuf, File), String> {
    let parent = output_path
        .parent()
        .ok_or_else(|| "image download path has no parent directory".to_string())?;
    let file_name = output_path
        .file_name()
        .ok_or_else(|| "image download path has no file name".to_string())?;

    for _ in 0..32 {
        let nonce = DOWNLOAD_TEMP_NONCE.fetch_add(1, Ordering::Relaxed);
        let mut temp_name = OsString::from(".");
        temp_name.push(file_name);
        temp_name.push(format!(".flow-reader-{}-{nonce}.tmp", std::process::id()));
        let temp_path = parent.join(temp_name);
        match OpenOptions::new().write(true).create_new(true).open(&temp_path) {
            Ok(file) => return Ok((temp_path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }

    Err("failed to create a unique image download file".to_string())
}

#[cfg(target_os = "windows")]
fn replace_download_file(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW};

    let source = source.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
    let target = target.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn replace_download_file(source: &Path, target: &Path) -> io::Result<()> {
    fs::rename(source, target)
}
