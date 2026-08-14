use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::commands::{clean_tag_name, next_tag_id};
use super::*;

const IGNORED_DIRECTORY_NAMES: &[&str] = &[
    ".git",
    "__MACOSX",
    "$RECYCLE.BIN",
    "System Volume Information",
    ".Spotlight-V100",
    ".Trashes",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderImportCandidate {
    path: String,
    format: BookSourceFormat,
    root_directory: Option<String>,
    intermediate_directories: Vec<String>,
    direct_directory: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderImportTagAssignment {
    pub(super) book_id: String,
    pub(super) tag_names: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderImportTagResult {
    pub(super) books: Vec<BookRecord>,
    pub(super) tags: Vec<LibraryTagRecord>,
}

fn directory_name(path: &Path) -> Option<String> {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
}

fn ignored_directory(path: &Path) -> bool {
    directory_name(path).is_some_and(|name| {
        IGNORED_DIRECTORY_NAMES
            .iter()
            .any(|ignored| name.eq_ignore_ascii_case(ignored))
    })
}

fn link_like_directory(path: &Path, file_type: fs::FileType) -> bool {
    if file_type.is_symlink() {
        return true;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        fs::symlink_metadata(path)
            .map(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
            .unwrap_or(true)
    }

    #[cfg(not(windows))]
    false
}

fn entry_sort_key(path: &Path) -> (String, String) {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    (name.to_lowercase(), name)
}

fn scan_import_folder_impl(root: PathBuf, recursive: bool) -> Result<Vec<FolderImportCandidate>, String> {
    if !root.is_dir() {
        return Err("Selected import path is not a directory".to_string());
    }
    if ignored_directory(&root) {
        return Ok(Vec::new());
    }

    let root_directory = directory_name(&root);
    let mut directories = VecDeque::from([(root.clone(), Vec::<String>::new())]);
    let mut candidates = Vec::new();

    while let Some((directory, relative_directories)) = directories.pop_front() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if directory == root => return Err(error.to_string()),
            Err(_) => continue,
        };
        let mut paths = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        paths.sort_by_key(|path| entry_sort_key(path));

        for path in paths {
            let file_type = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata.file_type(),
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if !recursive || ignored_directory(&path) || link_like_directory(&path, file_type) {
                    continue;
                }
                let Some(name) = directory_name(&path) else {
                    continue;
                };
                let mut child_directories = relative_directories.clone();
                child_directories.push(name);
                directories.push_back((path, child_directories));
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            let format = if is_epub_file(&path) {
                Some(BookSourceFormat::Epub)
            } else if is_txt_file(&path) {
                Some(BookSourceFormat::Txt)
            } else {
                None
            };
            let Some(format) = format else {
                continue;
            };

            let direct_directory = relative_directories.last().cloned().or_else(|| root_directory.clone());
            let intermediate_directories = relative_directories
                .get(..relative_directories.len().saturating_sub(1))
                .unwrap_or_default()
                .to_vec();
            candidates.push(FolderImportCandidate {
                path: path_to_client_string(&path),
                format,
                root_directory: root_directory.clone(),
                intermediate_directories,
                direct_directory,
            });
        }
    }

    Ok(candidates)
}

#[tauri::command]
pub async fn scan_import_folder(root: String, recursive: bool) -> Result<Vec<FolderImportCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_import_folder_impl(PathBuf::from(root), recursive))
        .await
        .map_err(|error| error.to_string())?
}

pub(super) fn apply_folder_import_tags_impl(
    storage: &AppStorage,
    assignments: Vec<FolderImportTagAssignment>,
) -> Result<FolderImportTagResult, String> {
    let mut changed = false;
    let assignment_book_ids = assignments
        .iter()
        .map(|assignment| assignment.book_id.clone())
        .collect::<HashSet<String>>();
    let (books, tags) = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;

        let book_indices = state
            .library
            .books
            .iter()
            .enumerate()
            .filter(|(_, book)| book.scope == BookScope::Library)
            .map(|(index, book)| (book.id.clone(), index))
            .collect::<HashMap<_, _>>();
        let mut tag_ids_by_name = state
            .library
            .tags
            .iter()
            .map(|tag| (tag.name.to_ascii_lowercase(), tag.id.clone()))
            .collect::<HashMap<_, _>>();

        let updated_at = now_ms();
        for assignment in assignments {
            let Some(&book_index) = book_indices.get(&assignment.book_id) else {
                continue;
            };

            let mut resolved_tag_ids = Vec::new();
            let mut seen_names = HashSet::new();
            for raw_name in assignment.tag_names {
                let name = clean_tag_name(&raw_name);
                let normalized_name = name.to_ascii_lowercase();
                if name.is_empty() || !seen_names.insert(normalized_name.clone()) {
                    continue;
                }

                let tag_id = if let Some(tag_id) = tag_ids_by_name.get(&normalized_name) {
                    tag_id.clone()
                } else {
                    let created_at = now_ms();
                    let id = next_tag_id(&state.library.tags, created_at);
                    state.library.tags.push(LibraryTagRecord {
                        id: id.clone(),
                        name,
                        created_at,
                        updated_at: None,
                    });
                    tag_ids_by_name.insert(normalized_name, id.clone());
                    changed = true;
                    id
                };
                if !resolved_tag_ids.contains(&tag_id) {
                    resolved_tag_ids.push(tag_id);
                }
            }

            let book = &mut state.library.books[book_index];
            let mut book_changed = false;
            for tag_id in resolved_tag_ids {
                if !book.tag_ids.contains(&tag_id) {
                    book.tag_ids.push(tag_id);
                    changed = true;
                    book_changed = true;
                }
            }
            if book_changed {
                book.updated_at = Some(updated_at);
            }
        }

        let books = state
            .library
            .books
            .iter()
            .filter(|book| book.scope == BookScope::Library && assignment_book_ids.contains(book.id.as_str()))
            .map(|book| storage.compose_book_summary(book))
            .collect();
        (books, state.library.tags.clone())
    };

    if changed {
        storage.mark_library_dirty();
        storage.flush_content_dirty()?;
    }
    Ok(FolderImportTagResult { books, tags })
}

#[tauri::command]
pub fn apply_folder_import_tags(
    storage: State<'_, AppStorage>,
    assignments: Vec<FolderImportTagAssignment>,
) -> Result<FolderImportTagResult, String> {
    apply_folder_import_tags_impl(&storage, assignments)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_supported_files_with_folder_roles_and_ignores_blacklisted_directories() {
        let root = std::env::temp_dir().join(format!("flow-reader-folder-import-{}-{}", std::process::id(), now_ms()));
        fs::create_dir_all(root.join("Tech").join("Rust")).unwrap();
        fs::create_dir_all(root.join("__MACOSX")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("top.EPUB"), []).unwrap();
        fs::write(root.join("Tech").join("Rust").join("nested.txt"), []).unwrap();
        fs::write(root.join("Tech").join("Rust").join("notes.pdf"), []).unwrap();
        fs::write(root.join("__MACOSX").join("ignored.epub"), []).unwrap();
        fs::write(root.join(".git").join("ignored.txt"), []).unwrap();

        let root_name = directory_name(&root).unwrap();
        let direct = scan_import_folder_impl(root.clone(), false).unwrap();
        assert_eq!(direct.len(), 1);
        assert_eq!(direct[0].format, BookSourceFormat::Epub);
        assert_eq!(direct[0].root_directory.as_deref(), Some(root_name.as_str()));
        assert!(direct[0].intermediate_directories.is_empty());
        assert_eq!(direct[0].direct_directory.as_deref(), Some(root_name.as_str()));

        let recursive = scan_import_folder_impl(root.clone(), true).unwrap();
        assert_eq!(recursive.len(), 2);
        let nested = recursive
            .iter()
            .find(|candidate| candidate.path.ends_with("/Tech/Rust/nested.txt"))
            .unwrap();
        assert_eq!(nested.format, BookSourceFormat::Txt);
        assert_eq!(nested.root_directory.as_deref(), Some(root_name.as_str()));
        assert_eq!(nested.intermediate_directories, ["Tech"]);
        assert_eq!(nested.direct_directory.as_deref(), Some("Rust"));
        assert!(recursive.iter().all(|candidate| !candidate.path.contains("__MACOSX")));
        assert!(recursive.iter().all(|candidate| !candidate.path.contains("/.git/")));

        fs::remove_dir_all(root).unwrap();
    }
}
