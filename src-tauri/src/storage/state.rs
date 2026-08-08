use super::*;

pub(super) struct StorageState {
    pub(super) library: Library,
    pub(super) external: ExternalBookIndex,
    pub(super) settings: Value,
}

#[derive(Default)]
pub(super) struct DirtyState {
    pub(super) library: bool,
    pub(super) external: bool,
    pub(super) settings: bool,
}

impl AppStorage {
    pub fn flush_for_exit(&self) {
        if let Err(error) = self.flush_all_derived_caches() {
            eprintln!("Failed to flush derived book caches: {error}");
        }
        if let Err(error) = self.flush_dirty() {
            eprintln!("Failed to flush app storage: {error}");
        }
    }

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
            };
            dirty.library = false;
            dirty.external = false;
            dirty.settings = false;
            snapshot
        };

        if !dirty.library && !dirty.external && !dirty.settings {
            return Ok(());
        }

        let result = (|| {
            let (library, external, settings) = {
                let state = self
                    .inner
                    .state
                    .lock()
                    .map_err(|_| "storage state lock poisoned".to_string())?;
                let library = dirty.library.then(|| clone_library(&state.library));
                let external = dirty.external.then(|| clone_external_index(&state.external));
                let settings = dirty.settings.then(|| state.settings.clone());
                (library, external, settings)
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
        }

        result
    }
}
