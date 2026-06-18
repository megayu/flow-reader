use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_window_state::StateFlags;

const OPEN_FILES_EVENT: &str = "flow-open-files";

#[derive(Default)]
struct PendingOpenFiles(Mutex<Vec<PathBuf>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemFont {
    family: String,
    label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeOpenFile {
    name: String,
    path: String,
    mime_type: String,
    data: String,
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
fn read_native_epub_files(paths: Vec<String>) -> Result<Vec<NativeOpenFile>, String> {
    let mut files = Vec::new();

    for path in paths {
        let path = PathBuf::from(path);
        if !is_epub_file(&path) {
            continue;
        }

        let bytes =
            std::fs::read(&path).map_err(|error| format!("Failed to read {:?}: {error}", path))?;
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "book.epub".to_string());

        files.push(NativeOpenFile {
            name,
            path: path.to_string_lossy().to_string(),
            mime_type: "application/epub+zip".to_string(),
            data: STANDARD.encode(bytes),
        });
    }

    Ok(files)
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
    path.is_file()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pending_open_files = collect_epub_paths(std::env::args_os().skip(1));

    tauri::Builder::default()
        .manage(PendingOpenFiles(Mutex::new(pending_open_files)))
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
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.emit(OPEN_FILES_EVENT, payload);
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    StateFlags::SIZE
                        | StateFlags::POSITION
                        | StateFlags::MAXIMIZED
                        | StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            list_system_fonts,
            take_pending_open_paths,
            read_native_epub_files,
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
