use serde::Serialize;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_system_fonts])
        .run(tauri::generate_context!())
        .expect("error while running Flow");
}

#[cfg(target_os = "windows")]
mod system_fonts {
    use std::{collections::BTreeMap, path::Path};

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
                let sort_key = label.to_lowercase();
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

        source
            .split(" & ")
            .map(clean_family_name)
            .filter(|name| !name.is_empty())
            .collect()
    }

    fn clean_registry_name(name: &str) -> String {
        let mut name = name.trim().to_string();
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
        let mut name = name.trim().to_string();
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
                name = cleaned.trim().to_string();
                break;
            }
        }
        name
    }

    fn readable_path_stem(font_path: &str) -> Option<String> {
        Path::new(font_path)
            .file_stem()
            .map(|stem| stem.to_string_lossy().trim().to_string())
            .filter(|stem| !stem.is_empty())
    }

    fn should_prefer_path_label(name: &str, path_label: Option<&str>) -> bool {
        let Some(path_label) = path_label else {
            return false;
        };

        (looks_mojibake(name) || !contains_cjk(name)) && contains_cjk(path_label)
    }

    fn contains_cjk(value: &str) -> bool {
        value.chars().any(|ch| {
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
        })
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
