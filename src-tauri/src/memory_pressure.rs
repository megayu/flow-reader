//! Event-driven OS memory warnings. No polling, inactivity timeout or tab events.

use tauri::{AppHandle, Emitter, Runtime};

fn notify<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit("flow-memory-pressure", ());
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::{
        io,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        sync::Mutex,
        thread::{self, JoinHandle},
    };
    use tauri::Manager;
    use windows_sys::Win32::{
        Foundation::{HANDLE, WAIT_OBJECT_0},
        System::{
            Memory::{CreateMemoryResourceNotification, HighMemoryResourceNotification, LowMemoryResourceNotification},
            Threading::{CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects},
        },
    };

    struct Worker {
        stop: OwnedHandle,
        thread: Option<JoinHandle<()>>,
    }

    impl Drop for Worker {
        fn drop(&mut self) {
            // The stop handle participates in both waits, including recovery.
            unsafe { SetEvent(self.stop.as_raw_handle() as HANDLE) };
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    struct Monitor(Mutex<Option<Worker>>);

    fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
        if handle.is_null() {
            Err(io::Error::last_os_error())
        } else {
            // SAFETY: each non-null API result transfers one owned kernel handle.
            Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
        }
    }

    pub fn start<R: Runtime>(app: &AppHandle<R>) -> io::Result<()> {
        let low = owned(unsafe { CreateMemoryResourceNotification(LowMemoryResourceNotification) })?;
        let high = owned(unsafe { CreateMemoryResourceNotification(HighMemoryResourceNotification) })?;
        let stop = owned(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) })?;
        let stopped = stop.try_clone()?;
        let app_handle = app.clone();
        let thread = thread::Builder::new().name("memory-pressure".into()).spawn(move || {
            loop {
                let handles = [stopped.as_raw_handle() as HANDLE, low.as_raw_handle() as HANDLE];
                // SAFETY: all handles are retained by this thread until it exits.
                if unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) } != WAIT_OBJECT_0 + 1 {
                    break;
                }
                notify(&app_handle);
                // Memory notification handles are level-triggered. Wait for
                // recovery before rearming, rather than spinning while low.
                let handles = [stopped.as_raw_handle() as HANDLE, high.as_raw_handle() as HANDLE];
                if unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) } != WAIT_OBJECT_0 + 1 {
                    break;
                }
            }
        })?;
        app.manage(Monitor(Mutex::new(Some(Worker {
            stop,
            thread: Some(thread),
        }))));
        Ok(())
    }

    pub fn stop<R: Runtime>(app: &AppHandle<R>) {
        if let Some(monitor) = app.try_state::<Monitor>()
            && let Ok(mut guard) = monitor.0.lock()
        {
            guard.take();
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use dispatch2::{_dispatch_source_type_memorypressure, DispatchObject, DispatchRetained, DispatchSource};
    use std::sync::Mutex;
    use tauri::Manager;

    struct Monitor(Mutex<Option<DispatchRetained<DispatchSource>>>);

    pub fn start<R: Runtime>(app: &AppHandle<R>) -> std::io::Result<()> {
        let app_handle = app.clone();
        let handler = block2::RcBlock::new(move || notify(&app_handle));
        // SAFETY: the source type and WARN|CRITICAL mask are libdispatch's
        // memory-pressure constants; the copied block owns its AppHandle.
        let source = unsafe {
            let source = DispatchSource::new(
                std::ptr::addr_of!(_dispatch_source_type_memorypressure).cast_mut(),
                0,
                0x2 | 0x4,
                None,
            );
            source.set_event_handler_with_block(block2::RcBlock::as_ptr(&handler));
            source.activate();
            source
        };
        app.manage(Monitor(Mutex::new(Some(source))));
        Ok(())
    }

    pub fn stop<R: Runtime>(app: &AppHandle<R>) {
        if let Some(monitor) = app.try_state::<Monitor>()
            && let Ok(mut source) = monitor.0.lock()
            && let Some(source) = source.take()
        {
            source.cancel();
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use gio::prelude::*;
    use std::cell::RefCell;

    thread_local! {
        // GIO emits on GTK's default main context; release on that same thread.
        static MONITOR: RefCell<Option<(gio::MemoryMonitor, gio::glib::SignalHandlerId)>> = const { RefCell::new(None) };
    }

    pub fn start<R: Runtime>(app: &AppHandle<R>) -> std::io::Result<()> {
        let monitor = gio::MemoryMonitor::dup_default();
        let app_handle = app.clone();
        let handler = monitor.connect_low_memory_warning(move |_, _| notify(&app_handle));
        MONITOR.with(|slot| slot.replace(Some((monitor, handler))));
        Ok(())
    }

    pub fn stop<R: Runtime>(_: &AppHandle<R>) {
        MONITOR.with(|slot| {
            if let Some((monitor, handler)) = slot.take() {
                monitor.disconnect(handler);
            }
        });
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
pub use platform::{start, stop};
