//! Shared lookup, file transaction, and deferred-cleanup support for book imports.

use super::*;

const EAGER_IMPORT_ENV: &str = "FLOW_READER_EAGER_IMPORT";

pub(super) fn eager_import_materialization_enabled() -> bool {
    std::env::var(EAGER_IMPORT_ENV)
        .is_ok_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

pub(super) struct LibraryBookLookupIndex {
    names: HashMap<String, usize>,
    hashes: HashMap<String, usize>,
}

impl LibraryBookLookupIndex {
    pub(super) fn load(storage: &AppStorage) -> Result<Self, String> {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let mut names = HashMap::with_capacity(state.library.books.len());
        let mut hashes = HashMap::with_capacity(state.library.books.len());
        for (index, book) in state.library.books.iter().enumerate() {
            names.entry(book.name.clone()).or_insert(index);
            if !book.content_hash.is_empty() {
                hashes.entry(book.content_hash.clone()).or_insert(index);
            }
        }
        Ok(Self { names, hashes })
    }

    pub(super) fn filename_index(&self, books: &[LibraryBook], name: &str) -> Option<usize> {
        self.names
            .get(name)
            .copied()
            .filter(|index| books.get(*index).is_some_and(|book| book.name == name))
            .or_else(|| books.iter().position(|book| book.name == name))
    }

    pub(super) fn hash_index(&self, books: &[LibraryBook], hash: &str) -> Option<usize> {
        self.hashes
            .get(hash)
            .copied()
            .filter(|index| {
                books
                    .get(*index)
                    .is_some_and(|book| !book.content_hash.is_empty() && book.content_hash == hash)
            })
            .or_else(|| {
                books
                    .iter()
                    .position(|book| !book.content_hash.is_empty() && book.content_hash == hash)
            })
    }

    pub(super) fn remember(&mut self, index: usize, book: &LibraryBook) {
        self.names
            .entry(book.name.clone())
            .and_modify(|stored| *stored = (*stored).min(index))
            .or_insert(index);
        if !book.content_hash.is_empty() {
            self.hashes
                .entry(book.content_hash.clone())
                .and_modify(|stored| *stored = (*stored).min(index))
                .or_insert(index);
        }
    }
}

static IMPORT_WORK_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(super) fn import_work_path(root: &Path, prefix: &str, name: &str) -> PathBuf {
    let sequence = IMPORT_WORK_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    root.join(format!(".{prefix}-{}-{sequence}-{name}", std::process::id()))
}

pub(super) struct ImportFileTransaction {
    book_dir: PathBuf,
    book_dir_existed: bool,
    backup_dir: PathBuf,
    moved: Vec<(PathBuf, PathBuf)>,
}

impl ImportFileTransaction {
    pub(super) fn begin(storage: &AppStorage, id: &str) -> Result<Self, String> {
        let book_dir = storage.book_dir(id);
        let book_dir_existed = book_dir.exists();
        fs::create_dir_all(&book_dir).map_err(|error| error.to_string())?;
        let backup_dir = import_work_path(&books_root(storage.root()), "import-backup", id);
        fs::create_dir(&backup_dir).map_err(|error| error.to_string())?;

        let mut targets = [BOOK_FILE, SOURCE_TEXT_FILE, UNPACKED_DIR]
            .into_iter()
            .map(|name| book_dir.join(name))
            .collect::<Vec<_>>();
        let entries = fs::read_dir(&book_dir).map_err(|error| error.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&format!("{COVER_STEM}.")) || is_derived_cache_file_name(name))
            {
                targets.push(entry.path());
            }
        }

        let mut transaction = Self {
            book_dir,
            book_dir_existed,
            backup_dir,
            moved: Vec::new(),
        };
        for target in targets {
            if !target.exists() {
                continue;
            }
            let Some(name) = target.file_name() else {
                continue;
            };
            let backup = transaction.backup_dir.join(name);
            if let Err(error) = fs::rename(&target, &backup) {
                let _ = transaction.rollback();
                return Err(error.to_string());
            }
            transaction.moved.push((backup, target));
        }
        Ok(transaction)
    }

    fn commit(self, pending_deletes: &mut Vec<PathBuf>) -> Result<(), String> {
        if self.moved.is_empty() {
            fs::remove_dir(self.backup_dir).map_err(|error| error.to_string())?;
            return Ok(());
        }

        if let Some(path) = deletion::rename_path_for_deletion(&self.backup_dir)? {
            pending_deletes.push(path);
        }
        Ok(())
    }

    pub(super) fn rollback(self) -> Result<(), String> {
        let mut first_error = None;
        let mut current_targets = [BOOK_FILE, SOURCE_TEXT_FILE, UNPACKED_DIR]
            .into_iter()
            .map(|name| self.book_dir.join(name))
            .collect::<Vec<_>>();
        if let Ok(entries) = fs::read_dir(&self.book_dir) {
            for entry in entries.flatten() {
                if entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with(&format!("{COVER_STEM}.")) || is_derived_cache_file_name(name))
                {
                    current_targets.push(entry.path());
                }
            }
        }
        for target in current_targets {
            if let Err(error) = remove_import_artifact(&target)
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        for (backup, target) in self.moved {
            if let Err(error) = fs::rename(backup, target).map_err(|error| error.to_string())
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        if let Err(error) = fs::remove_dir_all(self.backup_dir).map_err(|error| error.to_string())
            && first_error.is_none()
        {
            first_error = Some(error);
        }
        if !self.book_dir_existed
            && let Err(error) = fs::remove_dir(&self.book_dir).map_err(|error| error.to_string())
            && first_error.is_none()
        {
            first_error = Some(error);
        }
        first_error.map_or(Ok(()), Err)
    }
}

pub(super) struct ImportFinalizer {
    transaction: Option<ImportFileTransaction>,
    cleanup_paths: Vec<PathBuf>,
}

impl ImportFinalizer {
    pub(super) fn new(transaction: Option<ImportFileTransaction>) -> Self {
        Self {
            transaction,
            cleanup_paths: Vec::new(),
        }
    }

    pub(super) fn with_cleanup_path(mut self, path: PathBuf) -> Self {
        self.cleanup_paths.push(path);
        self
    }

    pub(super) fn finalize(self, pending_deletes: &mut Vec<PathBuf>) -> Result<(), String> {
        if let Some(transaction) = self.transaction {
            transaction.commit(pending_deletes)?;
        }
        for path in self.cleanup_paths {
            if let Some(path) = deletion::rename_path_for_deletion(&path)? {
                pending_deletes.push(path);
            }
        }
        Ok(())
    }
}

fn remove_import_artifact(path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}
