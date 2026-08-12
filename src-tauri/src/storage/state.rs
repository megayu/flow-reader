use super::*;

pub(super) struct StorageState {
    pub(super) library: Library,
    pub(super) external: ExternalBookIndex,
    pub(super) settings: Value,
    pub(super) text_import_rules: TextImportRulesInput,
}

impl StorageState {
    pub(super) fn new(library: Library, external: ExternalBookIndex, settings: Value) -> Self {
        let text_import_rules = settings::text_import_rules_from_settings(&settings);
        Self {
            library,
            external,
            settings,
            text_import_rules,
        }
    }
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
        if let Err(error) = self.flush_all_dirty() {
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

    pub(super) fn flush_content_dirty(&self) -> Result<(), String> {
        self.flush_selected_dirty(true, true, false)
    }

    pub(super) fn flush_settings_dirty(&self) -> Result<(), String> {
        self.flush_selected_dirty(false, false, true)
    }

    pub(super) fn flush_all_dirty(&self) -> Result<(), String> {
        self.flush_selected_dirty(true, true, true)
    }

    fn flush_selected_dirty(
        &self,
        flush_library: bool,
        flush_external: bool,
        flush_settings: bool,
    ) -> Result<(), String> {
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
                library: flush_library && dirty.library,
                external: flush_external && dirty.external,
                settings: flush_settings && dirty.settings,
            };
            if flush_library {
                dirty.library = false;
            }
            if flush_external {
                dirty.external = false;
            }
            if flush_settings {
                dirty.settings = false;
            }
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
