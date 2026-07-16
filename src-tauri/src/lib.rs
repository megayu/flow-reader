use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};

use serde::Serialize;
use tauri::{Emitter, Manager, WindowEvent};

mod diagnostics;
pub mod dictionary;
mod storage;
mod tasks;

const OPEN_FILES_EVENT: &str = "flow-open-files";

#[derive(Default)]
struct PendingOpenFiles(Mutex<Vec<PathBuf>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemFont {
    family: String,
    label: String,
}

#[tauri::command]
fn list_system_fonts() -> Vec<SystemFont> {
    system_fonts::list()
}

#[tauri::command]
fn take_pending_open_paths(state: tauri::State<'_, PendingOpenFiles>) -> Vec<String> {
    let mut paths = state.0.lock().expect("pending open file lock poisoned");

    paths
        .drain(..)
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
fn is_devtools_enabled() -> bool {
    cfg!(feature = "devtools")
}

#[tauri::command]
fn toggle_devtools(window: tauri::WebviewWindow) {
    #[cfg(feature = "devtools")]
    {
        if window.is_devtools_open() {
            window.close_devtools();
        } else {
            window.open_devtools();
        }
    }

    #[cfg(not(feature = "devtools"))]
    {
        let _ = window;
    }
}

fn valid_external_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    !url.is_empty()
        && url.len() <= 8192
        && !url.chars().any(char::is_control)
        && (lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("mailto:"))
}

fn spawn_external_url_command(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        return Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to open external URL: {error}"));
    }

    #[cfg(target_os = "macos")]
    {
        return Command::new("open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to open external URL: {error}"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to open external URL: {error}"));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        let _ = url;
        Err("opening external URLs is not supported on this platform".to_string())
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !valid_external_url(&url) {
        return Err("only http, https, and mailto URLs can be opened externally".to_string());
    }

    spawn_external_url_command(&url)
}

fn collect_epub_paths<I, P>(paths: I) -> Vec<PathBuf>
where
    I: IntoIterator<Item = P>,
    P: Into<PathBuf>,
{
    paths
        .into_iter()
        .map(Into::into)
        .filter(|path| is_epub_file(path))
        .collect()
}

fn is_epub_file(path: &Path) -> bool {
    storage::is_epub_file(path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pending_open_files = collect_epub_paths(std::env::args_os().skip(1));

    tauri::Builder::default()
        .manage(PendingOpenFiles(Mutex::new(pending_open_files)))
        .manage(tasks::TaskService::default())
        .manage(dictionary::create_http_client().expect("dictionary HTTP client"))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths = collect_epub_paths(argv);
            if paths.is_empty() {
                return;
            }

            let payload = paths
                .into_iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect::<Vec<_>>();

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.emit(OPEN_FILES_EVENT, payload);
            }
        }))
        .setup(|app| {
            let storage = storage::AppStorage::load(app.handle()).map_err(std::io::Error::other)?;
            let dictionary_registry =
                dictionary::registry::DictionaryRegistryStore::open_for_app(storage.root());
            app.manage(dictionary_registry);
            app.manage(dictionary::session::DictionarySessionManager::default());
            app.manage(storage.clone());
            if let Some(tasks) = app.try_state::<tasks::TaskService>() {
                tasks.configure_io_for_path(storage.root());
                storage::schedule_existing_delete_tombstone_cleanup(&storage, &tasks);
            }

            if let Some(window) = app.get_webview_window("main") {
                storage::restore_window_state(&window);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();

                    let app = window.app_handle().clone();
                    let window = window.clone();
                    std::thread::spawn(move || {
                        if let Some(tasks) = app.try_state::<tasks::TaskService>() {
                            tasks.begin_shutdown();
                            tasks.cancel_background();
                        }
                        storage::flush_app_storage(&window);
                        if let Some(storage) = app.try_state::<storage::AppStorage>() {
                            if let Err(error) =
                                storage::cleanup_all_external_book_heavy_files(&storage)
                            {
                                eprintln!("Failed to cleanup external book files: {error}");
                            }
                        }
                        storage::save_window_state(&window);
                        app.exit(0);
                    });
                }
                WindowEvent::Destroyed => {
                    storage::flush_app_storage(window);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            is_devtools_enabled,
            list_system_fonts,
            open_external_url,
            take_pending_open_paths,
            toggle_devtools,
            dictionary::fetch_zdic,
            dictionary::fetch_merriam_webster,
            dictionary::cancel_dictionary_session,
            dictionary::list_local_dictionaries,
            dictionary::register_local_dictionary,
            dictionary::update_local_dictionary,
            dictionary::relocate_local_dictionary,
            dictionary::remove_local_dictionary,
            storage::list_books,
            storage::get_book,
            storage::open_book_directory,
            storage::list_tags,
            storage::create_tag,
            storage::update_tag,
            storage::delete_tag,
            storage::update_book_tags,
            storage::list_covers,
            storage::get_cover,
            storage::update_cover,
            storage::import_epub_paths,
            storage::open_external_epub_paths,
            storage::get_text_import_encodings,
            storage::preview_text_import_paths,
            storage::import_text_paths,
            storage::get_book_package_path,
            storage::get_book_reader_source,
            storage::search_book_text,
            storage::load_book_image_index,
            storage::store_book_image_index,
            storage::replace_book_text,
            storage::export_book,
            storage::unload_book_search_text,
            storage::cleanup_external_book,
            storage::cleanup_all_external_books,
            storage::delete_external_book,
            storage::record_reading_position,
            storage::update_book,
            storage::delete_books,
            storage::get_settings,
            storage::update_settings,
            storage::flush_storage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Flow");
}

#[cfg(target_os = "windows")]
mod system_fonts {
    use std::{
        collections::{BTreeMap, BTreeSet},
        path::Path,
    };

    use winreg::{
        enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ},
        types::FromRegValue,
        RegKey,
    };

    use super::SystemFont;

    const FONT_REGISTRY_PATH: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts";

    pub fn list() -> Vec<SystemFont> {
        let mut fonts = BTreeMap::new();

        collect_root(HKEY_LOCAL_MACHINE, &mut fonts);
        collect_root(HKEY_CURRENT_USER, &mut fonts);

        fonts.into_values().collect()
    }

    fn collect_root(root: winreg::HKEY, fonts: &mut BTreeMap<String, SystemFont>) {
        let root = RegKey::predef(root);
        if let Ok(key) = root.open_subkey_with_flags(FONT_REGISTRY_PATH, KEY_READ) {
            collect_key(&key, fonts);
        }
    }

    fn collect_key(key: &RegKey, fonts: &mut BTreeMap<String, SystemFont>) {
        for (name, value) in key.enum_values().filter_map(Result::ok) {
            let path = String::from_reg_value(&value).unwrap_or_default();
            for label in font_labels(&name, &path) {
                let sort_key = font_identity(&label);
                fonts.entry(sort_key).or_insert_with(|| SystemFont {
                    family: label.clone(),
                    label,
                });
            }
        }

        for subkey_name in key.enum_keys().filter_map(Result::ok) {
            if let Ok(subkey) = key.open_subkey_with_flags(subkey_name, KEY_READ) {
                collect_key(&subkey, fonts);
            }
        }
    }

    fn font_labels(registry_name: &str, font_path: &str) -> Vec<String> {
        let name = clean_registry_name(registry_name);
        let path_label = readable_path_stem(font_path);
        let source = if should_prefer_path_label(&name, path_label.as_deref()) {
            path_label.unwrap_or(name)
        } else {
            name
        };

        let mut seen = BTreeSet::new();

        source
            .split(" & ")
            .map(clean_family_name)
            .filter(|name| !name.is_empty() && seen.insert(font_identity(name)))
            .collect()
    }

    fn clean_registry_name(name: &str) -> String {
        let mut name = name.trim().trim_matches('"').to_string();
        for suffix in [
            " (TrueType)",
            " (OpenType)",
            " (Type 1)",
            " (Raster)",
            " (All res)",
        ] {
            if let Some(cleaned) = name.strip_suffix(suffix) {
                name = cleaned.trim().to_string();
                break;
            }
        }
        name
    }

    fn clean_family_name(name: &str) -> String {
        let mut name = strip_font_extension(name.trim().trim_matches('"')).to_string();
        name = expand_compact_family_name(&name);

        loop {
            let Some(cleaned) = strip_style_suffix(&name) else {
                break;
            };
            name = cleaned;
        }

        name.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    fn readable_path_stem(font_path: &str) -> Option<String> {
        Path::new(font_path)
            .file_stem()
            .map(|stem| stem.to_string_lossy().trim().to_string())
            .filter(|stem| !stem.is_empty())
    }

    fn strip_font_extension(name: &str) -> &str {
        let lower_name = name.to_ascii_lowercase();
        for extension in [".ttf", ".ttc", ".otf"] {
            if lower_name.ends_with(extension) {
                return name[..name.len() - extension.len()].trim();
            }
        }

        name
    }

    fn expand_compact_family_name(name: &str) -> String {
        let name = name.replace(['_', '-'], " ");
        let mut expanded = String::with_capacity(name.len() + 8);
        let mut prev = None;

        for ch in name.chars() {
            if let Some(prev_ch) = prev {
                if should_insert_space(prev_ch, ch) {
                    expanded.push(' ');
                }
            }
            expanded.push(ch);
            prev = Some(ch);
        }

        expanded
    }

    fn should_insert_space(prev: char, current: char) -> bool {
        (prev.is_ascii_lowercase() || prev.is_ascii_digit()) && current.is_ascii_uppercase()
    }

    fn strip_style_suffix(name: &str) -> Option<String> {
        for suffix in [
            " Bold Italic",
            " Bold Oblique",
            " Semibold Italic",
            " SemiBold Italic",
            " Light Italic",
            " Regular",
            " Bold",
            " Italic",
            " Oblique",
            " Semibold",
            " SemiBold",
            " Semilight",
            " SemiLight",
            " Medium",
            " Light",
            " Black",
        ] {
            if let Some(cleaned) = name.strip_suffix(suffix) {
                return Some(cleaned.trim().to_string());
            }
        }

        None
    }

    fn font_identity(name: &str) -> String {
        clean_family_name(name)
            .to_lowercase()
            .chars()
            .filter(|ch| ch.is_alphanumeric() || contains_cjk_char(*ch))
            .collect()
    }

    fn should_prefer_path_label(name: &str, path_label: Option<&str>) -> bool {
        let Some(path_label) = path_label else {
            return false;
        };

        (looks_mojibake(name) || !contains_cjk(name)) && contains_cjk(path_label)
    }

    fn contains_cjk(value: &str) -> bool {
        value.chars().any(contains_cjk_char)
    }

    fn contains_cjk_char(ch: char) -> bool {
        matches!(
            ch as u32,
            0x3400..=0x4dbf
                | 0x4e00..=0x9fff
                | 0xf900..=0xfaff
                | 0x20000..=0x2a6df
                | 0x2a700..=0x2b73f
                | 0x2b740..=0x2b81f
                | 0x2b820..=0x2ceaf
        )
    }

    fn looks_mojibake(value: &str) -> bool {
        let suspicious = value
            .chars()
            .filter(|ch| matches!(*ch as u32, 0xff00..=0xffef | 0xf000..=0xf8ff))
            .count();

        suspicious > 0 && suspicious * 2 >= value.chars().count()
    }
}

#[cfg(not(target_os = "windows"))]
mod system_fonts {
    use super::SystemFont;

    pub fn list() -> Vec<SystemFont> {
        Vec::new()
    }
}
