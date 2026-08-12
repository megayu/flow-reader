use super::text_import::default_text_import_rules_input;
use super::{AppStorage, TextImportRulesInput};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsBootstrap {
    settings: Value,
    text_import_rule_defaults: TextImportRulesInput,
}

#[derive(Clone, Copy, Deserialize)]
pub enum TextImportRuleKind {
    #[serde(rename = "groupPatterns")]
    Group,
    #[serde(rename = "chapterPatterns")]
    Chapter,
    #[serde(rename = "filenamePatterns")]
    Filename,
}

pub(super) fn initialize_first_launch_settings(settings: &mut Value) -> Result<(), String> {
    settings
        .as_object_mut()
        .ok_or_else(|| "Settings root must be an object".to_string())?
        .insert(
            "textImportRules".to_string(),
            serde_json::to_value(default_text_import_rules_input()).map_err(|error| error.to_string())?,
        );
    Ok(())
}

pub(super) fn text_import_rules_from_settings(settings: &Value) -> TextImportRulesInput {
    text_import_rules_with_fallback(settings, default_text_import_rules_input())
}

fn text_import_rules_with_fallback(settings: &Value, fallback: TextImportRulesInput) -> TextImportRulesInput {
    let rules = settings.get("textImportRules").and_then(Value::as_object);
    let patterns = |key: &str, fallback: Vec<String>| {
        rules
            .and_then(|value| value.get(key))
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or(fallback)
    };

    TextImportRulesInput {
        group_patterns: patterns("groupPatterns", fallback.group_patterns),
        chapter_patterns: patterns("chapterPatterns", fallback.chapter_patterns),
        filename_patterns: patterns("filenamePatterns", fallback.filename_patterns),
    }
}

#[tauri::command]
pub fn get_settings(storage: State<'_, AppStorage>) -> Result<SettingsBootstrap, String> {
    let state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    Ok(SettingsBootstrap {
        settings: state.settings.clone(),
        text_import_rule_defaults: default_text_import_rules_input(),
    })
}

#[tauri::command]
pub fn update_settings(storage: State<'_, AppStorage>, settings: Value, flush: bool) -> Result<(), String> {
    update_settings_impl(&storage, settings, flush)
}

pub(super) fn update_settings_impl(storage: &AppStorage, settings: Value, flush: bool) -> Result<(), String> {
    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let current_rules = state.text_import_rules.clone();
        state.text_import_rules = text_import_rules_with_fallback(&settings, current_rules);
        state.settings = settings;
    }

    storage.mark_settings_dirty();
    if flush { storage.flush_settings_dirty() } else { Ok(()) }
}

#[tauri::command]
pub fn reset_text_import_rule(storage: State<'_, AppStorage>, kind: TextImportRuleKind) -> Result<(), String> {
    let defaults = default_text_import_rules_input();
    let (key, patterns) = match kind {
        TextImportRuleKind::Group => ("groupPatterns", defaults.group_patterns),
        TextImportRuleKind::Chapter => ("chapterPatterns", defaults.chapter_patterns),
        TextImportRuleKind::Filename => ("filenamePatterns", defaults.filename_patterns),
    };
    {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let settings = state
            .settings
            .as_object_mut()
            .ok_or_else(|| "Settings root must be an object".to_string())?;
        let rules = settings.entry("textImportRules").or_insert_with(|| json!({}));
        if !rules.is_object() {
            *rules = json!({});
        }
        rules
            .as_object_mut()
            .expect("text import rules were initialized as an object")
            .insert(key.to_string(), json!(patterns.clone()));
        match kind {
            TextImportRuleKind::Group => state.text_import_rules.group_patterns = patterns,
            TextImportRuleKind::Chapter => state.text_import_rules.chapter_patterns = patterns,
            TextImportRuleKind::Filename => state.text_import_rules.filename_patterns = patterns,
        }
    }
    storage.mark_settings_dirty();
    Ok(())
}

#[tauri::command]
pub fn flush_settings(storage: State<'_, AppStorage>) -> Result<(), String> {
    flush_settings_impl(&storage)
}

pub(super) fn flush_settings_impl(storage: &AppStorage) -> Result<(), String> {
    storage.flush_settings_dirty()
}
