#![allow(dead_code)]

use std::{
    any::Any,
    collections::HashMap,
    env,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::ThreadId,
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

const DEFAULT_IO_WRITERS: usize = 1;
const MAX_IO_WRITERS: usize = 4;
const IO_WRITERS_ENV: &str = "FLOW_READER_IO_WRITERS";

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

#[derive(Clone)]
pub(crate) struct TaskService {
    inner: Arc<TaskServiceInner>,
}

struct TaskServiceInner {
    shutdown: AtomicBool,
    in_flight: TaskRegistry<Arc<dyn Any + Send + Sync>>,
    cpu: ResourceGate,
    io: ResourceGate,
    background: ResourceGate,
    book_locks: Mutex<HashMap<String, Arc<BookOperationLock>>>,
}

struct ResourceGate {
    state: Mutex<ResourceGateState>,
    ready: Condvar,
}

struct ResourceGateState {
    max: usize,
    active: usize,
}

struct ResourcePermit<'a> {
    gate: &'a ResourceGate,
}

struct BookOperationLock {
    state: Mutex<BookOperationLockState>,
    ready: Condvar,
}

#[derive(Default)]
struct BookOperationLockState {
    owner: Option<ThreadId>,
    depth: usize,
}

struct BookOperationPermit {
    lock: Arc<BookOperationLock>,
}

impl Default for TaskService {
    fn default() -> Self {
        let logical_cpus = std::thread::available_parallelism()
            .map(|cpus| cpus.get())
            .unwrap_or(1);
        Self {
            inner: Arc::new(TaskServiceInner {
                shutdown: AtomicBool::new(false),
                in_flight: TaskRegistry::new(),
                cpu: ResourceGate::new(logical_cpus.saturating_mul(2).max(1)),
                io: ResourceGate::new(initial_io_writer_limit()),
                background: ResourceGate::new(1),
                book_locks: Mutex::new(HashMap::new()),
            }),
        }
    }
}

impl TaskService {
    pub(crate) fn begin_shutdown(&self) {
        self.inner.shutdown.store(true, Ordering::SeqCst);
    }

    pub(crate) fn cancel_background(&self) {}

    pub(crate) fn set_io_writer_limit(&self, max: usize) {
        self.inner.io.set_max(max.min(MAX_IO_WRITERS));
    }

    pub(crate) fn io_writer_limit(&self) -> usize {
        self.inner.io.max()
    }

    pub(crate) fn get_or_run<T>(
        &self,
        key: TaskKey,
        priority: TaskPriority,
        task: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String>
    where
        T: Clone + Send + Sync + 'static,
    {
        self.ensure_accepting(priority)?;
        let value = self.inner.in_flight.get_or_run(key, || {
            task().map(|value| Arc::new(value) as Arc<dyn Any + Send + Sync>)
        })?;
        value
            .as_ref()
            .downcast_ref::<T>()
            .cloned()
            .ok_or_else(|| "task result type mismatch".to_string())
    }

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

    pub(crate) fn run_book_exclusive<T>(
        &self,
        book_id: impl AsRef<str>,
        priority: TaskPriority,
        task: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.ensure_accepting(priority)?;
        let lock = self.book_lock(book_id.as_ref())?;
        let _permit = lock.acquire()?;
        task()
    }

    fn ensure_accepting(&self, priority: TaskPriority) -> Result<(), String> {
        if priority != TaskPriority::Critical && self.inner.shutdown.load(Ordering::SeqCst) {
            Err("task service is shutting down".to_string())
        } else {
            Ok(())
        }
    }

    fn book_lock(&self, book_id: &str) -> Result<Arc<BookOperationLock>, String> {
        let mut locks = self
            .inner
            .book_locks
            .lock()
            .map_err(|_| "book operation lock map poisoned".to_string())?;
        Ok(Arc::clone(
            locks
                .entry(book_id.to_string())
                .or_insert_with(|| Arc::new(BookOperationLock::new())),
        ))
    }
}

impl ResourceGate {
    fn new(max: usize) -> Self {
        Self {
            state: Mutex::new(ResourceGateState {
                max: max.max(1),
                active: 0,
            }),
            ready: Condvar::new(),
        }
    }

    fn acquire(&self) -> Result<ResourcePermit<'_>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "task resource gate lock poisoned".to_string())?;
        while state.active >= state.max {
            state = self
                .ready
                .wait(state)
                .map_err(|_| "task resource gate lock poisoned".to_string())?;
        }
        state.active += 1;
        Ok(ResourcePermit { gate: self })
    }

    fn set_max(&self, max: usize) {
        if let Ok(mut state) = self.state.lock() {
            state.max = max.max(1);
            self.ready.notify_all();
        }
    }

    fn max(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.max)
            .unwrap_or(DEFAULT_IO_WRITERS)
    }
}

impl Drop for ResourcePermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.state.lock() {
            state.active = state.active.saturating_sub(1);
            self.gate.ready.notify_all();
        }
    }
}

fn initial_io_writer_limit() -> usize {
    normalize_io_writer_limit(env::var(IO_WRITERS_ENV).ok().as_deref())
}

fn normalize_io_writer_limit(input: Option<&str>) -> usize {
    input
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_IO_WRITERS)
        .clamp(1, MAX_IO_WRITERS)
}

impl BookOperationLock {
    fn new() -> Self {
        Self {
            state: Mutex::new(BookOperationLockState::default()),
            ready: Condvar::new(),
        }
    }

    fn acquire(self: &Arc<Self>) -> Result<BookOperationPermit, String> {
        let current_thread = std::thread::current().id();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "book operation lock poisoned".to_string())?;
        loop {
            match state.owner {
                None => {
                    state.owner = Some(current_thread);
                    state.depth = 1;
                    return Ok(BookOperationPermit {
                        lock: Arc::clone(self),
                    });
                }
                Some(owner) if owner == current_thread => {
                    state.depth += 1;
                    return Ok(BookOperationPermit {
                        lock: Arc::clone(self),
                    });
                }
                Some(_) => {
                    state = self
                        .ready
                        .wait(state)
                        .map_err(|_| "book operation lock poisoned".to_string())?;
                }
            }
        }
    }
}

impl Drop for BookOperationPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.lock.state.lock() {
            state.depth = state.depth.saturating_sub(1);
            if state.depth == 0 {
                state.owner = None;
                self.lock.ready.notify_one();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{TaskKey, TaskKind, TaskRegistry, TaskService};
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc,
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

    #[test]
    fn resource_gate_limit_increase_releases_waiting_work() {
        let gate = Arc::new(super::ResourceGate::new(1));
        let _first = gate.acquire().unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (acquired_tx, acquired_rx) = mpsc::channel();

        let waiter = {
            let gate = Arc::clone(&gate);
            thread::spawn(move || {
                started_tx.send(()).unwrap();
                let _permit = gate.acquire().unwrap();
                acquired_tx.send(()).unwrap();
                thread::sleep(Duration::from_millis(20));
            })
        };

        started_rx.recv_timeout(Duration::from_millis(100)).unwrap();
        assert!(acquired_rx.recv_timeout(Duration::from_millis(30)).is_err());

        gate.set_max(2);

        acquired_rx
            .recv_timeout(Duration::from_millis(100))
            .unwrap();
        waiter.join().unwrap();
    }

    #[test]
    fn resource_gate_limit_decrease_waits_until_active_count_fits_new_limit() {
        let gate = Arc::new(super::ResourceGate::new(2));
        let first = gate.acquire().unwrap();
        let second = gate.acquire().unwrap();
        gate.set_max(1);
        let (started_tx, started_rx) = mpsc::channel();
        let (acquired_tx, acquired_rx) = mpsc::channel();

        let waiter = {
            let gate = Arc::clone(&gate);
            thread::spawn(move || {
                started_tx.send(()).unwrap();
                let _permit = gate.acquire().unwrap();
                acquired_tx.send(()).unwrap();
                thread::sleep(Duration::from_millis(20));
            })
        };

        started_rx.recv_timeout(Duration::from_millis(100)).unwrap();
        assert!(acquired_rx.recv_timeout(Duration::from_millis(30)).is_err());

        drop(first);

        assert!(acquired_rx.recv_timeout(Duration::from_millis(30)).is_err());

        drop(second);

        acquired_rx
            .recv_timeout(Duration::from_millis(100))
            .unwrap();
        waiter.join().unwrap();
    }

    #[test]
    fn io_writer_limit_input_uses_conservative_bounds() {
        assert_eq!(super::normalize_io_writer_limit(None), 1);
        assert_eq!(super::normalize_io_writer_limit(Some("")), 1);
        assert_eq!(super::normalize_io_writer_limit(Some("0")), 1);
        assert_eq!(super::normalize_io_writer_limit(Some("2")), 2);
        assert_eq!(super::normalize_io_writer_limit(Some("99")), 4);
        assert_eq!(super::normalize_io_writer_limit(Some("invalid")), 1);
    }

    #[test]
    fn task_service_io_writer_limit_can_be_adjusted_with_bounds() {
        let service = TaskService::default();

        service.set_io_writer_limit(3);
        assert_eq!(service.io_writer_limit(), 3);

        service.set_io_writer_limit(99);
        assert_eq!(service.io_writer_limit(), 4);

        service.set_io_writer_limit(0);
        assert_eq!(service.io_writer_limit(), 1);
    }

    #[test]
    fn book_exclusive_work_serializes_matching_book_ids() {
        let service = Arc::new(TaskService::default());
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));

        let first = {
            let service = Arc::clone(&service);
            let active = Arc::clone(&active);
            let max_active = Arc::clone(&max_active);
            thread::spawn(move || {
                service.run_book_exclusive("book", super::TaskPriority::Foreground, || {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(now, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(80));
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
            })
        };

        thread::sleep(Duration::from_millis(10));

        let second = {
            let service = Arc::clone(&service);
            let active = Arc::clone(&active);
            let max_active = Arc::clone(&max_active);
            thread::spawn(move || {
                service.run_book_exclusive("book", super::TaskPriority::Foreground, || {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(now, Ordering::SeqCst);
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
            })
        };

        first.join().unwrap().unwrap();
        second.join().unwrap().unwrap();

        assert_eq!(max_active.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn book_exclusive_work_allows_different_book_ids() {
        let service = Arc::new(TaskService::default());
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));

        let first = {
            let service = Arc::clone(&service);
            let active = Arc::clone(&active);
            let max_active = Arc::clone(&max_active);
            thread::spawn(move || {
                service.run_book_exclusive("book-a", super::TaskPriority::Foreground, || {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(now, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(80));
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
            })
        };

        thread::sleep(Duration::from_millis(10));

        let second = {
            let service = Arc::clone(&service);
            let active = Arc::clone(&active);
            let max_active = Arc::clone(&max_active);
            thread::spawn(move || {
                service.run_book_exclusive("book-b", super::TaskPriority::Foreground, || {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(now, Ordering::SeqCst);
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
            })
        };

        first.join().unwrap().unwrap();
        second.join().unwrap().unwrap();

        assert!(max_active.load(Ordering::SeqCst) > 1);
    }

    #[test]
    fn book_exclusive_work_is_reentrant_on_same_thread() {
        let service = TaskService::default();

        let result = service.run_book_exclusive("book", super::TaskPriority::Foreground, || {
            service.run_book_exclusive("book", super::TaskPriority::Foreground, || Ok(42))
        });

        assert_eq!(result, Ok(42));
    }
}
