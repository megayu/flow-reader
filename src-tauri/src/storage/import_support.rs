//! Shared lookup, file transaction, and deferred-cleanup support for book imports.

use super::*;

const EAGER_IMPORT_ENV: &str = "FLOW_READER_EAGER_IMPORT";

pub(super) fn eager_import_materialization_enabled() -> bool {
    std::env::var(EAGER_IMPORT_ENV)
        .is_ok_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

pub(super) struct LibraryBookLookupIndex {
    source_paths: HashMap<String, usize>,
    hashes: HashMap<String, usize>,
    ids: HashMap<String, usize>,
    book_keys: Vec<Option<LibraryBookLookupKeys>>,
    external_books: HashMap<String, LibraryBook>,
}

struct LibraryBookLookupKeys {
    source_path: String,
    hash: Option<String>,
}

fn source_path_key(path: &Path) -> String {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let key = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) { key.to_lowercase() } else { key }
}

pub(super) fn same_source_path(left: &Path, right: &Path) -> bool {
    source_path_key(left) == source_path_key(right)
}

impl LibraryBookLookupIndex {
    pub(super) fn load(storage: &AppStorage) -> Result<Self, String> {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let mut source_paths = HashMap::with_capacity(state.library.books.len());
        let mut hashes = HashMap::with_capacity(state.library.books.len());
        let mut ids = HashMap::with_capacity(state.library.books.len());
        let mut book_keys = Vec::with_capacity(state.library.books.len());
        for (index, book) in state.library.books.iter().enumerate() {
            let source_path = source_path_key(&book.source_path);
            source_paths.entry(source_path.clone()).or_insert(index);
            if !book.content_hash.is_empty() {
                hashes.entry(book.content_hash.clone()).or_insert(index);
            }
            ids.entry(book.id.clone()).or_insert(index);
            book_keys.push(Some(LibraryBookLookupKeys {
                source_path,
                hash: (!book.content_hash.is_empty()).then(|| book.content_hash.clone()),
            }));
        }
        let external_books = state
            .external
            .books
            .iter()
            .filter(|book| !book.content_hash.is_empty())
            .map(|book| (book.content_hash.clone(), book.clone()))
            .collect();
        Ok(Self {
            source_paths,
            hashes,
            ids,
            book_keys,
            external_books,
        })
    }

    pub(super) fn source_path_index(&self, books: &[LibraryBook], path: &Path) -> Option<usize> {
        self.source_paths
            .get(&source_path_key(path))
            .copied()
            .filter(|index| {
                books
                    .get(*index)
                    .is_some_and(|book| same_source_path(&book.source_path, path))
            })
            .or_else(|| books.iter().position(|book| same_source_path(&book.source_path, path)))
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

    pub(super) fn id_index(&self, books: &[LibraryBook], hash: &str) -> Option<usize> {
        let id = id_from_hash(hash);
        self.ids
            .get(&id)
            .copied()
            .filter(|index| books.get(*index).is_some_and(|book| book.id == id))
            .or_else(|| books.iter().position(|book| book.id == id))
    }

    pub(super) fn external_book(&self, hash: &str) -> Option<&LibraryBook> {
        self.external_books.get(hash)
    }

    pub(super) fn remember(&mut self, index: usize, book: &LibraryBook) {
        if let Some(Some(keys)) = self.book_keys.get(index) {
            if self.source_paths.get(&keys.source_path) == Some(&index) {
                self.source_paths.remove(&keys.source_path);
            }
            if let Some(hash) = &keys.hash
                && self.hashes.get(hash) == Some(&index)
            {
                self.hashes.remove(hash);
            }
        }

        let source_path = source_path_key(&book.source_path);
        let hash = (!book.content_hash.is_empty()).then(|| book.content_hash.clone());
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
        self.ids.entry(book.id.clone()).or_insert(index);
        let keys = LibraryBookLookupKeys { source_path, hash };
        if self.book_keys.len() <= index {
            self.book_keys.resize_with(index + 1, || None);
        }
        self.book_keys[index] = Some(keys);
    }
}

#[derive(Clone, Copy)]
pub(super) enum ExistingBookImport {
    SameContent(usize),
    ReplaceContent(usize),
    Skip,
}

pub(super) fn existing_book_import(
    index: Option<&LibraryBookLookupIndex>,
    books: &[LibraryBook],
    source_path: &Path,
    hash: &str,
) -> Option<ExistingBookImport> {
    let source_path_index = index.map_or_else(
        || {
            books
                .iter()
                .position(|book| same_source_path(&book.source_path, source_path))
        },
        |index| index.source_path_index(books, source_path),
    );
    let identity_index = index.map_or_else(
        || {
            books.iter().position(|book| {
                (!book.content_hash.is_empty() && book.content_hash == hash) || book.id == id_from_hash(hash)
            })
        },
        |index| index.hash_index(books, hash).or_else(|| index.id_index(books, hash)),
    );
    if let Some(index) = source_path_index {
        let book = &books[index];
        return Some(
            if book.content_edited_at.is_some() || identity_index.is_some_and(|identity_index| identity_index != index)
            {
                ExistingBookImport::Skip
            } else if book.content_hash == hash || book.id == id_from_hash(hash) {
                ExistingBookImport::SameContent(index)
            } else {
                ExistingBookImport::ReplaceContent(index)
            },
        );
    }
    identity_index.map(ExistingBookImport::SameContent)
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
}

impl ImportFinalizer {
    pub(super) fn new(transaction: Option<ImportFileTransaction>) -> Self {
        Self { transaction }
    }

    pub(super) fn finalize(self, pending_deletes: &mut Vec<PathBuf>) -> Result<(), String> {
        if let Some(transaction) = self.transaction {
            transaction.commit(pending_deletes)?;
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
