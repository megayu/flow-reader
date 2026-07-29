use super::*;

const READING_POSITION_FLUSH_DELAY: Duration = Duration::from_secs(15);

pub(super) struct StorageState {
    pub(super) library: Library,
    pub(super) external: ExternalBookIndex,
    pub(super) settings: Value,
    pub(super) book_states: HashMap<String, BookState>,
}

#[derive(Default)]
pub(super) struct DirtyState {
    pub(super) library: bool,
    pub(super) external: bool,
    pub(super) settings: bool,
    pub(super) book_states: HashSet<String>,
    pub(super) delayed_flush_scheduled: bool,
}

impl AppStorage {
    pub(super) fn mark_library_dirty(&self) {
        if let Ok(mut dirty) = self.inner.dirty.lock() {
            dirty.library = true;
        }
    }

    pub(super) fn mark_external_dirty(&self) {
        if let Ok(mut dirty) = self.inner.dirty.lock() {
            dirty.external = true;
        }
    }

    pub(super) fn mark_settings_dirty(&self) {
        if let Ok(mut dirty) = self.inner.dirty.lock() {
            dirty.settings = true;
        }
    }

    pub(super) fn mark_book_state_dirty(&self, id: &str) {
        if let Ok(mut dirty) = self.inner.dirty.lock() {
            dirty.book_states.insert(id.to_string());
        }
    }

    pub(super) fn schedule_reading_position_flush(&self) {
        let should_schedule = {
            let Ok(mut dirty) = self.inner.dirty.lock() else {
                return;
            };
            if dirty.delayed_flush_scheduled {
                false
            } else {
                dirty.delayed_flush_scheduled = true;
                true
            }
        };

        if !should_schedule {
            return;
        }

        let storage = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(READING_POSITION_FLUSH_DELAY);
            storage.clear_delayed_flush_flag();
            if let Err(error) = storage.flush_dirty() {
                eprintln!("Failed to flush reading position: {error}");
            }
        });
    }

    fn clear_delayed_flush_flag(&self) {
        if let Ok(mut dirty) = self.inner.dirty.lock() {
            dirty.delayed_flush_scheduled = false;
        }
    }

    pub fn flush_dirty(&self) -> Result<(), String> {
        let _flush_guard = self
            .inner
            .flush_lock
            .lock()
            .map_err(|_| "storage flush lock poisoned".to_string())?;
        let dirty = {
            let mut dirty = self
                .inner
                .dirty
                .lock()
                .map_err(|_| "storage dirty lock poisoned".to_string())?;
            let snapshot = DirtyState {
                library: dirty.library,
                external: dirty.external,
                settings: dirty.settings,
                book_states: std::mem::take(&mut dirty.book_states),
                delayed_flush_scheduled: dirty.delayed_flush_scheduled,
            };
            dirty.library = false;
            dirty.external = false;
            dirty.settings = false;
            snapshot
        };

        if !dirty.library && !dirty.external && !dirty.settings && dirty.book_states.is_empty() {
            return Ok(());
        }

        let result = (|| {
            let (library, external, settings, book_states) = {
                let state = self
                    .inner
                    .state
                    .lock()
                    .map_err(|_| "storage state lock poisoned".to_string())?;
                let library = dirty.library.then(|| clone_library(&state.library));
                let external = dirty.external.then(|| clone_external_index(&state.external));
                let settings = dirty.settings.then(|| state.settings.clone());
                let book_states = dirty
                    .book_states
                    .iter()
                    .filter_map(|id| state.book_states.get(id).map(|s| (id.clone(), s.clone())))
                    .collect::<Vec<_>>();

                (library, external, settings, book_states)
            };

            if let Some(library) = library {
                write_json(&library_path(self.root())?, &library)?;
            }
            if let Some(external) = external {
                write_json(&external_index_path(self.root())?, &external)?;
            }
            if let Some(settings) = settings {
                write_json(&settings_path(self.root())?, &settings)?;
            }
            for (id, book_state) in book_states {
                write_json(&self.book_dir(&id).join(STATE_FILE), &book_state)?;
            }

            Ok(())
        })();

        if result.is_err() {
            let mut current = self
                .inner
                .dirty
                .lock()
                .map_err(|_| "storage dirty lock poisoned while restoring failed flush".to_string())?;
            current.library |= dirty.library;
            current.external |= dirty.external;
            current.settings |= dirty.settings;
            current.book_states.extend(dirty.book_states);
        }

        result
    }
}
