#![allow(dead_code)]

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct TaskKey(String);

impl TaskKey {
    pub(crate) fn new(kind: TaskKind, identity: impl Into<String>) -> Self {
        Self(format!("{}:{}", kind.as_str(), identity.into()))
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum TaskKind {
    SearchIndex,
    EpubUnpack,
    TxtPreview,
    ImportMaterialize,
    TombstoneCleanup,
}

impl TaskKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::SearchIndex => "search-index",
            Self::EpubUnpack => "unpack-epub",
            Self::TxtPreview => "txt-preview",
            Self::ImportMaterialize => "import-materialize",
            Self::TombstoneCleanup => "delete-cleanup",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskPriority {
    Critical,
    Foreground,
    Background,
}

pub(crate) struct TaskRegistry<T> {
    in_flight: Mutex<HashMap<TaskKey, Arc<TaskEntry<T>>>>,
}

struct TaskEntry<T> {
    state: Mutex<TaskEntryState<T>>,
    ready: Condvar,
}

enum TaskEntryState<T> {
    Running,
    Complete(Result<T, String>),
}

impl<T> TaskRegistry<T> {
    pub(crate) fn new() -> Self {
        Self {
            in_flight: Mutex::new(HashMap::new()),
        }
    }
}

impl<T> Default for TaskRegistry<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> TaskRegistry<T>
where
    T: Clone,
{
    pub(crate) fn get_or_run(
        &self,
        key: TaskKey,
        task: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let (entry, should_run) = {
            let mut in_flight = self
                .in_flight
                .lock()
                .map_err(|_| "task registry lock poisoned".to_string())?;
            if let Some(entry) = in_flight.get(&key) {
                (Arc::clone(entry), false)
            } else {
                let entry = Arc::new(TaskEntry {
                    state: Mutex::new(TaskEntryState::Running),
                    ready: Condvar::new(),
                });
                in_flight.insert(key.clone(), Arc::clone(&entry));
                (entry, true)
            }
        };

        if should_run {
            let result = task();

            {
                let mut state = entry
                    .state
                    .lock()
                    .map_err(|_| "task entry lock poisoned".to_string())?;
                *state = TaskEntryState::Complete(result.clone());
                entry.ready.notify_all();
            }

            let mut in_flight = self
                .in_flight
                .lock()
                .map_err(|_| "task registry lock poisoned".to_string())?;
            if in_flight
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &entry))
            {
                in_flight.remove(&key);
            }

            return result;
        }

        let mut state = entry
            .state
            .lock()
            .map_err(|_| "task entry lock poisoned".to_string())?;
        loop {
            match &*state {
                TaskEntryState::Complete(result) => return result.clone(),
                TaskEntryState::Running => {
                    state = entry
                        .ready
                        .wait(state)
                        .map_err(|_| "task entry lock poisoned".to_string())?;
                }
            }
        }
    }
}

pub(crate) struct TaskService {
    inner: Arc<TaskServiceInner>,
}

struct TaskServiceInner {
    shutdown: AtomicBool,
    cpu: ResourceGate,
    io: ResourceGate,
    background: ResourceGate,
}

struct ResourceGate {
    max: usize,
    active: Mutex<usize>,
    ready: Condvar,
}

struct ResourcePermit<'a> {
    gate: &'a ResourceGate,
}

impl Default for TaskService {
    fn default() -> Self {
        let logical_cpus = std::thread::available_parallelism()
            .map(|cpus| cpus.get())
            .unwrap_or(1);
        Self {
            inner: Arc::new(TaskServiceInner {
                shutdown: AtomicBool::new(false),
                cpu: ResourceGate::new(logical_cpus.saturating_mul(2).max(1)),
                io: ResourceGate::new(1),
                background: ResourceGate::new(1),
            }),
        }
    }
}

impl TaskService {
    pub(crate) fn begin_shutdown(&self) {
        self.inner.shutdown.store(true, Ordering::SeqCst);
    }

    pub(crate) fn cancel_background(&self) {}

    pub(crate) fn run_cpu<T>(
        &self,
        _priority: TaskPriority,
        task: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.ensure_accepting(_priority)?;
        let _permit = self.inner.cpu.acquire()?;
        task()
    }

    pub(crate) fn run_io<T>(
        &self,
        _priority: TaskPriority,
        task: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.ensure_accepting(_priority)?;
        let _permit = self.inner.io.acquire()?;
        task()
    }

    pub(crate) fn run_background<T>(
        &self,
        task: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.ensure_accepting(TaskPriority::Background)?;
        let _permit = self.inner.background.acquire()?;
        task()
    }

    fn ensure_accepting(&self, priority: TaskPriority) -> Result<(), String> {
        if priority != TaskPriority::Critical && self.inner.shutdown.load(Ordering::SeqCst) {
            Err("task service is shutting down".to_string())
        } else {
            Ok(())
        }
    }
}

impl ResourceGate {
    fn new(max: usize) -> Self {
        Self {
            max: max.max(1),
            active: Mutex::new(0),
            ready: Condvar::new(),
        }
    }

    fn acquire(&self) -> Result<ResourcePermit<'_>, String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "task resource gate lock poisoned".to_string())?;
        while *active >= self.max {
            active = self
                .ready
                .wait(active)
                .map_err(|_| "task resource gate lock poisoned".to_string())?;
        }
        *active += 1;
        Ok(ResourcePermit { gate: self })
    }
}

impl Drop for ResourcePermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.gate.active.lock() {
            *active = active.saturating_sub(1);
            self.gate.ready.notify_one();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{TaskKey, TaskKind, TaskRegistry, TaskService};
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        thread,
        time::Duration,
    };

    #[test]
    fn task_registry_reuses_one_in_flight_task_for_matching_keys() {
        let registry = Arc::new(TaskRegistry::<u32>::new());
        let runs = Arc::new(AtomicUsize::new(0));
        let key = TaskKey::new(TaskKind::SearchIndex, "book-1:version-1");

        let first = {
            let registry = Arc::clone(&registry);
            let runs = Arc::clone(&runs);
            let key = key.clone();
            thread::spawn(move || {
                registry.get_or_run(key, || {
                    runs.fetch_add(1, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(100));
                    Ok(42)
                })
            })
        };

        thread::sleep(Duration::from_millis(20));

        let second = {
            let registry = Arc::clone(&registry);
            let runs = Arc::clone(&runs);
            thread::spawn(move || {
                registry.get_or_run(key, || {
                    runs.fetch_add(1, Ordering::SeqCst);
                    Ok(7)
                })
            })
        };

        assert_eq!(first.join().unwrap(), Ok(42));
        assert_eq!(second.join().unwrap(), Ok(42));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn task_service_rejects_background_work_after_shutdown_begins() {
        let service = TaskService::default();

        service.begin_shutdown();

        let result = service.run_background(|| Ok("started"));

        assert!(result.is_err());
    }
}
