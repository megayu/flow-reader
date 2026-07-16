use std::{collections::HashMap, sync::Mutex};

#[derive(Default)]
pub struct DictionarySessionManager {
    resources: Mutex<HashMap<u64, Vec<String>>>,
}

impl DictionarySessionManager {
    pub fn attach(&self, session_id: u64, dictionary_id: String) -> Result<(), String> {
        let mut resources = self
            .resources
            .lock()
            .map_err(|_| "dictionary session lock failed".to_string())?;
        resources.entry(session_id).or_default().push(dictionary_id);
        Ok(())
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
        let count = resources.values().map(Vec::len).sum();
        resources.clear();
        Ok(count)
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
        assert_eq!(sessions.release(1).unwrap(), 2);
        assert_eq!(sessions.release_all().unwrap(), 1);
    }
}
