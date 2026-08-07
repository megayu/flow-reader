#![allow(dead_code)]

use std::{
    any::Any,
    collections::HashMap,
    env,
    path::Path,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::ThreadId,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::ptr;

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
    Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, GetDriveTypeW, OPEN_EXISTING},
    System::{
        IO::DeviceIoControl,
        Ioctl::{
            DEVICE_SEEK_PENALTY_DESCRIPTOR, DEVICE_TRIM_DESCRIPTOR, IOCTL_STORAGE_QUERY_PROPERTY,
            PropertyStandardQuery, STORAGE_PROPERTY_ID, STORAGE_PROPERTY_QUERY, StorageDeviceSeekPenaltyProperty,
            StorageDeviceTrimProperty,
        },
        WindowsProgramming::{DRIVE_FIXED, DRIVE_RAMDISK, DRIVE_REMOTE, DRIVE_REMOVABLE},
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
    BookMaterialize,
    TxtPreview,
    TombstoneCleanup,
}

impl TaskKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::SearchIndex => "search-index",
            Self::BookMaterialize => "book-materialize",
            Self::TxtPreview => "txt-preview",
            Self::TombstoneCleanup => "delete-cleanup",
        }
    }
}

const DEFAULT_IO_WRITERS: usize = 1;
const MAX_IO_WRITERS: usize = 4;
const IO_WRITERS_ENV: &str = "FLOW_READER_IO_WRITERS";
const IO_ADAPT_MIN_SAMPLES: usize = 2;
const IO_ADAPT_IMPROVEMENT_RATIO: f64 = 1.10;

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

    fn len(&self) -> usize {
        self.in_flight
            .lock()
            .map(|in_flight| in_flight.len())
            .unwrap_or_default()
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
    pub(crate) fn get_or_run(&self, key: TaskKey, task: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
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
                let mut state = entry.state.lock().map_err(|_| "task entry lock poisoned".to_string())?;
                *state = TaskEntryState::Complete(result.clone());
                entry.ready.notify_all();
            }

            let mut in_flight = self
                .in_flight
                .lock()
                .map_err(|_| "task registry lock poisoned".to_string())?;
            if in_flight.get(&key).is_some_and(|current| Arc::ptr_eq(current, &entry)) {
                in_flight.remove(&key);
            }

            return result;
        }

        let mut state = entry.state.lock().map_err(|_| "task entry lock poisoned".to_string())?;
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
    io_writer_override: bool,
    io_adaptation: Mutex<HashMap<String, IoAdaptationState>>,
    io_in_flight_bytes: AtomicU64,
    background: ResourceGate,
    background_cancel_epoch: AtomicU64,
    book_locks: Mutex<HashMap<String, Arc<BookOperationLock>>>,
}

struct ResourceGate {
    state: Mutex<ResourceGateState>,
    ready: Condvar,
}

struct ResourceGateState {
    max: usize,
    active: usize,
    waiting: usize,
}

struct ResourcePermit<'a> {
    gate: &'a ResourceGate,
}

struct IoBytesPermit<'a> {
    bytes: u64,
    counter: &'a AtomicU64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ResourceGateSnapshot {
    limit: usize,
    active: usize,
    waiting: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct IoWriterConfig {
    limit: usize,
    overridden: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum IoVolumeClass {
    FastLocal,
    FixedLocal,
    SlowOrRemote,
    Unknown,
}

#[derive(Clone, Copy, Debug, Default)]
struct IoAdaptationState {
    best_limit: usize,
    best_throughput_bytes_per_ms: f64,
    current_limit: usize,
    current_samples: usize,
    current_throughput_total: f64,
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
        Self::with_io_writer_config(initial_io_writer_config())
    }
}

impl TaskService {
    fn with_io_writer_config(io_config: IoWriterConfig) -> Self {
        let logical_cpus = std::thread::available_parallelism().map(|cpus| cpus.get()).unwrap_or(1);
        Self {
            inner: Arc::new(TaskServiceInner {
                shutdown: AtomicBool::new(false),
                in_flight: TaskRegistry::new(),
                cpu: ResourceGate::new(logical_cpus.saturating_mul(2).max(1)),
                io: ResourceGate::new(io_config.limit),
                io_writer_override: io_config.overridden,
                io_adaptation: Mutex::new(HashMap::new()),
                io_in_flight_bytes: AtomicU64::new(0),
                background: ResourceGate::new(1),
                background_cancel_epoch: AtomicU64::new(0),
                book_locks: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub(crate) fn begin_shutdown(&self) {
        self.inner.shutdown.store(true, Ordering::SeqCst);
        self.inner.background.notify_all();
    }

    pub(crate) fn cancel_background(&self) {
        self.inner.background_cancel_epoch.fetch_add(1, Ordering::SeqCst);
        self.inner.background.notify_all();
    }

    pub(crate) fn set_io_writer_limit(&self, max: usize) {
        self.inner.io.set_max(max.clamp(1, MAX_IO_WRITERS));
    }

    pub(crate) fn io_writer_limit(&self) -> usize {
        self.inner.io.max()
    }

    pub(crate) fn configure_io_for_path(&self, path: &Path) {
        if self.inner.io_writer_override {
            return;
        }
        self.inner
            .io
            .set_max(io_writer_limit_for_volume_class(classify_io_volume(path)));
    }

    pub(crate) fn record_io_observation(&self, volume_root: impl Into<String>, bytes: u64, elapsed: Duration) {
        if self.inner.io_writer_override || bytes == 0 || elapsed.is_zero() {
            return;
        }

        let current_limit = self.io_writer_limit();
        let throughput = bytes as f64 / elapsed.as_millis().max(1) as f64;
        let mut adaptations = match self.inner.io_adaptation.lock() {
            Ok(adaptations) => adaptations,
            Err(_) => return,
        };
        let state = adaptations
            .entry(volume_root.into())
            .or_insert_with(|| IoAdaptationState {
                best_limit: current_limit,
                best_throughput_bytes_per_ms: 0.0,
                current_limit,
                current_samples: 0,
                current_throughput_total: 0.0,
            });

        if state.current_limit != current_limit {
            state.current_limit = current_limit;
            state.current_samples = 0;
            state.current_throughput_total = 0.0;
        }

        state.current_samples += 1;
        state.current_throughput_total += throughput;
        let average = state.current_throughput_total / state.current_samples as f64;

        if state.best_throughput_bytes_per_ms == 0.0
            || average >= state.best_throughput_bytes_per_ms * IO_ADAPT_IMPROVEMENT_RATIO
        {
            state.best_throughput_bytes_per_ms = average;
            state.best_limit = current_limit;
        }

        if state.current_samples < IO_ADAPT_MIN_SAMPLES {
            return;
        }

        if current_limit > state.best_limit && average < state.best_throughput_bytes_per_ms * IO_ADAPT_IMPROVEMENT_RATIO
        {
            let next_limit = state.best_limit.max(1);
            self.inner.io.set_max(next_limit);
            state.current_limit = next_limit;
            state.current_samples = 0;
            state.current_throughput_total = 0.0;
            return;
        }

        if current_limit == state.best_limit && current_limit < MAX_IO_WRITERS {
            let next_limit = current_limit + 1;
            self.inner.io.set_max(next_limit);
            state.current_limit = next_limit;
            state.current_samples = 0;
            state.current_throughput_total = 0.0;
        }
    }

    pub(crate) fn diagnostic_fields(&self) -> Vec<(&'static str, String)> {
        let cpu = self.inner.cpu.snapshot();
        let io = self.inner.io.snapshot();
        let background = self.inner.background.snapshot();
        vec![
            ("task_in_flight", self.inner.in_flight.len().to_string()),
            ("cpu_limit", cpu.limit.to_string()),
            ("cpu_active", cpu.active.to_string()),
            ("cpu_waiting", cpu.waiting.to_string()),
            ("io_limit", io.limit.to_string()),
            ("io_active", io.active.to_string()),
            ("io_waiting", io.waiting.to_string()),
            (
                "io_in_flight_bytes",
                self.inner.io_in_flight_bytes.load(Ordering::SeqCst).to_string(),
            ),
            ("background_limit", background.limit.to_string()),
            ("background_active", background.active.to_string()),
            ("background_waiting", background.waiting.to_string()),
        ]
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

    pub(crate) fn run_io_observed<T>(
        &self,
        volume_path: impl AsRef<Path>,
        bytes: u64,
        priority: TaskPriority,
        task: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.ensure_accepting(priority)?;
        let volume = io_volume_identity(volume_path.as_ref());
        let started = Instant::now();
        let _permit = self.inner.io.acquire()?;
        let _bytes_permit = IoBytesPermit::new(&self.inner.io_in_flight_bytes, bytes);
        let result = task();
        if result.is_ok() {
            self.record_io_observation(volume, bytes, started.elapsed());
        }
        result
    }

    pub(crate) fn run_background<T>(&self, task: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        self.ensure_accepting(TaskPriority::Background)?;
        let cancel_epoch = self.inner.background_cancel_epoch.load(Ordering::SeqCst);
        let _permit = self.inner.background.acquire_interruptible(|| {
            self.inner.shutdown.load(Ordering::SeqCst)
                || self.inner.background_cancel_epoch.load(Ordering::SeqCst) != cancel_epoch
        })?;
        if self.inner.shutdown.load(Ordering::SeqCst)
            || self.inner.background_cancel_epoch.load(Ordering::SeqCst) != cancel_epoch
        {
            return Err("background work was cancelled".to_string());
        }
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
                waiting: 0,
            }),
            ready: Condvar::new(),
        }
    }

    fn acquire(&self) -> Result<ResourcePermit<'_>, String> {
        self.acquire_interruptible(|| false)
    }

    fn acquire_interruptible(&self, should_cancel: impl Fn() -> bool) -> Result<ResourcePermit<'_>, String> {
        if should_cancel() {
            return Err("task resource gate wait cancelled".to_string());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "task resource gate lock poisoned".to_string())?;
        while state.active >= state.max {
            if should_cancel() {
                return Err("task resource gate wait cancelled".to_string());
            }
            state.waiting += 1;
            state = self
                .ready
                .wait(state)
                .map_err(|_| "task resource gate lock poisoned".to_string())?;
            state.waiting = state.waiting.saturating_sub(1);
            if should_cancel() {
                return Err("task resource gate wait cancelled".to_string());
            }
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
        self.state.lock().map(|state| state.max).unwrap_or(DEFAULT_IO_WRITERS)
    }

    fn snapshot(&self) -> ResourceGateSnapshot {
        self.state
            .lock()
            .map(|state| ResourceGateSnapshot {
                limit: state.max,
                active: state.active,
                waiting: state.waiting,
            })
            .unwrap_or(ResourceGateSnapshot {
                limit: DEFAULT_IO_WRITERS,
                active: 0,
                waiting: 0,
            })
    }

    fn notify_all(&self) {
        self.ready.notify_all();
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

impl<'a> IoBytesPermit<'a> {
    fn new(counter: &'a AtomicU64, bytes: u64) -> Self {
        counter.fetch_add(bytes, Ordering::SeqCst);
        Self { bytes, counter }
    }
}

impl Drop for IoBytesPermit<'_> {
    fn drop(&mut self) {
        self.counter.fetch_sub(self.bytes, Ordering::SeqCst);
    }
}

fn initial_io_writer_limit() -> usize {
    initial_io_writer_config().limit
}

fn initial_io_writer_config() -> IoWriterConfig {
    io_writer_config_from_input(env::var(IO_WRITERS_ENV).ok().as_deref())
}

fn normalize_io_writer_limit(input: Option<&str>) -> usize {
    io_writer_config_from_input(input).limit
}

fn io_writer_config_from_input(input: Option<&str>) -> IoWriterConfig {
    let parsed = input.and_then(|value| value.trim().parse::<usize>().ok());
    match parsed {
        Some(limit) => IoWriterConfig {
            limit: limit.clamp(1, MAX_IO_WRITERS),
            overridden: true,
        },
        None => IoWriterConfig {
            limit: DEFAULT_IO_WRITERS,
            overridden: false,
        },
    }
}

fn io_writer_limit_for_volume_class(class: IoVolumeClass) -> usize {
    match class {
        IoVolumeClass::FastLocal => 2,
        IoVolumeClass::FixedLocal | IoVolumeClass::SlowOrRemote | IoVolumeClass::Unknown => DEFAULT_IO_WRITERS,
    }
}

#[cfg(not(windows))]
fn classify_io_volume(_path: &Path) -> IoVolumeClass {
    IoVolumeClass::Unknown
}

#[cfg(not(windows))]
fn io_volume_identity(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(windows)]
fn classify_io_volume(path: &Path) -> IoVolumeClass {
    let Some(root) = windows_volume_root(path) else {
        return IoVolumeClass::Unknown;
    };

    let root_wide = wide_null(&root);
    match unsafe { GetDriveTypeW(root_wide.as_ptr()) } {
        DRIVE_REMOTE | DRIVE_REMOVABLE => IoVolumeClass::SlowOrRemote,
        DRIVE_RAMDISK => IoVolumeClass::FastLocal,
        DRIVE_FIXED => {
            if windows_fixed_volume_is_fast(&root).unwrap_or(false) {
                IoVolumeClass::FastLocal
            } else {
                IoVolumeClass::FixedLocal
            }
        }
        _ => IoVolumeClass::Unknown,
    }
}

#[cfg(windows)]
fn io_volume_identity(path: &Path) -> String {
    windows_volume_root(path).unwrap_or_else(|| path.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn windows_volume_root(path: &Path) -> Option<String> {
    let text = path.to_string_lossy().replace('/', "\\");
    let mut chars = text.chars();
    let first = chars.next()?;
    if chars.next() == Some(':') {
        return Some(format!("{}:\\", first.to_ascii_uppercase()));
    }

    if !text.starts_with("\\\\") {
        return None;
    }

    let mut parts = text
        .trim_start_matches('\\')
        .split('\\')
        .filter(|part| !part.is_empty());
    let server = parts.next()?;
    let share = parts.next()?;
    Some(format!("\\\\{server}\\{share}\\"))
}

#[cfg(windows)]
fn windows_volume_handle_path(root: &str) -> Option<String> {
    let mut chars = root.chars();
    let letter = chars.next()?;
    if chars.next() == Some(':') {
        Some(format!("\\\\.\\{letter}:"))
    } else {
        None
    }
}

#[cfg(windows)]
fn windows_fixed_volume_is_fast(root: &str) -> Option<bool> {
    let handle_path = windows_volume_handle_path(root)?;
    let handle_path_wide = wide_null(&handle_path);
    let handle = unsafe {
        CreateFileW(
            handle_path_wide.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ptr::null(),
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return None;
    }

    let no_seek_penalty =
        query_storage_property::<DEVICE_SEEK_PENALTY_DESCRIPTOR>(handle, StorageDeviceSeekPenaltyProperty)
            .map(|descriptor| !descriptor.IncursSeekPenalty);
    let trim_enabled = query_storage_property::<DEVICE_TRIM_DESCRIPTOR>(handle, StorageDeviceTrimProperty)
        .map(|descriptor| descriptor.TrimEnabled);

    unsafe {
        CloseHandle(handle);
    }

    match (no_seek_penalty, trim_enabled) {
        (Some(true), _) | (_, Some(true)) => Some(true),
        (Some(false), _) | (None, Some(false)) => Some(false),
        (None, None) => None,
    }
}

#[cfg(windows)]
fn query_storage_property<T>(handle: windows_sys::Win32::Foundation::HANDLE, property: STORAGE_PROPERTY_ID) -> Option<T>
where
    T: Default,
{
    let query = STORAGE_PROPERTY_QUERY {
        PropertyId: property,
        QueryType: PropertyStandardQuery,
        AdditionalParameters: [0],
    };
    let mut output = T::default();
    let mut bytes_returned = 0u32;
    let ok = unsafe {
        DeviceIoControl(
            handle,
            IOCTL_STORAGE_QUERY_PROPERTY,
            &query as *const _ as *const _,
            std::mem::size_of::<STORAGE_PROPERTY_QUERY>() as u32,
            &mut output as *mut _ as *mut _,
            std::mem::size_of::<T>() as u32,
            &mut bytes_returned,
            ptr::null_mut(),
        )
    };
    if ok == 0 { None } else { Some(output) }
}

#[cfg(windows)]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
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
                    return Ok(BookOperationPermit { lock: Arc::clone(self) });
                }
                Some(owner) if owner == current_thread => {
                    state.depth += 1;
                    return Ok(BookOperationPermit { lock: Arc::clone(self) });
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
            Arc,
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        thread,
        time::{Duration, Instant},
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
    fn cancel_background_rejects_waiting_background_work_before_it_starts() {
        let service = Arc::new(TaskService::default());
        let executed = Arc::new(AtomicUsize::new(0));
        let (first_started_tx, first_started_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();

        let first = {
            let service = Arc::clone(&service);
            thread::spawn(move || {
                service.run_background(|| {
                    first_started_tx.send(()).unwrap();
                    release_first_rx.recv_timeout(Duration::from_secs(1)).unwrap();
                    Ok(())
                })
            })
        };

        first_started_rx.recv_timeout(Duration::from_millis(100)).unwrap();

        let second = {
            let service = Arc::clone(&service);
            let executed = Arc::clone(&executed);
            thread::spawn(move || {
                service.run_background(|| {
                    executed.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            })
        };

        let deadline = Instant::now() + Duration::from_secs(5);
        while service.inner.background.snapshot().waiting == 0 && Instant::now() < deadline {
            thread::yield_now();
        }
        assert_eq!(service.inner.background.snapshot().waiting, 1);
        service.cancel_background();
        release_first_tx.send(()).unwrap();

        first.join().unwrap().unwrap();
        assert!(second.join().unwrap().is_err());
        assert_eq!(executed.load(Ordering::SeqCst), 0);
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

        acquired_rx.recv_timeout(Duration::from_millis(100)).unwrap();
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

        acquired_rx.recv_timeout(Duration::from_millis(100)).unwrap();
        waiter.join().unwrap();
    }

    #[test]
    fn resource_gate_snapshot_reports_active_waiting_and_limit() {
        let gate = Arc::new(super::ResourceGate::new(1));
        let first = gate.acquire().unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        let waiter = {
            let gate = Arc::clone(&gate);
            thread::spawn(move || {
                started_tx.send(()).unwrap();
                let _permit = gate.acquire().unwrap();
                release_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            })
        };

        started_rx.recv_timeout(Duration::from_millis(100)).unwrap();
        thread::sleep(Duration::from_millis(30));

        let snapshot = gate.snapshot();
        assert_eq!(snapshot.limit, 1);
        assert_eq!(snapshot.active, 1);
        assert_eq!(snapshot.waiting, 1);

        drop(first);
        release_tx.send(()).unwrap();
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
    fn io_writer_limit_policy_uses_disk_hint_conservatively() {
        assert_eq!(
            super::io_writer_limit_for_volume_class(super::IoVolumeClass::FastLocal),
            2
        );
        assert_eq!(
            super::io_writer_limit_for_volume_class(super::IoVolumeClass::FixedLocal),
            1
        );
        assert_eq!(
            super::io_writer_limit_for_volume_class(super::IoVolumeClass::SlowOrRemote),
            1
        );
        assert_eq!(
            super::io_writer_limit_for_volume_class(super::IoVolumeClass::Unknown),
            1
        );
    }

    #[test]
    fn io_writer_env_config_overrides_disk_hint() {
        let configured = super::io_writer_config_from_input(Some("3"));
        assert_eq!(configured.limit, 3);
        assert!(configured.overridden);

        let defaulted = super::io_writer_config_from_input(None);
        assert_eq!(defaulted.limit, 1);
        assert!(!defaulted.overridden);
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
    fn io_feedback_probes_higher_writer_limit_after_stable_single_writer_samples() {
        let service = TaskService::with_io_writer_config(super::IoWriterConfig {
            limit: 1,
            overridden: false,
        });

        service.record_io_observation("C:\\", 1_000_000, Duration::from_millis(100));
        assert_eq!(service.io_writer_limit(), 1);

        service.record_io_observation("C:\\", 1_000_000, Duration::from_millis(100));
        assert_eq!(service.io_writer_limit(), 2);
    }

    #[test]
    fn io_feedback_reduces_writer_limit_when_probe_does_not_improve_throughput() {
        let service = TaskService::with_io_writer_config(super::IoWriterConfig {
            limit: 1,
            overridden: false,
        });

        service.record_io_observation("C:\\", 1_000_000, Duration::from_millis(100));
        service.record_io_observation("C:\\", 1_000_000, Duration::from_millis(100));
        assert_eq!(service.io_writer_limit(), 2);

        service.record_io_observation("C:\\", 1_000_000, Duration::from_millis(130));
        assert_eq!(service.io_writer_limit(), 2);

        service.record_io_observation("C:\\", 1_000_000, Duration::from_millis(130));
        assert_eq!(service.io_writer_limit(), 1);
    }

    #[test]
    fn io_feedback_keeps_explicit_writer_override_unchanged() {
        let service = TaskService::with_io_writer_config(super::IoWriterConfig {
            limit: 3,
            overridden: true,
        });

        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(10) {
            service.record_io_observation("C:\\", 1_000_000, Duration::from_millis(150));
        }

        assert_eq!(service.io_writer_limit(), 3);
    }

    #[test]
    fn observed_io_work_feeds_adaptive_writer_policy() {
        let service = TaskService::with_io_writer_config(super::IoWriterConfig {
            limit: 1,
            overridden: false,
        });

        service
            .run_io_observed("C:\\", 1_000_000, super::TaskPriority::Foreground, || Ok(()))
            .unwrap();
        assert_eq!(service.io_writer_limit(), 1);

        service
            .run_io_observed("C:\\", 1_000_000, super::TaskPriority::Foreground, || Ok(()))
            .unwrap();
        assert_eq!(service.io_writer_limit(), 2);
    }

    #[test]
    fn observed_io_work_reports_in_flight_bytes_while_task_runs() {
        let service = TaskService::with_io_writer_config(super::IoWriterConfig {
            limit: 1,
            overridden: false,
        });
        let observed = Arc::new(AtomicUsize::new(0));
        let observed_for_task = Arc::clone(&observed);
        let service_for_task = service.clone();

        service
            .run_io_observed("C:\\", 2048, super::TaskPriority::Foreground, move || {
                let fields = service_for_task.diagnostic_fields();
                let bytes = fields
                    .iter()
                    .find(|(key, _)| *key == "io_in_flight_bytes")
                    .and_then(|(_, value)| value.parse::<usize>().ok())
                    .unwrap_or(0);
                observed_for_task.store(bytes, Ordering::SeqCst);
                Ok(())
            })
            .unwrap();

        assert_eq!(observed.load(Ordering::SeqCst), 2048);
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
        let (first_entered_tx, first_entered_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();

        let first = {
            let service = Arc::clone(&service);
            let active = Arc::clone(&active);
            let max_active = Arc::clone(&max_active);
            thread::spawn(move || {
                service.run_book_exclusive("book-a", super::TaskPriority::Foreground, || {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(now, Ordering::SeqCst);
                    first_entered_tx.send(()).unwrap();
                    release_first_rx.recv().unwrap();
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
            })
        };

        first_entered_rx.recv().unwrap();
        let (second_entered_tx, second_entered_rx) = mpsc::channel();

        let second = {
            let service = Arc::clone(&service);
            let active = Arc::clone(&active);
            let max_active = Arc::clone(&max_active);
            thread::spawn(move || {
                service.run_book_exclusive("book-b", super::TaskPriority::Foreground, || {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(now, Ordering::SeqCst);
                    second_entered_tx.send(()).unwrap();
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
            })
        };

        let overlapped = second_entered_rx.recv_timeout(Duration::from_secs(5)).is_ok();
        release_first_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
        second.join().unwrap().unwrap();

        assert!(overlapped);
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
