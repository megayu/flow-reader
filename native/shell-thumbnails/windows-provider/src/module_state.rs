use std::sync::atomic::{AtomicUsize, Ordering};

static OBJECTS: AtomicUsize = AtomicUsize::new(0);
static SERVER_LOCKS: AtomicUsize = AtomicUsize::new(0);

pub(crate) fn add_object() {
    OBJECTS.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn remove_object() {
    OBJECTS.fetch_sub(1, Ordering::Release);
}

pub(crate) fn set_server_lock(locked: bool) {
    if locked {
        SERVER_LOCKS.fetch_add(1, Ordering::Relaxed);
    } else {
        let _ = SERVER_LOCKS.fetch_update(Ordering::Release, Ordering::Relaxed, |value| {
            value.checked_sub(1)
        });
    }
}

pub(crate) fn can_unload() -> bool {
    OBJECTS.load(Ordering::Acquire) == 0 && SERVER_LOCKS.load(Ordering::Acquire) == 0
}
