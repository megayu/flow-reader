use super::*;

pub(super) fn delete_books_to_tombstones(
    storage: &AppStorage,
    ids: &[String],
) -> Result<Vec<PathBuf>, String> {
    let ids = ids
        .iter()
        .filter(|id| !id.is_empty())
        .cloned()
        .collect::<HashSet<_>>();

    if ids.is_empty() {
        return Ok(Vec::new());
    }

    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        state.library.books.retain(|book| !ids.contains(&book.id));
        for id in &ids {
            state.book_states.remove(id);
        }
    }
    storage.mark_library_dirty();

    let mut tombstones = Vec::new();
    for id in &ids {
        storage.unload_search_text_cache(id);
        if let Some(tombstone) = move_book_dir_to_tombstone(storage, id) {
            tombstones.push(tombstone);
        }
    }

    Ok(tombstones)
}

fn move_book_dir_to_tombstone(storage: &AppStorage, id: &str) -> Option<PathBuf> {
    let book_dir = storage.book_dir(id);
    if !book_dir.exists() {
        return None;
    }

    let tombstones_root = delete_tombstones_root(storage.root());
    if let Err(error) = fs::create_dir_all(&tombstones_root) {
        eprintln!("Failed to prepare deleted book tombstone directory: {error}");
        remove_book_dir_directly(&book_dir);
        return None;
    }
    let tombstone = next_delete_tombstone_path(&tombstones_root, id);

    match fs::rename(&book_dir, &tombstone) {
        Ok(()) => Some(tombstone),
        Err(error) => {
            eprintln!("Failed to move deleted book directory to tombstone: {error}");
            remove_book_dir_directly(&book_dir);
            None
        }
    }
}

fn remove_book_dir_directly(book_dir: &Path) {
    if let Err(error) = fs::remove_dir_all(book_dir) {
        eprintln!("Failed to delete book directory: {error}");
    }
}

fn next_delete_tombstone_path(root: &Path, id: &str) -> PathBuf {
    let stamp = now_ms();
    let pid = std::process::id();
    let id = sanitize_tombstone_name(id);
    for index in 0.. {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!("-{index}")
        };
        let path = root.join(format!("{id}-{pid}-{stamp}{suffix}"));
        if !path.exists() {
            return path;
        }
    }

    unreachable!("tombstone path loop should return")
}

fn sanitize_tombstone_name(value: &str) -> String {
    let name = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();

    if name.is_empty() {
        "book".to_string()
    } else {
        name
    }
}

#[cfg(test)]
pub(super) fn cleanup_delete_tombstones(storage: &AppStorage) -> Result<(), String> {
    let tombstones = list_delete_tombstones(storage)?;
    for tombstone in tombstones {
        cleanup_delete_tombstone_path(&tombstone)?;
    }

    let root = delete_tombstones_root(storage.root());
    if root.exists() {
        let is_empty = fs::read_dir(&root)
            .map_err(|error| error.to_string())?
            .next()
            .is_none();
        if is_empty {
            fs::remove_dir(&root).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn list_delete_tombstones(storage: &AppStorage) -> Result<Vec<PathBuf>, String> {
    let root = delete_tombstones_root(storage.root());
    if !root.exists() {
        return Ok(Vec::new());
    }

    fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .map(|entry| {
            entry
                .map(|entry| entry.path())
                .map_err(|error| error.to_string())
        })
        .collect()
}

fn cleanup_delete_tombstone_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

fn enqueue_delete_tombstone_cleanup(tasks: &TaskService, tombstones: Vec<PathBuf>) {
    if tombstones.is_empty() {
        return;
    }

    let tasks = tasks.clone();
    std::thread::spawn(move || {
        for tombstone in tombstones {
            let key = TaskKey::new(
                TaskKind::TombstoneCleanup,
                tombstone.to_string_lossy().into_owned(),
            );
            let runner = tasks.clone();
            let cleanup_path = tombstone.clone();
            if let Err(error) = tasks.get_or_run(key, TaskPriority::Background, move || {
                runner.run_background(|| cleanup_delete_tombstone_path(&cleanup_path))
            }) {
                eprintln!("Failed to cleanup deleted book tombstone: {error}");
            }
        }
    });
}

pub(super) fn delete_books_impl(
    storage: &AppStorage,
    tasks: &TaskService,
    ids: Vec<String>,
) -> Result<(), String> {
    let started = Instant::now();
    let source_count = ids.len();
    let tombstones = delete_books_to_tombstones(storage, &ids)?;
    let tombstone_count = tombstones.len();
    storage.flush_dirty()?;
    enqueue_delete_tombstone_cleanup(tasks, tombstones);
    let mut fields = vec![
        ("sources", source_count.to_string()),
        ("tombstones", tombstone_count.to_string()),
        (
            "search_memory_caches",
            storage.search_text_memory_cache_len().to_string(),
        ),
    ];
    fields.extend(tasks.diagnostic_fields());
    diagnostics::record_timing("delete-books", started.elapsed(), &fields);
    Ok(())
}

pub(super) fn cleanup_external_book_heavy_files(
    storage: &AppStorage,
    id: &str,
) -> Result<(), String> {
    if !is_external_book_id(id) {
        return Ok(());
    }

    storage.unload_search_text_cache(id);
    let dir = storage.external_book_dir(id);
    for path in [
        dir.join(BOOK_FILE),
        dir.join(SEARCH_TEXT_CACHE_FILE),
        dir.join(IMAGE_INDEX_CACHE_FILE),
    ] {
        if path.exists() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }

    let unpacked_dir = dir.join(UNPACKED_DIR);
    if unpacked_dir.exists() {
        fs::remove_dir_all(unpacked_dir).map_err(|error| error.to_string())?;
    }
    remove_cover_files(storage, id)?;
    Ok(())
}

pub fn cleanup_all_external_book_heavy_files(storage: &AppStorage) -> Result<(), String> {
    let ids = {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        state
            .external
            .books
            .iter()
            .map(|book| book.id.clone())
            .collect::<Vec<_>>()
    };

    for id in ids {
        cleanup_external_book_heavy_files(storage, &id)?;
    }
    Ok(())
}

pub fn schedule_existing_delete_tombstone_cleanup(storage: &AppStorage, tasks: &TaskService) {
    match list_delete_tombstones(storage) {
        Ok(tombstones) => enqueue_delete_tombstone_cleanup(tasks, tombstones),
        Err(error) => eprintln!("Failed to list deleted book tombstones: {error}"),
    }
}
