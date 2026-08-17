//! Shared lookup, file transaction, and deferred-cleanup support for book imports.

use super::*;

const EAGER_IMPORT_ENV: &str = "FLOW_READER_EAGER_IMPORT";

pub(super) fn eager_import_materialization_enabled() -> bool {
    std::env::var(EAGER_IMPORT_ENV)
        .is_ok_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

pub(super) struct BookImportLookupIndex {
    source_paths: HashMap<String, usize>,
    hashes: HashMap<String, usize>,
    export_hashes: HashMap<String, usize>,
    ids: HashMap<String, usize>,
    book_keys: Vec<Option<LibraryBookLookupKeys>>,
    external_books: HashMap<String, StoredBook>,
}

struct LibraryBookLookupKeys {
    source_path: String,
    hash: Option<String>,
    export_hash: Option<String>,
}

fn latest_export_hash_for_import_identity(book: &StoredBook) -> Option<&str> {
    (book.revision > book.source_revision
        && book.latest_export_revision == Some(book.revision)
        && (book.source_format == BookSourceFormat::Epub
            || (book.source_format == BookSourceFormat::Txt && book.source_storage == SourceStorage::Managed)))
        .then_some(book.latest_export_hash.as_deref())
        .flatten()
}

fn source_path_key(path: &Path) -> String {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let key = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) { key.to_lowercase() } else { key }
}

pub(super) fn same_source_path(left: &Path, right: &Path) -> bool {
    source_path_key(left) == source_path_key(right)
}

impl BookImportLookupIndex {
    pub(super) fn load(storage: &AppStorage) -> Result<Self, String> {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let mut source_paths = HashMap::with_capacity(state.library.books.len());
        let mut hashes = HashMap::with_capacity(state.library.books.len());
        let mut export_hashes = HashMap::with_capacity(state.library.books.len());
        let mut ids = HashMap::with_capacity(state.library.books.len());
        let mut book_keys = Vec::with_capacity(state.library.books.len());
        let mut external_books = HashMap::new();
        for (index, book) in state.library.books.iter().enumerate() {
            if book.scope == BookScope::External {
                if !book.source_hash.is_empty() {
                    external_books.insert(book.source_hash.clone(), book.clone());
                }
                book_keys.push(None);
                continue;
            }
            let source_path = source_path_key(&book.source_path);
            source_paths.entry(source_path.clone()).or_insert(index);
            if !book.source_hash.is_empty() {
                hashes.entry(book.source_hash.clone()).or_insert(index);
            }
            if let Some(hash) = latest_export_hash_for_import_identity(book) {
                export_hashes.entry(hash.to_string()).or_insert(index);
            }
            ids.entry(book.id.clone()).or_insert(index);
            book_keys.push(Some(LibraryBookLookupKeys {
                source_path,
                hash: (!book.source_hash.is_empty()).then(|| book.source_hash.clone()),
                export_hash: latest_export_hash_for_import_identity(book).map(str::to_string),
            }));
        }
        Ok(Self {
            source_paths,
            hashes,
            export_hashes,
            ids,
            book_keys,
            external_books,
        })
    }

    pub(super) fn source_path_index(&self, books: &[StoredBook], path: &Path) -> Option<usize> {
        self.source_paths
            .get(&source_path_key(path))
            .copied()
            .filter(|index| {
                books
                    .get(*index)
                    .is_some_and(|book| book.scope == BookScope::Library && same_source_path(&book.source_path, path))
            })
            .or_else(|| {
                books
                    .iter()
                    .position(|book| book.scope == BookScope::Library && same_source_path(&book.source_path, path))
            })
    }

    pub(super) fn hash_index(&self, books: &[StoredBook], hash: &str) -> Option<usize> {
        self.hashes
            .get(hash)
            .copied()
            .filter(|index| {
                books.get(*index).is_some_and(|book| {
                    book.scope == BookScope::Library && !book.source_hash.is_empty() && book.source_hash == hash
                })
            })
            .or_else(|| {
                books.iter().position(|book| {
                    book.scope == BookScope::Library && !book.source_hash.is_empty() && book.source_hash == hash
                })
            })
    }

    pub(super) fn id_index(&self, books: &[StoredBook], hash: &str) -> Option<usize> {
        let id = id_from_hash(hash);
        self.ids
            .get(&id)
            .copied()
            .filter(|index| {
                books
                    .get(*index)
                    .is_some_and(|book| book.scope == BookScope::Library && book.id == id)
            })
            .or_else(|| {
                books
                    .iter()
                    .position(|book| book.scope == BookScope::Library && book.id == id)
            })
    }

    pub(super) fn export_hash_index(&self, books: &[StoredBook], hash: &str) -> Option<usize> {
        self.export_hashes
            .get(hash)
            .copied()
            .filter(|index| {
                books.get(*index).is_some_and(|book| {
                    book.scope == BookScope::Library && latest_export_hash_for_import_identity(book) == Some(hash)
                })
            })
            .or_else(|| {
                books.iter().position(|book| {
                    book.scope == BookScope::Library && latest_export_hash_for_import_identity(book) == Some(hash)
                })
            })
    }

    pub(super) fn external_book(&self, hash: &str) -> Option<&StoredBook> {
        self.external_books.get(hash)
    }

    pub(super) fn remember(&mut self, index: usize, book: &StoredBook) {
        if book.scope != BookScope::Library {
            return;
        }
        self.external_books.remove(&book.source_hash);
        if let Some(Some(keys)) = self.book_keys.get(index) {
            if self.source_paths.get(&keys.source_path) == Some(&index) {
                self.source_paths.remove(&keys.source_path);
            }
            if let Some(hash) = &keys.hash
                && self.hashes.get(hash) == Some(&index)
            {
                self.hashes.remove(hash);
            }
            if let Some(hash) = &keys.export_hash
                && self.export_hashes.get(hash) == Some(&index)
            {
                self.export_hashes.remove(hash);
            }
        }

        let source_path = source_path_key(&book.source_path);
        let hash = (!book.source_hash.is_empty()).then(|| book.source_hash.clone());
        let export_hash = latest_export_hash_for_import_identity(book).map(str::to_string);
        self.source_paths
            .entry(source_path.clone())
            .and_modify(|stored| *stored = (*stored).min(index))
            .or_insert(index);
        if let Some(hash) = &hash {
            self.hashes
                .entry(hash.clone())
                .and_modify(|stored| *stored = (*stored).min(index))
                .or_insert(index);
        }
        if let Some(hash) = &export_hash {
            self.export_hashes
                .entry(hash.clone())
                .and_modify(|stored| *stored = (*stored).min(index))
                .or_insert(index);
        }
        self.ids.entry(book.id.clone()).or_insert(index);
        let keys = LibraryBookLookupKeys {
            source_path,
            hash,
            export_hash,
        };
        if self.book_keys.len() <= index {
            self.book_keys.resize_with(index + 1, || None);
        }
        self.book_keys[index] = Some(keys);
    }
}

#[derive(Clone, Copy)]
pub(super) enum ExistingBookImport {
    SameContent(usize),
    AdoptSource(usize),
    ReplaceContent(usize),
    Skip,
}

pub(super) fn existing_book_import(
    index: Option<&BookImportLookupIndex>,
    books: &[StoredBook],
    source_path: &Path,
    hash: &str,
) -> Option<ExistingBookImport> {
    let source_path_index = index.map_or_else(
        || {
            books
                .iter()
                .position(|book| book.scope == BookScope::Library && same_source_path(&book.source_path, source_path))
        },
        |index| index.source_path_index(books, source_path),
    );
    let identity_index = index.map_or_else(
        || {
            books.iter().position(|book| {
                book.scope == BookScope::Library
                    && ((!book.source_hash.is_empty() && book.source_hash == hash) || book.id == id_from_hash(hash))
            })
        },
        |index| index.hash_index(books, hash).or_else(|| index.id_index(books, hash)),
    );
    let export_identity_index = index.map_or_else(
        || {
            books.iter().position(|book| {
                book.scope == BookScope::Library && latest_export_hash_for_import_identity(book) == Some(hash)
            })
        },
        |index| index.export_hash_index(books, hash),
    );
    if let Some(index) = source_path_index {
        let book = &books[index];
        return Some(
            if has_unexported_book_changes(book)
                || identity_index.is_some_and(|identity_index| identity_index != index)
                || export_identity_index.is_some_and(|identity_index| identity_index != index)
            {
                ExistingBookImport::Skip
            } else if book.source_hash == hash {
                ExistingBookImport::SameContent(index)
            } else if latest_export_hash_for_import_identity(book) == Some(hash) {
                ExistingBookImport::AdoptSource(index)
            } else {
                ExistingBookImport::ReplaceContent(index)
            },
        );
    }
    identity_index
        .map(ExistingBookImport::SameContent)
        .or_else(|| export_identity_index.map(ExistingBookImport::AdoptSource))
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
    cleanup_path: Option<PathBuf>,
}

impl ImportFinalizer {
    pub(super) fn new(transaction: Option<ImportFileTransaction>) -> Self {
        Self {
            transaction,
            cleanup_path: None,
        }
    }

    pub(super) fn with_cleanup_path(mut self, path: Option<PathBuf>) -> Self {
        self.cleanup_path = path;
        self
    }

    pub(super) fn finalize(self, pending_deletes: &mut Vec<PathBuf>) -> Result<(), String> {
        if let Some(transaction) = self.transaction {
            transaction.commit(pending_deletes)?;
        }
        if let Some(path) = self.cleanup_path
            && let Some(path) = deletion::rename_path_for_deletion(&path)?
        {
            pending_deletes.push(path);
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
