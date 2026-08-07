use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use encoding_rs::{
    BIG5, EUC_KR, Encoding, GB18030, SHIFT_JIS, UTF_8, UTF_16BE, UTF_16LE, WINDOWS_1250, WINDOWS_1251, WINDOWS_1252,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::*;
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextImportEncodingOption {
    pub(super) id: String,
    pub(super) label: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextImportSelection {
    pub(super) path: String,
    #[serde(default)]
    pub(super) encoding: Option<String>,
    #[serde(default)]
    pub(super) title: Option<String>,
    #[serde(default)]
    pub(super) creator: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextImportRulesInput {
    #[serde(default)]
    pub(super) group_patterns: Vec<String>,
    #[serde(default)]
    pub(super) chapter_patterns: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextImportStatus {
    Ready,
    NeedsReview,
    Error,
    Skipped,
}

impl TextImportStatus {
    fn as_str(self) -> &'static str {
        match self {
            TextImportStatus::Ready => "ready",
            TextImportStatus::NeedsReview => "needsReview",
            TextImportStatus::Error => "error",
            TextImportStatus::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextImportPreview {
    pub(super) path: String,
    pub(super) filename: String,
    pub(super) title: String,
    pub(super) encoding: String,
    pub(super) encoding_label: String,
    pub(super) confidence: String,
    pub(super) status: String,
    pub(super) selected: bool,
    pub(super) message: Option<String>,
    pub(super) sample: String,
    pub(super) chapters: Vec<TextImportChapterPreview>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextImportChapterPreview {
    pub(super) title: String,
    pub(super) level: u8,
    pub(super) role: String,
}

#[derive(Debug, Clone)]
pub(super) struct DecodedText {
    pub(super) text: String,
    pub(super) encoding: String,
    pub(super) encoding_label: String,
    pub(super) confidence: TextEncodingConfidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TextEncodingConfidence {
    High,
    Medium,
    Low,
    Failed,
}

#[derive(Debug, Clone)]
pub(super) struct TextImportDocument {
    pub(super) title: String,
    pub(super) creator: String,
    pub(super) sections: Vec<TextImportSection>,
    pub(super) chapters: Vec<TextImportChapterPreview>,
}

#[derive(Debug, Clone)]
pub(super) struct TextImportSection {
    pub(super) title: String,
    pub(super) parent: Option<String>,
    pub(super) paragraphs: Vec<String>,
    pub(super) is_group: bool,
}

#[derive(Debug, Clone, Eq, Hash, PartialEq)]
pub(super) struct TextImportPreparedKey {
    identity: String,
}

#[derive(Debug, Clone)]
pub(super) struct PreparedTextImport {
    pub(super) key: TextImportPreparedKey,
    pub(super) path: PathBuf,
    pub(super) filename: String,
    pub(super) fallback_title: String,
    pub(super) size: u64,
    pub(super) hash: String,
    pub(super) bytes: Arc<Vec<u8>>,
    pub(super) decoded: DecodedText,
    pub(super) sample: String,
    pub(super) document: TextImportDocument,
}

struct PreparedTextImportCacheEntry {
    prepared: Arc<PreparedTextImport>,
    inserted_at: u64,
}

pub(super) struct TextImportPreparedCache {
    entries: HashMap<TextImportPreparedKey, PreparedTextImportCacheEntry>,
    order: VecDeque<TextImportPreparedKey>,
    bytes: usize,
    max_bytes: usize,
}

const TEXT_IMPORT_PREPARED_CACHE_MAX_BYTES: usize = 256 * 1024 * 1024;
const TEXT_IMPORT_PREPARED_CACHE_TTL: Duration = Duration::from_secs(10 * 60);

impl TextImportPreparedKey {
    pub(super) fn task_identity(&self) -> &str {
        &self.identity
    }
}

impl TextImportPreparedCache {
    pub(super) fn new() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            max_bytes: TEXT_IMPORT_PREPARED_CACHE_MAX_BYTES,
        }
    }

    pub(super) fn get(&mut self, key: &TextImportPreparedKey) -> Option<Arc<PreparedTextImport>> {
        self.remove_expired();
        let prepared = self.entries.get(key)?.prepared.clone();
        self.touch(key);
        Some(prepared)
    }

    pub(super) fn insert(&mut self, prepared: Arc<PreparedTextImport>) {
        self.remove_expired();
        let key = prepared.key.clone();
        let bytes = prepared.bytes.len();
        self.remove_key(&key);
        if bytes > self.max_bytes {
            return;
        }

        self.bytes = self.bytes.saturating_add(bytes);
        self.order.push_back(key.clone());
        self.entries.insert(
            key,
            PreparedTextImportCacheEntry {
                prepared,
                inserted_at: text_import_cache_now_ms(),
            },
        );
        self.enforce_limit();
    }

    pub(super) fn take(&mut self, key: &TextImportPreparedKey) -> Option<Arc<PreparedTextImport>> {
        self.remove_expired();
        self.remove_key(key).map(|entry| entry.prepared)
    }

    #[cfg(test)]
    pub(super) fn set_max_bytes(&mut self, max_bytes: usize) {
        self.max_bytes = max_bytes;
        self.enforce_limit();
    }

    pub(super) fn len(&mut self) -> usize {
        self.remove_expired();
        self.entries.len()
    }

    pub(super) fn bytes(&mut self) -> usize {
        self.remove_expired();
        self.bytes
    }

    fn touch(&mut self, key: &TextImportPreparedKey) {
        self.order.retain(|candidate| candidate != key);
        self.order.push_back(key.clone());
    }

    fn enforce_limit(&mut self) {
        while self.bytes > self.max_bytes {
            let Some(key) = self.order.pop_front() else {
                break;
            };
            if let Some(entry) = self.entries.remove(&key) {
                self.bytes = self.bytes.saturating_sub(entry.prepared.bytes.len());
            }
        }
    }

    fn remove_expired(&mut self) {
        let now = text_import_cache_now_ms();
        let ttl_ms = TEXT_IMPORT_PREPARED_CACHE_TTL.as_millis() as u64;
        let expired = self
            .entries
            .iter()
            .filter_map(|(key, entry)| {
                if now.saturating_sub(entry.inserted_at) > ttl_ms {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        for key in expired {
            self.remove_key(&key);
        }
    }

    fn remove_key(&mut self, key: &TextImportPreparedKey) -> Option<PreparedTextImportCacheEntry> {
        self.order.retain(|candidate| candidate != key);
        let entry = self.entries.remove(key)?;
        self.bytes = self.bytes.saturating_sub(entry.prepared.bytes.len());
        Some(entry)
    }
}

impl Default for TextImportPreparedCache {
    fn default() -> Self {
        Self::new()
    }
}

fn text_import_cache_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn create_text_cover_svg(title: &str, creator: &str) -> String {
    let has_creator = !creator.is_empty();
    let title = escape_svg(title);
    let creator = escape_svg(creator);
    let creator_block = if has_creator {
        format!(
            r#"<foreignObject x="7.5%" y="70%" width="85%" height="30%">
                <div xmlns="http://www.w3.org/1999/xhtml" style="height:100%;box-sizing:border-box;display:flex;align-items:flex-start;justify-content:center;text-align:center;color:#776b5c;font-family:Noto Serif CJK SC, Source Han Serif SC, STSong, SimSun, serif;overflow:hidden;">
                    <div xmlns="http://www.w3.org/1999/xhtml" style="max-width:100%;font-size:clamp(14px,8vw,22px);line-height:1.18;font-weight:700;overflow-wrap:anywhere;word-break:break-word;">{creator}</div>
                </div>
            </foreignObject>"#
        )
    } else {
        String::new()
    };

    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" style="aspect-ratio:3/4" data-flow-generated-cover="true">
            <title>{title}</title>
            <rect width="100%" height="100%" fill="#ead7b5"/>
            <foreignObject x="7.5%" y="30%" width="85%" height="40%">
                <div xmlns="http://www.w3.org/1999/xhtml" style="height:100%;box-sizing:border-box;display:flex;align-items:flex-start;justify-content:center;text-align:center;color:#3d3122;font-family:Noto Serif CJK SC, Source Han Serif SC, STSong, SimSun, serif;overflow:hidden;">
                <div xmlns="http://www.w3.org/1999/xhtml" style="max-width:100%;font-size:clamp(18px,12vw,30px);line-height:1.12;font-weight:800;overflow-wrap:anywhere;word-break:break-word;">{title}</div>
                </div>
            </foreignObject>
            {creator_block}
        </svg>"##
    )
}

pub(super) fn create_text_cover_input(metadata: &Value, fallback_title: Option<&str>) -> Option<CoverInput> {
    let title = metadata
        .get("title")
        .and_then(Value::as_str)
        .map(clean_xml_text)
        .filter(|title| !title.is_empty())
        .or_else(|| fallback_title.map(clean_xml_text))
        .unwrap_or_default();
    if title.is_empty() {
        return None;
    }
    let creator = metadata
        .get("creator")
        .and_then(Value::as_str)
        .map(clean_xml_text)
        .unwrap_or_default();
    let svg = create_text_cover_svg(&title, &creator);

    Some(CoverInput {
        mime_type: "image/svg+xml".to_string(),
        extension: "svg".to_string(),
        data: svg.into_bytes(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_cover_uses_default_cover_layout() {
        let svg = create_text_cover_svg("A Very Long Generated Title", "Author & Co");

        assert!(svg.contains(r#"data-flow-generated-cover="true""#));
        assert!(svg.contains("<foreignObject"));
        assert!(svg.contains(r#"style="aspect-ratio:3/4""#));
        assert!(svg.contains("overflow-wrap:anywhere"));
        assert!(svg.contains(r#"width="100%" height="100%""#));
        assert!(!svg.contains("viewBox"));
        assert!(svg.contains(r#"y="30%" width="85%" height="40%""#));
        assert!(svg.contains(r#"y="70%" width="85%" height="30%""#));
        assert!(svg.contains("align-items:flex-start"));
        assert!(svg.contains("font-size:clamp(18px,12vw,30px)"));
        assert!(svg.contains("font-size:clamp(14px,8vw,22px)"));
        assert!(svg.contains("font-weight:700"));
        assert!(svg.contains("color:#776b5c"));
        assert!(svg.contains("Author &amp; Co"));
        assert!(!svg.contains("<tspan"));
    }
}

pub(super) fn text_import_encoding_options() -> Vec<TextImportEncodingOption> {
    [
        ("auto", "Auto"),
        ("utf-8", "UTF-8"),
        ("gb18030", "GB18030"),
        ("big5", "Big5"),
        ("shift_jis", "Shift_JIS"),
        ("euc-kr", "EUC-KR"),
        ("windows-1250", "Windows-1250"),
        ("windows-1251", "Windows-1251"),
        ("windows-1252", "Windows-1252"),
    ]
    .into_iter()
    .map(|(id, label)| TextImportEncodingOption {
        id: id.to_string(),
        label: label.to_string(),
    })
    .collect()
}

fn text_encoding_by_id(id: &str) -> Option<(&'static str, &'static str, &'static Encoding)> {
    match id {
        "utf-8" => Some(("utf-8", "UTF-8", UTF_8)),
        "gb18030" => Some(("gb18030", "GB18030", GB18030)),
        "big5" => Some(("big5", "Big5", BIG5)),
        "shift_jis" => Some(("shift_jis", "Shift_JIS", SHIFT_JIS)),
        "euc-kr" => Some(("euc-kr", "EUC-KR", EUC_KR)),
        "windows-1250" => Some(("windows-1250", "Windows-1250", WINDOWS_1250)),
        "windows-1251" => Some(("windows-1251", "Windows-1251", WINDOWS_1251)),
        "windows-1252" => Some(("windows-1252", "Windows-1252", WINDOWS_1252)),
        _ => None,
    }
}

fn text_encoding_id_by_label(label: &str) -> Option<&'static str> {
    let normalized = label.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "utf-8" | "utf8" => Some("utf-8"),
        "utf-16le" | "utf-16 le" => Some("utf-16le"),
        "utf-16be" | "utf-16 be" => Some("utf-16be"),
        "gb18030" => Some("gb18030"),
        "big5" | "big-5" => Some("big5"),
        "shift_jis" | "shift-jis" | "sjis" => Some("shift_jis"),
        "euc-kr" | "euckr" => Some("euc-kr"),
        "windows-1250" | "windows 1250" | "cp1250" => Some("windows-1250"),
        "windows-1251" | "windows 1251" | "cp1251" => Some("windows-1251"),
        "windows-1252" | "windows 1252" | "cp1252" => Some("windows-1252"),
        _ => None,
    }
}

pub(super) fn source_encoding_id_from_metadata(metadata: &Value) -> Option<String> {
    metadata
        .get("sourceEncodingId")
        .and_then(Value::as_str)
        .and_then(text_encoding_id_by_label)
        .map(str::to_string)
}

pub(super) fn decode_text_bytes(bytes: &[u8], encoding: Option<&str>) -> DecodedText {
    if let Some(encoding) = encoding.filter(|encoding| *encoding != "auto")
        && let Some((id, label, encoding)) = text_encoding_by_id(encoding)
    {
        let (text, had_errors) = decode_with_encoding(bytes, encoding);
        return DecodedText {
            text,
            encoding: id.to_string(),
            encoding_label: label.to_string(),
            confidence: if had_errors {
                TextEncodingConfidence::Medium
            } else {
                TextEncodingConfidence::High
            },
        };
    }

    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        let text = String::from_utf8_lossy(&bytes[3..]).to_string();
        return DecodedText {
            text,
            encoding: "utf-8".to_string(),
            encoding_label: "UTF-8".to_string(),
            confidence: TextEncodingConfidence::High,
        };
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        let (text, had_errors) = decode_with_encoding(&bytes[2..], UTF_16LE);
        return DecodedText {
            text,
            encoding: "utf-16le".to_string(),
            encoding_label: "UTF-16LE".to_string(),
            confidence: if had_errors {
                TextEncodingConfidence::Medium
            } else {
                TextEncodingConfidence::High
            },
        };
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let (text, had_errors) = decode_with_encoding(&bytes[2..], UTF_16BE);
        return DecodedText {
            text,
            encoding: "utf-16be".to_string(),
            encoding_label: "UTF-16BE".to_string(),
            confidence: if had_errors {
                TextEncodingConfidence::Medium
            } else {
                TextEncodingConfidence::High
            },
        };
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        return DecodedText {
            text: text.to_string(),
            encoding: "utf-8".to_string(),
            encoding_label: "UTF-8".to_string(),
            confidence: TextEncodingConfidence::High,
        };
    }

    let sample = sample_text_bytes(bytes);

    let mut best: Option<(&'static str, &'static str, &'static Encoding, i32, bool)> = None;
    for (id, label, encoding) in [
        ("gb18030", "GB18030", GB18030),
        ("big5", "Big5", BIG5),
        ("shift_jis", "Shift_JIS", SHIFT_JIS),
        ("euc-kr", "EUC-KR", EUC_KR),
        ("windows-1250", "Windows-1250", WINDOWS_1250),
        ("windows-1251", "Windows-1251", WINDOWS_1251),
        ("windows-1252", "Windows-1252", WINDOWS_1252),
    ] {
        let (text, had_errors) = decode_with_encoding(&sample, encoding);
        let score = score_decoded_text(&text, had_errors);
        if best.as_ref().is_none_or(|(_, _, _, best_score, _)| score > *best_score) {
            best = Some((id, label, encoding, score, had_errors));
        }
    }

    let Some((id, label, encoding, score, had_errors)) = best else {
        return DecodedText {
            text: String::new(),
            encoding: "gb18030".to_string(),
            encoding_label: "GB18030".to_string(),
            confidence: TextEncodingConfidence::Failed,
        };
    };
    let (text, full_had_errors) = decode_with_encoding(bytes, encoding);
    DecodedText {
        text,
        encoding: id.to_string(),
        encoding_label: label.to_string(),
        confidence: if score < 10 {
            TextEncodingConfidence::Low
        } else if had_errors || full_had_errors {
            TextEncodingConfidence::Medium
        } else {
            TextEncodingConfidence::High
        },
    }
}

fn decode_with_encoding(bytes: &[u8], encoding: &'static Encoding) -> (String, bool) {
    let (text, had_errors) = encoding.decode_without_bom_handling(bytes);
    (text.into_owned(), had_errors)
}

pub(super) fn encode_text_bytes(text: &str, encoding: &str, write_bom: bool) -> Result<Vec<u8>, String> {
    match encoding {
        "utf-8" => {
            let mut bytes = Vec::with_capacity(text.len() + if write_bom { 3 } else { 0 });
            if write_bom {
                bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
            }
            bytes.extend_from_slice(text.as_bytes());
            Ok(bytes)
        }
        "utf-16le" => {
            let mut bytes = Vec::with_capacity(text.len() * 2 + if write_bom { 2 } else { 0 });
            if write_bom {
                bytes.extend_from_slice(&[0xff, 0xfe]);
            }
            for unit in text.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            Ok(bytes)
        }
        "utf-16be" => {
            let mut bytes = Vec::with_capacity(text.len() * 2 + if write_bom { 2 } else { 0 });
            if write_bom {
                bytes.extend_from_slice(&[0xfe, 0xff]);
            }
            for unit in text.encode_utf16() {
                bytes.extend_from_slice(&unit.to_be_bytes());
            }
            Ok(bytes)
        }
        other => {
            let Some((_, _, encoding)) = text_encoding_by_id(other) else {
                return Err(format!("Unsupported source text encoding: {other}"));
            };
            let (encoded, _, had_errors) = encoding.encode(text);
            if had_errors {
                return Err(format!("Text contains characters unsupported by {other}"));
            }
            Ok(encoded.into_owned())
        }
    }
}

fn sample_text_bytes(bytes: &[u8]) -> Vec<u8> {
    const SAMPLE_SIZE: usize = 64 * 1024;
    if bytes.len() <= SAMPLE_SIZE * 4 {
        return bytes.to_vec();
    }

    let mut sample = Vec::with_capacity(SAMPLE_SIZE * 3);
    sample.extend_from_slice(&bytes[..SAMPLE_SIZE]);

    let middle_start = bytes.len() / 2usize - SAMPLE_SIZE / 2usize;
    sample.extend_from_slice(&bytes[middle_start..middle_start + SAMPLE_SIZE]);
    sample.extend_from_slice(&bytes[bytes.len() - SAMPLE_SIZE..]);
    sample
}

fn score_decoded_text(text: &str, had_errors: bool) -> i32 {
    if text.is_empty() {
        return -1000;
    }

    let mut score = if had_errors { -80 } else { 0 };
    let mut readable = 0;
    let mut suspicious = 0;
    let mut cjk = 0;
    let mut kana = 0;
    let mut hangul = 0;
    let mut latin = 0;

    for ch in text.chars().take(20_000) {
        if ch == '\u{fffd}' {
            suspicious += 8;
            continue;
        }
        if ch.is_control() && !matches!(ch, '\r' | '\n' | '\t') {
            suspicious += 4;
            continue;
        }
        if matches!(ch, 'Ã' | 'Â' | '¤' | '€') {
            suspicious += 2;
        }
        if ch.is_whitespace() || ch.is_ascii_punctuation() {
            readable += 1;
            continue;
        }
        if contains_cjk_char(ch) {
            cjk += 1;
            readable += 3;
        } else if contains_kana_char(ch) {
            kana += 1;
            readable += 3;
        } else if contains_hangul_char(ch) {
            hangul += 1;
            readable += 3;
        } else if ch.is_alphanumeric() {
            latin += 1;
            readable += 2;
        } else {
            readable += 1;
        }
    }

    score += readable;
    score += (cjk + kana + hangul + latin).min(300);
    score -= suspicious * 20;
    score
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

fn contains_kana_char(ch: char) -> bool {
    matches!(ch as u32, 0x3040..=0x30ff | 0x31f0..=0x31ff)
}

fn contains_hangul_char(ch: char) -> bool {
    matches!(ch as u32, 0xac00..=0xd7af | 0x1100..=0x11ff)
}

#[derive(Debug, Clone, Copy)]
enum TextImportRuleRole {
    Group,
    Chapter,
}

struct TextImportRule {
    role: TextImportRuleRole,
    regex: Regex,
}

fn default_text_import_rules_input() -> TextImportRulesInput {
    TextImportRulesInput {
        group_patterns: vec![
            r"^\s*第[0-9一二三四五六七八九十零〇百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+[卷部集篇].*".to_string(),
            r"^\s*(Book|Part|Volume)\s+[0-9IVXLCDM]+.*".to_string(),
        ],
        chapter_patterns: vec![
            r"^\s*第[0-9一二三四五六七八九十零〇百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+[章回节].*".to_string(),
            r"^\s*(简介|序言|序|前言|自序|楔子|后记|尾声|番外|附录).*".to_string(),
            r"^\s*Chapter\s+[0-9IVXLCDM]+.*".to_string(),
        ],
    }
}

fn compile_text_import_rules(input: Option<&TextImportRulesInput>) -> Vec<TextImportRule> {
    let defaults;
    let input = match input {
        Some(input) => input,
        None => {
            defaults = default_text_import_rules_input();
            &defaults
        }
    };

    input
        .group_patterns
        .iter()
        .map(|pattern| (TextImportRuleRole::Group, pattern))
        .chain(
            input
                .chapter_patterns
                .iter()
                .map(|pattern| (TextImportRuleRole::Chapter, pattern)),
        )
        .filter_map(|(role, pattern)| {
            let pattern = pattern.trim();
            if pattern.is_empty() {
                return None;
            }

            Regex::new(pattern).ok().map(|regex| TextImportRule { role, regex })
        })
        .collect()
}

pub(super) fn parse_text_import_document(
    text: &str,
    title: &str,
    rules_input: Option<&TextImportRulesInput>,
) -> TextImportDocument {
    const TARGET_SECTION_CHARS: usize = 12_000;
    const MAX_SECTION_CHARS: usize = 40_000;

    let rules = compile_text_import_rules(rules_input);
    let mut sections = Vec::new();
    let mut current_parent: Option<String> = None;
    let mut current_title: Option<String> = None;
    let mut paragraphs: Vec<String> = Vec::new();
    let mut found_heading = false;

    let flush_section = |sections: &mut Vec<TextImportSection>,
                         current_parent: &Option<String>,
                         current_title: &Option<String>,
                         paragraphs: &mut Vec<String>| {
        if paragraphs.is_empty() {
            return;
        }
        let title = current_title
            .clone()
            .or_else(|| current_parent.clone())
            .unwrap_or_else(|| title.to_string());
        sections.push(TextImportSection {
            title,
            parent: current_parent.clone(),
            paragraphs: std::mem::take(paragraphs),
            is_group: false,
        });
    };

    for raw_line in text.replace("\r\n", "\n").replace('\r', "\n").lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(rule) = rules.iter().find(|rule| rule.regex.is_match(line)) {
            found_heading = true;
            flush_section(&mut sections, &current_parent, &current_title, &mut paragraphs);
            match rule.role {
                TextImportRuleRole::Group => {
                    sections.push(TextImportSection {
                        title: line.to_string(),
                        parent: None,
                        paragraphs: Vec::new(),
                        is_group: true,
                    });
                    current_parent = Some(line.to_string());
                    current_title = None;
                }
                TextImportRuleRole::Chapter => {
                    current_title = Some(line.to_string());
                }
            }
            continue;
        }

        if current_title.is_none() {
            current_title = current_parent.clone().or_else(|| Some(title.to_string()));
        }
        paragraphs.push(line.to_string());
    }

    flush_section(&mut sections, &current_parent, &current_title, &mut paragraphs);

    if !found_heading || sections.is_empty() {
        let paragraphs = text
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .split('\n')
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        let mut generated_sections =
            split_paragraphs_into_sections(title, None, paragraphs, TARGET_SECTION_CHARS, MAX_SECTION_CHARS);
        if generated_sections.is_empty() {
            generated_sections.push(TextImportSection {
                title: title.to_string(),
                parent: None,
                paragraphs: Vec::new(),
                is_group: false,
            });
        }
        let generated_chapters = text_sections_to_chapter_previews(&generated_sections);
        return TextImportDocument {
            title: title.to_string(),
            creator: String::new(),
            sections: generated_sections,
            chapters: generated_chapters,
        };
    }

    let sections = sections
        .into_iter()
        .flat_map(|section| {
            if section.is_group {
                vec![section]
            } else {
                split_paragraphs_into_sections(
                    &section.title,
                    section.parent,
                    section.paragraphs,
                    TARGET_SECTION_CHARS,
                    MAX_SECTION_CHARS,
                )
            }
        })
        .collect::<Vec<_>>();

    let chapters = text_sections_to_chapter_previews(&sections);

    TextImportDocument {
        title: title.to_string(),
        creator: String::new(),
        sections,
        chapters,
    }
}

fn text_sections_to_chapter_previews(sections: &[TextImportSection]) -> Vec<TextImportChapterPreview> {
    let mut chapters = Vec::new();

    for section in sections {
        chapters.push(TextImportChapterPreview {
            title: section.title.clone(),
            level: if section.is_group || section.parent.is_none() {
                1
            } else {
                2
            },
            role: if section.is_group {
                "group".to_string()
            } else {
                "chapter".to_string()
            },
        });
    }

    chapters
}

fn split_paragraphs_into_sections(
    title: &str,
    parent: Option<String>,
    paragraphs: Vec<String>,
    target_chars: usize,
    max_chars: usize,
) -> Vec<TextImportSection> {
    let total_chars = paragraphs.iter().map(|p| p.chars().count()).sum::<usize>();
    if total_chars <= max_chars {
        return vec![TextImportSection {
            title: title.to_string(),
            parent,
            paragraphs,
            is_group: false,
        }];
    }

    let mut sections = Vec::new();
    let mut current = Vec::new();
    let mut current_chars = 0usize;
    let mut index = 1usize;

    for paragraph in paragraphs {
        let paragraph_chars = paragraph.chars().count();
        if !current.is_empty() && current_chars + paragraph_chars > target_chars {
            sections.push(TextImportSection {
                title: split_section_title(title, index),
                parent: parent.clone(),
                paragraphs: std::mem::take(&mut current),
                is_group: false,
            });
            index += 1;
            current_chars = 0;
        }
        current_chars += paragraph_chars;
        current.push(paragraph);
    }

    if !current.is_empty() {
        sections.push(TextImportSection {
            title: split_section_title(title, index),
            parent,
            paragraphs: current,
            is_group: false,
        });
    }

    sections
}

fn split_section_title(title: &str, index: usize) -> String {
    if index <= 1 {
        title.to_string()
    } else {
        format!("{title}（{index}）")
    }
}

fn text_import_file_title(path: &Path, filename: &str) -> String {
    path.file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| filename.trim_end_matches(".txt").to_string())
}

pub(super) fn create_skipped_text_import_preview(path: &Path) -> TextImportPreview {
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.txt".to_string());
    let title = text_import_file_title(path, &filename);

    TextImportPreview {
        path: path_to_client_string(path),
        filename,
        title,
        encoding: "auto".to_string(),
        encoding_label: "Auto".to_string(),
        confidence: "high".to_string(),
        status: TextImportStatus::Skipped.as_str().to_string(),
        selected: false,
        message: None,
        sample: String::new(),
        chapters: Vec::new(),
    }
}

fn normalized_text_import_encoding(encoding: Option<&str>) -> String {
    encoding
        .map(str::trim)
        .filter(|encoding| !encoding.is_empty())
        .unwrap_or("auto")
        .to_string()
}

fn text_import_rules_hash(rules: Option<&TextImportRulesInput>) -> String {
    let mut hasher = Sha256::new();
    if let Some(rules) = rules {
        for pattern in &rules.group_patterns {
            hasher.update(b"group\0");
            hasher.update(pattern.as_bytes());
            hasher.update(b"\0");
        }
        for pattern in &rules.chapter_patterns {
            hasher.update(b"chapter\0");
            hasher.update(pattern.as_bytes());
            hasher.update(b"\0");
        }
    }
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn text_import_modified_nanos(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn text_import_prepared_key_from_metadata(
    path: &Path,
    encoding: Option<&str>,
    rules: Option<&TextImportRulesInput>,
    metadata: &fs::Metadata,
) -> TextImportPreparedKey {
    TextImportPreparedKey {
        identity: format!(
            "{}:{}:{}:{}:{}",
            path_to_client_string(path),
            metadata.len(),
            text_import_modified_nanos(metadata),
            normalized_text_import_encoding(encoding),
            text_import_rules_hash(rules)
        ),
    }
}

pub(super) fn text_import_prepared_key(
    path: &Path,
    encoding: Option<&str>,
    rules: Option<&TextImportRulesInput>,
) -> Result<TextImportPreparedKey, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    Ok(text_import_prepared_key_from_metadata(path, encoding, rules, &metadata))
}

fn hash_text_import_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(super) fn create_text_import_error_preview(path: &Path, message: String) -> TextImportPreview {
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.txt".to_string());
    let title = text_import_file_title(path, &filename);

    TextImportPreview {
        path: path_to_client_string(path),
        filename,
        title,
        encoding: "auto".to_string(),
        encoding_label: "Auto".to_string(),
        confidence: "failed".to_string(),
        status: TextImportStatus::Error.as_str().to_string(),
        selected: false,
        message: Some(message),
        sample: String::new(),
        chapters: Vec::new(),
    }
}

fn prepare_text_import_entry(
    path: &Path,
    encoding: Option<&str>,
    rules: Option<&TextImportRulesInput>,
    document_title: Option<&str>,
    key: TextImportPreparedKey,
) -> Result<Arc<PreparedTextImport>, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let latest_key = text_import_prepared_key_from_metadata(path, encoding, rules, &metadata);
    if latest_key != key {
        return Err("Text file changed while preparing import".to_string());
    }

    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.txt".to_string());
    let fallback_title = document_title
        .map(str::to_string)
        .unwrap_or_else(|| text_import_file_title(path, &filename));
    let decoded = decode_text_bytes(&bytes, encoding);
    let sample = decoded
        .text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("\n");
    let document = parse_text_import_document(&decoded.text, &fallback_title, rules);

    Ok(Arc::new(PreparedTextImport {
        key,
        path: path.to_path_buf(),
        filename,
        fallback_title,
        size: metadata.len(),
        hash: hash_text_import_bytes(&bytes),
        bytes: Arc::new(bytes),
        decoded,
        sample,
        document,
    }))
}

pub(super) fn create_text_import_preview_from_prepared(prepared: &PreparedTextImport) -> TextImportPreview {
    let has_text = prepared.decoded.text.chars().any(|ch| !ch.is_whitespace());
    let status = if !has_text || prepared.decoded.confidence == TextEncodingConfidence::Failed {
        TextImportStatus::Error
    } else if prepared.decoded.confidence == TextEncodingConfidence::Low {
        TextImportStatus::NeedsReview
    } else {
        TextImportStatus::Ready
    };

    TextImportPreview {
        path: path_to_client_string(&prepared.path),
        filename: prepared.filename.clone(),
        title: prepared.fallback_title.clone(),
        encoding: prepared.decoded.encoding.clone(),
        encoding_label: prepared.decoded.encoding_label.clone(),
        confidence: match prepared.decoded.confidence {
            TextEncodingConfidence::High => "high",
            TextEncodingConfidence::Medium => "medium",
            TextEncodingConfidence::Low => "low",
            TextEncodingConfidence::Failed => "failed",
        }
        .to_string(),
        status: status.as_str().to_string(),
        selected: status == TextImportStatus::Ready,
        message: if status == TextImportStatus::Error {
            Some("Unable to decode text file".to_string())
        } else if prepared.document.chapters.is_empty() {
            Some("No chapters detected; sections will be generated by length".to_string())
        } else {
            None
        },
        sample: prepared.sample.clone(),
        chapters: prepared.document.chapters.clone(),
    }
}

pub(super) fn should_skip_prepared_text_import_preview(
    storage: &AppStorage,
    prepared: &PreparedTextImport,
) -> Result<bool, String> {
    let state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;

    Ok(state.library.books.iter().any(|book| {
        book.name == prepared.filename && !book.content_hash.is_empty() && book.content_hash == prepared.hash
    }))
}

pub(super) fn load_or_prepare_text_import(
    storage: &AppStorage,
    tasks: &TaskService,
    path: &Path,
    encoding: Option<&str>,
    rules: Option<&TextImportRulesInput>,
) -> Result<Arc<PreparedTextImport>, String> {
    let key = text_import_prepared_key(path, encoding, rules)?;
    if let Some(prepared) = storage.get_prepared_text_import(&key) {
        return Ok(prepared);
    }

    let storage = storage.clone();
    let tasks_runner = tasks.clone();
    let path = path.to_path_buf();
    let encoding = encoding.map(str::to_string);
    let rules = rules.cloned();
    let task_key = TaskKey::new(TaskKind::TxtPreview, key.task_identity().to_string());
    tasks.get_or_run(task_key, TaskPriority::Foreground, move || {
        tasks_runner.run_cpu(TaskPriority::Foreground, || {
            if let Some(prepared) = storage.get_prepared_text_import(&key) {
                return Ok(prepared);
            }
            storage.note_text_import_prepare_run();
            storage.begin_text_import_prepare();
            let prepared = prepare_text_import_entry(&path, encoding.as_deref(), rules.as_ref(), None, key);
            storage.end_text_import_prepare();
            let prepared = prepared?;
            storage.insert_prepared_text_import(Arc::clone(&prepared));
            Ok(prepared)
        })
    })
}

pub(super) fn consume_or_prepare_text_import(
    storage: &AppStorage,
    tasks: &TaskService,
    path: &Path,
    encoding: Option<&str>,
    rules: Option<&TextImportRulesInput>,
) -> Result<Arc<PreparedTextImport>, String> {
    let key = text_import_prepared_key(path, encoding, rules)?;
    if let Some(prepared) = storage.take_prepared_text_import(&key) {
        return Ok(prepared);
    }

    let encoding_id = normalized_text_import_encoding(encoding);
    if encoding_id != "auto" {
        let auto_key = text_import_prepared_key(path, None, rules)?;
        if let Some(prepared) = storage.take_prepared_text_import(&auto_key) {
            if prepared.decoded.encoding == encoding_id {
                return Ok(prepared);
            }
            storage.insert_prepared_text_import(prepared);
        }
    }

    let prepared = load_or_prepare_text_import(storage, tasks, path, encoding, rules)?;
    storage.take_prepared_text_import(&prepared.key);
    Ok(prepared)
}

fn materialize_text_publication(
    storage: &AppStorage,
    id: &str,
    prepared: &PreparedTextImport,
    metadata: &Value,
    rules: Option<&TextImportRulesInput>,
    cover: Option<&CoverInput>,
) -> Result<PathBuf, String> {
    let title = metadata.get("title").and_then(Value::as_str).unwrap_or_default();
    let creator = metadata.get("creator").and_then(Value::as_str).unwrap_or_default();
    let reparsed_document;
    let document = if title == prepared.document.title {
        &prepared.document
    } else {
        reparsed_document = parse_text_import_document(&prepared.decoded.text, title, rules);
        &reparsed_document
    };
    let unpacked_dir = storage.book_dir(id).join(UNPACKED_DIR);
    if unpacked_dir.exists() {
        fs::remove_dir_all(&unpacked_dir).map_err(|error| error.to_string())?;
    }

    let meta_inf = unpacked_dir.join("META-INF");
    let oebps = unpacked_dir.join("OEBPS");
    let images_dir = oebps.join("Images");
    let text_dir = oebps.join("Text");
    let styles_dir = oebps.join("Styles");
    fs::create_dir_all(&meta_inf).map_err(|error| error.to_string())?;
    fs::create_dir_all(&images_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&text_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&styles_dir).map_err(|error| error.to_string())?;
    fs::write(unpacked_dir.join("mimetype"), "application/epub+zip").map_err(|error| error.to_string())?;

    fs::write(
        meta_inf.join("container.xml"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
    )
    .map_err(|error| error.to_string())?;

    fs::write(styles_dir.join("txt.css"), text_import_css()).map_err(|error| error.to_string())?;
    if let Some(cover) = cover {
        write_text_cover_to_unpacked(storage, id, cover)?;
    }

    for (index, section) in document.sections.iter().enumerate() {
        fs::write(
            text_dir.join(format!("part{:04}.xhtml", index + 1)),
            text_section_xhtml(section),
        )
        .map_err(|error| error.to_string())?;
    }

    fs::write(oebps.join("nav.xhtml"), text_nav_xhtml(document)).map_err(|error| error.to_string())?;
    let opf = if creator == document.creator {
        text_content_opf(document, &prepared.decoded.encoding_label)
    } else {
        text_content_opf_with_metadata(document, &document.title, creator, &prepared.decoded.encoding_label)
    };
    fs::write(oebps.join("content.opf"), opf).map_err(|error| error.to_string())?;

    Ok(unpacked_dir.join("OEBPS/content.opf"))
}

pub(super) fn materialize_library_text_publication(
    storage: &AppStorage,
    book: &LibraryBook,
) -> Result<PathBuf, String> {
    let source_path = available_book_source_path(storage, book)?;
    let encoding = source_encoding_id_from_metadata(&book.metadata);
    let rules = storage.text_import_rules()?;
    let title = book.metadata.get("title").and_then(Value::as_str).unwrap_or_default();
    let key = text_import_prepared_key(&source_path, encoding.as_deref(), rules.as_ref())?;
    let prepared = prepare_text_import_entry(&source_path, encoding.as_deref(), rules.as_ref(), Some(title), key)?;
    let cover = fs::read(storage.book_dir(&book.id).join("cover.svg"))
        .ok()
        .filter(|data| !data.is_empty())
        .map(|data| CoverInput {
            mime_type: "image/svg+xml".to_string(),
            extension: "svg".to_string(),
            data,
        })
        .or_else(|| create_text_cover_input(&book.metadata, None));
    materialize_text_publication(
        storage,
        &book.id,
        &prepared,
        &book.metadata,
        rules.as_ref(),
        cover.as_ref(),
    )
}

pub(super) fn text_import_css() -> &'static str {
    r#"html, body {
  margin: 0;
  padding: 0;
}

.flow-txt-volume,
.flow-txt-chapter {
  text-align: center;
  text-indent: 0;
  font-weight: 700;
  line-height: 1.5;
}

.flow-txt-volume-page {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  width: 100%;
}

.flow-txt-volume {
  font-size: 1.45em;
  margin: 0;
}

.flow-txt-chapter {
  font-size: 1.25em;
  margin: 2em 0 1.4em;
}

.flow-txt-body,
.flow-txt-body p {
  text-align: justify;
  text-indent: 2em;
}

.flow-txt-body p {
  margin: 0 0 0.75em;
}
"#
}

pub(super) fn text_section_xhtml(section: &TextImportSection) -> String {
    let heading = section.title.clone();
    let mut body = if section.is_group {
        format!(r#"<h1 class="flow-txt-volume">{}</h1>"#, escape_xml(&heading))
    } else {
        format!(r#"<h2 class="flow-txt-chapter">{}</h2>"#, escape_xml(&heading))
    };

    if !section.paragraphs.is_empty() {
        body.push_str(r#"<div class="flow-txt-body" data-flow-body-text="true">"#);
        for paragraph in &section.paragraphs {
            body.push_str(&format!(r#"<p>{}</p>"#, escape_xml(paragraph)));
        }
        body.push_str("</div>");
    }

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
<head>
  <title>{}</title>
  <link rel="stylesheet" type="text/css" href="../Styles/txt.css"/>
</head>
<body{}>
{}
</body>
</html>"#,
        escape_xml(&heading),
        if section.is_group {
            r#" class="flow-txt-volume-page""#
        } else {
            ""
        },
        body
    )
}

pub(super) fn text_nav_xhtml(document: &TextImportDocument) -> String {
    let mut nav = String::new();
    let mut group_open = false;
    let mut group_index = 0usize;

    for (index, section) in document.sections.iter().enumerate() {
        if section.is_group {
            if group_open {
                nav.push_str("</ol></li>");
            }
            group_index += 1;
            group_open = true;
            nav.push_str(&format!(
                r#"<li id="txt-group-{group_index:04}"><a href="Text/part{:04}.xhtml">{}</a><ol>"#,
                index + 1,
                escape_xml(&section.title)
            ));
            continue;
        }

        if section.parent.is_none() && group_open {
            nav.push_str("</ol></li>");
            group_open = false;
        }

        nav.push_str(&format!(
            r#"<li><a href="Text/part{:04}.xhtml">{}</a></li>"#,
            index + 1,
            escape_xml(&section.title)
        ));
    }

    if group_open {
        nav.push_str("</ol></li>");
    }

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
<head>
  <title>{}</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>{}</h1>
    <ol>{}</ol>
  </nav>
</body>
</html>"#,
        escape_xml(&document.title),
        escape_xml(&document.title),
        nav
    )
}

pub(super) fn text_content_opf(document: &TextImportDocument, encoding_label: &str) -> String {
    text_content_opf_with_metadata(document, &document.title, &document.creator, encoding_label)
}

fn text_content_opf_with_metadata(
    document: &TextImportDocument,
    title: &str,
    creator: &str,
    encoding_label: &str,
) -> String {
    let manifest_items = document
        .sections
        .iter()
        .enumerate()
        .map(|(index, _)| {
            format!(
                r#"<item id="part{0:04}" href="Text/part{0:04}.xhtml" media-type="application/xhtml+xml"/>"#,
                index + 1
            )
        })
        .collect::<Vec<_>>()
        .join("\n    ");
    let spine_items = document
        .sections
        .iter()
        .enumerate()
        .map(|(index, _)| format!(r#"<itemref idref="part{:04}"/>"#, index + 1))
        .collect::<Vec<_>>()
        .join("\n    ");

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">{}</dc:identifier>
    <dc:title>{}</dc:title>
    <dc:creator>{}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta name="cover" content="cover-image"/>
    <meta property="source-format">txt</meta>
    <meta property="source-encoding">{}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="Styles/txt.css" media-type="text/css"/>
    <item id="cover-image" href="Images/cover.svg" media-type="image/svg+xml" properties="cover-image"/>
    {}
  </manifest>
  <spine>
    {}
  </spine>
</package>"#,
        escape_xml(title),
        escape_xml(title),
        escape_xml(creator),
        escape_xml(encoding_label),
        manifest_items,
        spine_items
    )
}

pub(super) fn write_text_cover_to_unpacked(storage: &AppStorage, id: &str, cover: &CoverInput) -> Result<(), String> {
    if cover.mime_type != "image/svg+xml" || cover.data.is_empty() {
        return Ok(());
    }

    let unpacked_dir = storage.book_dir(id).join(UNPACKED_DIR);
    if !unpacked_dir.exists() {
        return Ok(());
    }
    let images_dir = unpacked_dir.join("OEBPS").join("Images");
    fs::create_dir_all(&images_dir).map_err(|error| error.to_string())?;
    fs::write(images_dir.join("cover.svg"), &cover.data).map_err(|error| error.to_string())
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_svg(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub(super) fn import_text_path_impl(
    storage: &AppStorage,
    prepared: Arc<PreparedTextImport>,
    import_title: Option<&str>,
    import_creator: Option<&str>,
    replace_existing: bool,
    rules: Option<&TextImportRulesInput>,
    import_index: Option<&mut LibraryBookLookupIndex>,
) -> Result<(BookRecord, ImportFinalizer), String> {
    let _import_guard = storage
        .inner
        .import_lock
        .lock()
        .map_err(|_| "storage import lock poisoned".to_string())?;
    fs::create_dir_all(books_root(storage.root())).map_err(|error| error.to_string())?;

    let path = &prepared.path;
    let source_path = path.to_path_buf();
    let source_storage = storage.import_source_storage();
    let decoded = &prepared.decoded;
    if decoded.confidence == TextEncodingConfidence::Failed {
        return Err("Unable to decode text file".to_string());
    }

    let hash = prepared.hash.clone();
    let size = prepared.size;
    let name = prepared.filename.clone();
    let fallback_title = prepared.fallback_title.clone();
    let title = import_title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string)
        .unwrap_or(fallback_title);
    let creator = import_creator
        .map(str::trim)
        .filter(|creator| !creator.is_empty())
        .map(str::to_string)
        .unwrap_or_default();

    let metadata = json!({
        "title": title,
        "creator": creator,
        "sourceEncodingId": decoded.encoding,
    });

    let (mut book, id, should_copy, is_new) = {
        let state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let filename_index = import_index.as_deref().map_or_else(
            || state.library.books.iter().position(|book| book.name == name),
            |index| index.filename_index(&state.library.books, &name),
        );
        let hash_index = import_index.as_deref().map_or_else(
            || {
                state
                    .library
                    .books
                    .iter()
                    .position(|book| !book.content_hash.is_empty() && book.content_hash == hash)
            },
            |index| index.hash_index(&state.library.books, &hash),
        );

        if let Some(index) = filename_index {
            let storage_changed = state.library.books[index].source_storage != source_storage;
            let mut book = state.library.books[index].clone();
            if !replace_existing || (state.library.books[index].content_hash == hash && !storage_changed) {
                book.source_path = Some(source_path.clone());
                let id = book.id.clone();
                (book, id, false, false)
            } else {
                book.size = size;
                book.content_hash = hash.clone();
                book.content_version = book.content_version.saturating_add(1).max(1);
                book.content_mode = BookContentMode::Normal;
                book.source_storage = source_storage;
                book.source_path = Some(source_path.clone());
                book.updated_at = Some(now_ms());
                book.last_read_at = book.updated_at;
                book.metadata = metadata.clone();
                let id = book.id.clone();
                (book, id, true, false)
            }
        } else if let Some(index) = hash_index {
            let mut book = state.library.books[index].clone();
            book.name = name.clone();
            book.size = size;
            book.content_mode = BookContentMode::Normal;
            let storage_changed = book.source_storage != source_storage;
            book.source_storage = source_storage;
            book.source_path = Some(source_path.clone());
            book.updated_at = Some(now_ms());
            book.metadata = metadata.clone();
            let id = book.id.clone();
            (book, id, storage_changed, false)
        } else {
            let created_at = now_ms();
            let id = id_from_hash(&hash);
            let book = LibraryBook {
                id: id.clone(),
                name: name.clone(),
                size,
                reading_status: None,
                source_format: BookSourceFormat::Txt,
                content_edited_at: None,
                content_hash: hash.clone(),
                content_version: 1,
                content_mode: BookContentMode::Normal,
                source_storage,
                source_path: Some(source_path.clone()),
                metadata: metadata.clone(),
                created_at,
                updated_at: None,
                last_read_at: None,
                cfi: None,
                percentage: None,
                tag_ids: Vec::new(),
            };
            (book, id, true, true)
        }
    };

    let mut file_transaction = None;
    let result = (|| -> Result<(BookRecord, ImportFinalizer), String> {
        if should_copy {
            storage.remove_derived_memory_caches(&id);
            file_transaction = Some(ImportFileTransaction::begin(storage, &id)?);
            let dir = storage.book_dir(&id);
            let source_text_path = dir.join(SOURCE_TEXT_FILE);
            if source_storage == SourceStorage::Managed {
                fs::write(&source_text_path, prepared.bytes.as_slice()).map_err(|error| error.to_string())?;
            }
            let cover = create_text_cover_input(&metadata, path.file_stem().and_then(|name| name.to_str()));
            if eager_import_materialization_enabled() {
                materialize_text_publication(storage, &id, &prepared, &metadata, rules, cover.as_ref())?;
            }
            book.metadata = metadata;
            write_cover(storage, &id, cover)?;
        }

        let record = {
            let mut state = storage
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;
            let stored_index = if is_new {
                if state
                    .library
                    .books
                    .iter()
                    .any(|stored| stored.id == id || stored.name == name)
                {
                    return Err("Library changed while the book was being imported".to_string());
                }
                state.library.books.push(book.clone());
                state.library.books.len() - 1
            } else {
                let stored_index = state
                    .library
                    .books
                    .iter()
                    .position(|stored| stored.id == id)
                    .ok_or_else(|| "Book was removed while it was being imported".to_string())?;
                let stored = &mut state.library.books[stored_index];
                book.reading_status = stored.reading_status.clone();
                book.cfi = stored.cfi.clone();
                book.percentage = stored.percentage;
                book.tag_ids = stored.tag_ids.clone();
                *stored = book.clone();
                stored_index
            };
            let record = storage.compose_book(&mut state, &book)?;
            if let Some(index) = import_index {
                index.remember(stored_index, &book);
            }
            record
        };

        storage.mark_library_dirty();
        Ok((record, ImportFinalizer::new(file_transaction.take())))
    })();

    if result.is_err()
        && let Some(transaction) = file_transaction
        && let Err(error) = transaction.rollback()
    {
        eprintln!("Failed to roll back text import files: {error}");
    }
    result
}

pub fn is_epub_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
}

pub fn is_txt_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("txt"))
}
