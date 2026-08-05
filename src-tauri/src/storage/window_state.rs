use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow, Window};

use super::*;

#[derive(Default)]
pub(crate) struct RuntimeWindowState(Mutex<Option<WindowState>>);

pub fn flush_app_storage(window: &Window) {
    if let Some(storage) = window.try_state::<AppStorage>() {
        if let Err(error) = storage.flush_all_derived_caches() {
            eprintln!("Failed to flush derived book caches: {error}");
        }
        if let Err(error) = storage.flush_dirty() {
            eprintln!("Failed to flush app storage: {error}");
        }
    }
}

pub fn restore_window_state(window: &WebviewWindow) {
    let _ = window.set_min_size(Some(PhysicalSize::new(
        MIN_RESTORED_WINDOW_WIDTH,
        MIN_RESTORED_WINDOW_HEIGHT,
    )));

    let app = window.app_handle();
    let monitors = window
        .available_monitors()
        .map(|monitors| monitors.iter().map(monitor_bounds).collect::<Vec<_>>())
        .unwrap_or_default();
    let primary = window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor_bounds(&monitor))
        .or_else(|| monitors.first().copied());
    let saved = window_state_path(app)
        .ok()
        .and_then(|path| read_json_or_default::<Option<WindowState>>(&path).ok().flatten())
        .filter(is_restorable_window_state);

    if let Some(mut state) = saved {
        if let Some(primary) = primary {
            normalize_window_state_for_monitors(&mut state, &monitors, primary);
        }
        set_runtime_window_state(app, state.clone());
        let _ = window.set_size(PhysicalSize::new(state.width, state.height));

        if state.maximized {
            let _ = window.set_position(PhysicalPosition::new(state.maximized_x, state.maximized_y));
            let _ = window.maximize();
        } else {
            let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
        }
        let _ = window.show();
        return;
    }

    let _ = window.show();
    let initial_monitor = primary.map(|monitor| PhysicalPosition::new(monitor.x, monitor.y));
    if let Some(state) = restored_webview_window_state(window, initial_monitor) {
        set_runtime_window_state(app, state);
    }
}

pub fn save_window_state(window: &Window) {
    record_window_state(window);

    let app = window.app_handle();
    let Ok(path) = window_state_path(app) else {
        return;
    };
    if let Some(state) = runtime_window_state(app)
        && is_restorable_window_state(&state)
    {
        let _ = write_json(&path, &state);
    }
}

pub(crate) fn record_window_state(window: &Window) {
    if !window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(false)
        || window.is_fullscreen().unwrap_or(false)
    {
        return;
    }
    let Some(monitor) = window.current_monitor().ok().flatten() else {
        return;
    };
    let Some(maximized) = window_is_maximized(window) else {
        return;
    };
    let Some(runtime) = window.try_state::<RuntimeWindowState>() else {
        return;
    };
    let Ok(mut runtime) = runtime.0.lock() else {
        return;
    };

    if maximized {
        if let Some(state) = runtime.as_mut() {
            update_maximized_state(state, *monitor.position());
        }
        return;
    }

    if let Some(state) = runtime.as_mut()
        && state.maximized
    {
        state.maximized = false;
        let restored = state.clone();
        drop(runtime);
        let _ = window.set_position(PhysicalPosition::new(restored.x, restored.y));
        let _ = window.set_size(PhysicalSize::new(restored.width, restored.height));
        return;
    }

    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    if let Some(state) = runtime.as_mut() {
        update_restored_state(state, position, size);
    } else {
        *runtime = Some(restored_state(position, size, *monitor.position()));
    }
}

fn runtime_window_state(app: &AppHandle) -> Option<WindowState> {
    app.try_state::<RuntimeWindowState>()
        .and_then(|state| state.0.lock().ok().and_then(|state| state.clone()))
}

fn set_runtime_window_state(app: &AppHandle, state: WindowState) {
    if let Some(runtime) = app.try_state::<RuntimeWindowState>()
        && let Ok(mut runtime) = runtime.0.lock()
    {
        *runtime = Some(state);
    }
}

fn restored_webview_window_state(
    window: &WebviewWindow,
    fallback_monitor: Option<PhysicalPosition<i32>>,
) -> Option<WindowState> {
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|monitor| *monitor.position())
        .or(fallback_monitor)?;
    Some(restored_state(position, size, monitor))
}

fn restored_state(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    monitor: PhysicalPosition<i32>,
) -> WindowState {
    WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: false,
        maximized_x: monitor.x,
        maximized_y: monitor.y,
    }
}

fn update_restored_state(state: &mut WindowState, position: PhysicalPosition<i32>, size: PhysicalSize<u32>) {
    state.x = position.x;
    state.y = position.y;
    state.width = size.width;
    state.height = size.height;
    state.maximized = false;
}

fn update_maximized_state(state: &mut WindowState, monitor: PhysicalPosition<i32>) {
    state.maximized = true;
    state.maximized_x = monitor.x;
    state.maximized_y = monitor.y;
}

#[cfg(windows)]
fn window_is_maximized(window: &Window) -> Option<bool> {
    use std::mem::size_of;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowPlacement, IsZoomed, SW_SHOWMAXIMIZED, WINDOWPLACEMENT, WPF_RESTORETOMAXIMIZED,
    };

    let hwnd = window.hwnd().ok()?.0;
    let mut placement = WINDOWPLACEMENT {
        length: size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    // SAFETY: `hwnd` is a live native window handle and `placement` is writable for this call.
    if unsafe { GetWindowPlacement(hwnd, &mut placement) } == 0 {
        return None;
    }
    Some(
        unsafe { IsZoomed(hwnd) } != 0
            || placement.showCmd == SW_SHOWMAXIMIZED as u32
            || placement.flags & WPF_RESTORETOMAXIMIZED != 0,
    )
}

#[cfg(not(windows))]
fn window_is_maximized(window: &Window) -> Option<bool> {
    window.is_maximized().ok()
}

fn is_restorable_window_state(state: &WindowState) -> bool {
    state.x > WINDOWS_MINIMIZED_POSITION_SENTINEL
        && state.y > WINDOWS_MINIMIZED_POSITION_SENTINEL
        && state.width >= MIN_RESTORED_WINDOW_WIDTH
        && state.height >= MIN_RESTORED_WINDOW_HEIGHT
}

#[derive(Debug, Clone, Copy)]
struct MonitorBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn normalize_window_state_for_monitors(
    state: &mut WindowState,
    monitors: &[MonitorBounds],
    primary: MonitorBounds,
) -> bool {
    let mut changed = false;
    if !monitors.iter().any(|monitor| window_intersects_monitor(state, monitor)) {
        state.x = primary.x + (primary.width.saturating_sub(state.width) / 2) as i32;
        state.y = primary.y + (primary.height.saturating_sub(state.height) / 2) as i32;
        changed = true;
    }

    if !monitors
        .iter()
        .any(|monitor| monitor_contains_position(monitor, state.maximized_x, state.maximized_y))
    {
        let monitor = monitors
            .iter()
            .find(|monitor| window_intersects_monitor(state, monitor))
            .copied()
            .unwrap_or(primary);
        state.maximized_x = monitor.x;
        state.maximized_y = monitor.y;
        changed = true;
    }

    changed
}

fn window_intersects_monitor(state: &WindowState, monitor: &MonitorBounds) -> bool {
    let window_right = state.x.saturating_add(state.width as i32);
    let window_bottom = state.y.saturating_add(state.height as i32);
    let monitor_right = monitor.x.saturating_add(monitor.width as i32);
    let monitor_bottom = monitor.y.saturating_add(monitor.height as i32);
    state.x < monitor_right && window_right > monitor.x && state.y < monitor_bottom && window_bottom > monitor.y
}

fn monitor_contains_position(monitor: &MonitorBounds, x: i32, y: i32) -> bool {
    x >= monitor.x
        && x < monitor.x.saturating_add(monitor.width as i32)
        && y >= monitor.y
        && y < monitor.y.saturating_add(monitor.height as i32)
}

fn monitor_bounds(monitor: &tauri::Monitor) -> MonitorBounds {
    MonitorBounds {
        x: monitor.position().x,
        y: monitor.position().y,
        width: monitor.size().width,
        height: monitor.size().height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_observations_update_only_the_fields_owned_by_each_mode() {
        let mut state = WindowState {
            x: 120,
            y: 80,
            width: 1100,
            height: 700,
            maximized: false,
            maximized_x: 0,
            maximized_y: 0,
        };

        update_restored_state(
            &mut state,
            PhysicalPosition::new(360, 240),
            PhysicalSize::new(1200, 800),
        );
        update_maximized_state(&mut state, PhysicalPosition::new(1920, 0));

        assert_eq!((state.x, state.y), (360, 240));
        assert_eq!((state.width, state.height), (1200, 800));
        assert!(state.maximized);
        assert_eq!((state.maximized_x, state.maximized_y), (1920, 0));
    }

    #[test]
    fn display_topology_keeps_visible_coordinates_and_recovers_removed_displays() {
        let primary = MonitorBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let secondary = MonitorBounds {
            x: 1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let state = WindowState {
            x: 2200,
            y: 100,
            width: 1000,
            height: 700,
            maximized: true,
            maximized_x: 1920,
            maximized_y: 0,
        };

        let mut added_display = state.clone();
        assert!(!normalize_window_state_for_monitors(
            &mut added_display,
            &[primary, secondary],
            primary,
        ));
        assert_eq!(added_display.x, 2200);
        assert_eq!(added_display.maximized_x, 1920);

        let mut removed_display = state;
        assert!(normalize_window_state_for_monitors(
            &mut removed_display,
            &[primary],
            primary,
        ));
        assert_eq!(removed_display.x, 460);
        assert_eq!(removed_display.y, 190);
        assert_eq!(removed_display.maximized_x, 0);
        assert_eq!(removed_display.maximized_y, 0);
    }
}
