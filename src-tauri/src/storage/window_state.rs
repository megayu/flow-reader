use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow, Window};

use super::*;
pub fn flush_app_storage(window: &Window) {
    if let Some(storage) = window.try_state::<AppStorage>() {
        if let Err(error) = storage.flush_dirty() {
            eprintln!("Failed to flush app storage: {error}");
        }
    }
}

pub fn restore_window_state(window: &WebviewWindow) {
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

        let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
        let _ = window.set_size(PhysicalSize::new(state.width, state.height));

        if state.fullscreen {
            let _ = window.set_fullscreen(true);
        } else if state.maximized {
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
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);

    let state = WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
        fullscreen,
    };

    if !is_restorable_window_state(&state) {
        return;
    }

    if let Ok(path) = window_state_path(app) {
        let _ = write_json(&path, &state);
    }
}

fn is_restorable_window_state(state: &WindowState) -> bool {
    state.x > WINDOWS_MINIMIZED_POSITION_SENTINEL
        && state.y > WINDOWS_MINIMIZED_POSITION_SENTINEL
        && state.width >= MIN_RESTORED_WINDOW_WIDTH
        && state.height >= MIN_RESTORED_WINDOW_HEIGHT
}
