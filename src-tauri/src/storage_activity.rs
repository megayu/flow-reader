use std::sync::{Condvar, Mutex, OnceLock};

use tauri::{
    Runtime,
    ipc::{CommandArg, CommandItem, InvokeError},
};

#[derive(Default)]
struct Activity {
    migrating: bool,
    exiting: bool,
    active: usize,
}

fn activity() -> &'static (Mutex<Activity>, Condvar) {
    static ACTIVITY: OnceLock<(Mutex<Activity>, Condvar)> = OnceLock::new();
    ACTIVITY.get_or_init(|| (Mutex::new(Activity::default()), Condvar::new()))
}

pub(crate) struct StorageOperation;

impl StorageOperation {
    pub(crate) fn enter() -> Result<Self, String> {
        let mut state = activity().0.lock().map_err(|_| "storage activity lock poisoned")?;
        if state.migrating {
            return Err("storage migration is in progress".into());
        }
        state.active += 1;
        Ok(Self)
    }
}

// State access holds a permit for the complete command, including awaited workers.
pub struct StorageAccess<'r, T: Send + Sync + 'static> {
    state: tauri::State<'r, T>,
    _permit: StorageOperation,
}

impl<T: Send + Sync + 'static> StorageAccess<'_, T> {
    pub(crate) fn inner(&self) -> &T {
        self.state.inner()
    }
}

impl<T: Send + Sync + 'static> std::ops::Deref for StorageAccess<'_, T> {
    type Target = T;

    fn deref(&self) -> &T {
        self.inner()
    }
}

impl<'r, 'de: 'r, T: Send + Sync + 'static, R: Runtime> CommandArg<'de, R> for StorageAccess<'r, T> {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let permit = StorageOperation::enter().map_err(InvokeError::from)?;
        Ok(Self {
            state: tauri::State::from_command(command)?,
            _permit: permit,
        })
    }
}

impl Drop for StorageOperation {
    fn drop(&mut self) {
        if let Ok(mut state) = activity().0.lock() {
            state.active -= 1;
            activity().1.notify_all();
        }
    }
}

pub(crate) struct StorageMigration {
    committed: bool,
}

impl StorageMigration {
    pub(crate) fn begin() -> Result<Self, String> {
        let (lock, ready) = activity();
        let mut state = lock.lock().map_err(|_| "storage activity lock poisoned")?;
        if state.exiting {
            return Err("app exit is in progress".into());
        }
        if state.migrating {
            return Err("storage migration is in progress".into());
        }
        state.migrating = true;
        while state.active != 0 {
            state = ready.wait(state).map_err(|_| "storage activity lock poisoned")?;
        }
        Ok(Self { committed: false })
    }

    pub(crate) fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for StorageMigration {
    fn drop(&mut self) {
        // Successful migration keeps old-root writers disabled through restart.
        if !self.committed
            && let Ok(mut state) = activity().0.lock()
        {
            state.migrating = false;
        }
    }
}

pub(crate) fn is_migrating() -> bool {
    activity().0.lock().map_or(true, |state| state.migrating)
}

pub(crate) fn begin_exit() -> bool {
    let Ok(mut state) = activity().0.lock() else {
        return false;
    };
    if state.migrating || state.exiting {
        return false;
    }
    state.exiting = true;
    true
}
