use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow, Window};

use super::*;
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
    let Ok(path) = window_state_path(app) else {
        let _ = window.show();
        return;
    };
    let Ok(state) = read_json_or_default::<Option<WindowState>>(&path) else {
        let _ = window.show();
        return;
    };

    if let Some(state) = state {
        if !is_restorable_window_state(&state) {
            let _ = window.show();
            return;
        }

        let bounds = restorable_bounds(window, &state);
        let _ = window.set_position(PhysicalPosition::new(bounds.x, bounds.y));
        let _ = window.set_size(PhysicalSize::new(bounds.width, bounds.height));

        if state.maximized {
            let _ = window.maximize();
        }
    }

    let _ = window.show();
}

pub fn save_window_state(window: &Window) {
    if window.is_minimized().unwrap_or(false) {
        return;
    }

    let app = window.app_handle();
    let maximized = window.is_maximized().unwrap_or(false);
    if window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let Ok(path) = window_state_path(app) else {
        return;
    };

    let state = if maximized {
        let monitors = window_monitor_bounds(window);
        let current_monitor = window
            .current_monitor()
            .ok()
            .flatten()
            .map(|monitor| monitor_bounds(&monitor));
        let existing = read_json_or_default::<Option<WindowState>>(&path)
            .ok()
            .flatten()
            .filter(is_restorable_window_state)
            .filter(|state| {
                !looks_like_maximized_bounds(
                    &monitors,
                    &WindowBounds {
                        x: state.x,
                        y: state.y,
                        width: state.width,
                        height: state.height,
                    },
                )
            });
        window_state_with_display_flags(
            existing,
            default_centered_window_state_from_monitors(&monitors),
            maximized,
            current_monitor,
        )
    } else {
        let Ok(position) = window.outer_position() else {
            return;
        };
        let Ok(size) = window.outer_size() else {
            return;
        };

        WindowState {
            x: position.x,
            y: position.y,
            width: size.width.max(MIN_RESTORED_WINDOW_WIDTH),
            height: size.height.max(MIN_RESTORED_WINDOW_HEIGHT),
            maximized,
        }
    };

    if !is_restorable_window_state(&state) {
        return;
    }

    let _ = write_json(&path, &state);
}

fn is_restorable_window_state(state: &WindowState) -> bool {
    state.x > WINDOWS_MINIMIZED_POSITION_SENTINEL
        && state.y > WINDOWS_MINIMIZED_POSITION_SENTINEL
        && state.width >= MIN_RESTORED_WINDOW_WIDTH
        && state.height >= MIN_RESTORED_WINDOW_HEIGHT
}

#[derive(Debug, Clone, Copy)]
struct WindowBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Copy)]
struct MonitorBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn restorable_bounds(window: &WebviewWindow, state: &WindowState) -> WindowBounds {
    restorable_bounds_for_monitors(state, &webview_monitor_bounds(window))
}

fn restorable_bounds_for_monitors(state: &WindowState, monitors: &[MonitorBounds]) -> WindowBounds {
    let saved = WindowBounds {
        x: state.x,
        y: state.y,
        width: state.width.max(MIN_RESTORED_WINDOW_WIDTH),
        height: state.height.max(MIN_RESTORED_WINDOW_HEIGHT),
    };

    if state.maximized && looks_like_maximized_bounds(monitors, &saved) {
        return center_bounds(
            preferred_monitor(monitors),
            DEFAULT_RESTORED_WINDOW_WIDTH,
            DEFAULT_RESTORED_WINDOW_HEIGHT,
        );
    }

    if monitors.iter().any(|monitor| contains_window(monitor, &saved)) {
        return saved;
    }

    center_bounds(
        preferred_monitor(monitors),
        saved.width.min(DEFAULT_RESTORED_WINDOW_WIDTH),
        saved.height.min(DEFAULT_RESTORED_WINDOW_HEIGHT),
    )
}

fn window_state_with_display_flags(
    existing: Option<WindowState>,
    fallback: WindowState,
    maximized: bool,
    current_monitor: Option<MonitorBounds>,
) -> WindowState {
    let mut state = existing.unwrap_or(fallback);
    state.maximized = maximized;

    if let Some(monitor) = current_monitor {
        let restored_bounds = WindowBounds {
            x: state.x,
            y: state.y,
            width: state.width,
            height: state.height,
        };
        if !contains_window(&monitor, &restored_bounds) {
            let relocated = center_bounds(Some(monitor), state.width, state.height);
            state.x = relocated.x;
            state.y = relocated.y;
            state.width = relocated.width;
            state.height = relocated.height;
        }
    }

    state
}

fn default_centered_window_state_from_monitors(monitors: &[MonitorBounds]) -> WindowState {
    let bounds = center_bounds(
        preferred_monitor(monitors),
        DEFAULT_RESTORED_WINDOW_WIDTH,
        DEFAULT_RESTORED_WINDOW_HEIGHT,
    );

    WindowState {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: false,
    }
}

#[cfg(test)]
// Platform monitor adapters stay below the pure state tests to keep OS calls out of test setup.
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    #[test]
    fn maximized_state_reuses_existing_restored_bounds() {
        let existing = WindowState {
            x: 120,
            y: 80,
            width: 1100,
            height: 700,
            maximized: false,
        };
        let fallback = WindowState {
            x: 0,
            y: 0,
            width: DEFAULT_RESTORED_WINDOW_WIDTH,
            height: DEFAULT_RESTORED_WINDOW_HEIGHT,
            maximized: false,
        };

        let current_monitor = MonitorBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };

        let state = window_state_with_display_flags(Some(existing), fallback, true, Some(current_monitor));

        assert_eq!(state.x, 120);
        assert_eq!(state.y, 80);
        assert_eq!(state.width, 1100);
        assert_eq!(state.height, 700);
        assert!(state.maximized);
    }

    #[test]
    fn offscreen_restored_bounds_are_centered_on_available_monitor() {
        let state = WindowState {
            x: 3000,
            y: 100,
            width: 1000,
            height: 700,
            maximized: false,
        };
        let monitors = [MonitorBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        }];

        let bounds = restorable_bounds_for_monitors(&state, &monitors);

        assert_eq!(bounds.x, 460);
        assert_eq!(bounds.y, 190);
        assert_eq!(bounds.width, 1000);
        assert_eq!(bounds.height, 700);
    }

    #[test]
    fn maximized_state_with_screen_sized_saved_bounds_uses_default_restored_bounds() {
        let state = WindowState {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            maximized: true,
        };
        let monitors = [MonitorBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        }];

        let bounds = restorable_bounds_for_monitors(&state, &monitors);

        assert_eq!(bounds.x, 320);
        assert_eq!(bounds.y, 140);
        assert_eq!(bounds.width, DEFAULT_RESTORED_WINDOW_WIDTH);
        assert_eq!(bounds.height, DEFAULT_RESTORED_WINDOW_HEIGHT);
    }

    #[test]
    fn undersized_restored_bounds_are_clamped_to_minimum_size() {
        let state = WindowState {
            x: 10,
            y: 10,
            width: 1,
            height: 1,
            maximized: false,
        };
        let monitors = [MonitorBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        }];

        let bounds = restorable_bounds_for_monitors(&state, &monitors);

        assert_eq!(bounds.x, 10);
        assert_eq!(bounds.y, 10);
        assert_eq!(bounds.width, MIN_RESTORED_WINDOW_WIDTH);
        assert_eq!(bounds.height, MIN_RESTORED_WINDOW_HEIGHT);
    }
}

fn webview_monitor_bounds(window: &WebviewWindow) -> Vec<MonitorBounds> {
    window
        .available_monitors()
        .map(|monitors| monitors.iter().map(monitor_bounds).collect())
        .unwrap_or_default()
}

fn window_monitor_bounds(window: &Window) -> Vec<MonitorBounds> {
    window
        .available_monitors()
        .map(|monitors| monitors.iter().map(monitor_bounds).collect())
        .unwrap_or_default()
}

fn monitor_bounds(monitor: &tauri::Monitor) -> MonitorBounds {
    let position = monitor.position();
    let size = monitor.size();
    MonitorBounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    }
}

fn preferred_monitor(monitors: &[MonitorBounds]) -> Option<MonitorBounds> {
    monitors.first().copied()
}

fn contains_window(monitor: &MonitorBounds, window: &WindowBounds) -> bool {
    let monitor_right = monitor.x.saturating_add(monitor.width as i32);
    let monitor_bottom = monitor.y.saturating_add(monitor.height as i32);
    let window_right = window.x.saturating_add(window.width as i32);
    let window_bottom = window.y.saturating_add(window.height as i32);

    window.x >= monitor.x && window.y >= monitor.y && window_right <= monitor_right && window_bottom <= monitor_bottom
}

fn looks_like_maximized_bounds(monitors: &[MonitorBounds], window: &WindowBounds) -> bool {
    monitors.iter().any(|monitor| {
        let width_threshold = monitor.width.saturating_sub(MAXIMIZED_BOUNDS_TOLERANCE);
        let height_threshold = monitor.height.saturating_sub(MAXIMIZED_BOUNDS_TOLERANCE);
        window.width >= width_threshold && window.height >= height_threshold
    })
}

fn center_bounds(monitor: Option<MonitorBounds>, width: u32, height: u32) -> WindowBounds {
    let width = width.max(MIN_RESTORED_WINDOW_WIDTH);
    let height = height.max(MIN_RESTORED_WINDOW_HEIGHT);
    let Some(monitor) = monitor else {
        return WindowBounds {
            x: 0,
            y: 0,
            width,
            height,
        };
    };

    let width = width.min(monitor.width.max(MIN_RESTORED_WINDOW_WIDTH));
    let height = height.min(monitor.height.max(MIN_RESTORED_WINDOW_HEIGHT));
    let x = monitor.x + ((monitor.width.saturating_sub(width)) / 2) as i32;
    let y = monitor.y + ((monitor.height.saturating_sub(height)) / 2) as i32;

    WindowBounds { x, y, width, height }
}
