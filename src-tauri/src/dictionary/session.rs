use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use serde::Serialize;

use super::{
    mdict::{MdictBinaryResource, MdictError, MdictReader},
    stardict::{StarDictError, StarDictReader},
};

enum DictionarySessionResource {
    #[cfg(test)]
    Marker,
    Mdict(Arc<MdictReader>),
    StarDict(Arc<StarDictReader>),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionarySessionDiagnostics {
    pub file_count: usize,
    pub mmap_count: usize,
    pub resource_count: usize,
    pub session_count: usize,
}

#[derive(Default)]
pub struct DictionarySessionManager {
    resources: Mutex<HashMap<u64, HashMap<String, DictionarySessionResource>>>,
}

impl DictionarySessionManager {
    #[cfg(test)]
    pub fn attach(&self, session_id: u64, dictionary_id: String) -> Result<(), String> {
        let mut resources = self
            .resources
            .lock()
            .map_err(|_| "dictionary session lock failed".to_string())?;
        resources
            .entry(session_id)
            .or_default()
            .insert(dictionary_id, DictionarySessionResource::Marker);
        Ok(())
    }

    pub fn get_or_open_stardict(
        &self,
        session_id: u64,
        dictionary_id: &str,
        open: impl FnOnce() -> Result<StarDictReader, StarDictError>,
    ) -> Result<Arc<StarDictReader>, StarDictError> {
        let mut resources = self.resources.lock().map_err(|_| {
            StarDictError::new("sessionLockFailed", "Dictionary session lock failed.")
        })?;
        let session = resources.entry(session_id).or_default();
        if let Some(DictionarySessionResource::StarDict(reader)) = session.get(dictionary_id) {
            return Ok(Arc::clone(reader));
        }
        let reader = Arc::new(open()?);
        session.insert(
            dictionary_id.to_string(),
            DictionarySessionResource::StarDict(Arc::clone(&reader)),
        );
        Ok(reader)
    }

    pub fn get_or_open_mdict(
        &self,
        session_id: u64,
        dictionary_id: &str,
        open: impl FnOnce() -> Result<MdictReader, MdictError>,
    ) -> Result<Arc<MdictReader>, MdictError> {
        let mut resources = self
            .resources
            .lock()
            .map_err(|_| MdictError::new("sessionLockFailed", "Dictionary session lock failed."))?;
        let session = resources.entry(session_id).or_default();
        if let Some(DictionarySessionResource::Mdict(reader)) = session.get(dictionary_id) {
            return Ok(Arc::clone(reader));
        }
        let reader = Arc::new(open()?);
        session.insert(
            dictionary_id.to_string(),
            DictionarySessionResource::Mdict(Arc::clone(&reader)),
        );
        Ok(reader)
    }

    pub fn load_mdict_resource(
        &self,
        session_id: u64,
        dictionary_id: &str,
        key: &str,
    ) -> Result<Option<MdictBinaryResource>, MdictError> {
        let reader = {
            let resources = self.resources.lock().map_err(|_| {
                MdictError::new("sessionLockFailed", "Dictionary session lock failed.")
            })?;
            let Some(DictionarySessionResource::Mdict(reader)) = resources
                .get(&session_id)
                .and_then(|session| session.get(dictionary_id))
            else {
                return Err(MdictError::new(
                    "mdictSessionReleased",
                    "The MDict session is no longer available.",
                ));
            };
            Arc::clone(reader)
        };
        reader.load_binary_resource(key)
    }

    pub fn release(&self, session_id: u64) -> Result<usize, String> {
        let mut resources = self
            .resources
            .lock()
            .map_err(|_| "dictionary session lock failed".to_string())?;
        Ok(resources.remove(&session_id).map_or(0, |items| items.len()))
    }

    pub fn release_all(&self) -> Result<usize, String> {
        let mut resources = self
            .resources
            .lock()
            .map_err(|_| "dictionary session lock failed".to_string())?;
        let count = resources.values().map(HashMap::len).sum();
        resources.clear();
        Ok(count)
    }

    pub fn diagnostics(&self) -> Result<DictionarySessionDiagnostics, String> {
        let resources = self
            .resources
            .lock()
            .map_err(|_| "dictionary session lock failed".to_string())?;
        let mut diagnostics = DictionarySessionDiagnostics {
            session_count: resources.len(),
            ..DictionarySessionDiagnostics::default()
        };
        for resource in resources.values().flat_map(HashMap::values) {
            diagnostics.resource_count += 1;
            if let DictionarySessionResource::Mdict(reader) = resource {
                diagnostics.file_count += reader.source_file_count();
            }
            if let DictionarySessionResource::StarDict(reader) = resource {
                diagnostics.file_count += 1;
                diagnostics.mmap_count += reader.mmap_count();
            }
        }
        Ok(diagnostics)
    }
}

#[cfg(test)]
mod tests {
    use super::DictionarySessionManager;

    #[test]
    fn releases_only_resources_owned_by_the_requested_session() {
        let sessions = DictionarySessionManager::default();
        sessions.attach(1, "first".to_string()).unwrap();
        sessions.attach(1, "second".to_string()).unwrap();
        sessions.attach(2, "third".to_string()).unwrap();
        let before_release = sessions.diagnostics().unwrap();
        assert_eq!(before_release.session_count, 2);
        assert_eq!(before_release.resource_count, 3);
        assert_eq!(sessions.release(1).unwrap(), 2);
        let after_release = sessions.diagnostics().unwrap();
        assert_eq!(after_release.session_count, 1);
        assert_eq!(after_release.resource_count, 1);
        assert_eq!(sessions.release_all().unwrap(), 1);
        assert_eq!(sessions.diagnostics().unwrap().resource_count, 0);
    }
}
