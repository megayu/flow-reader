use std::{fs, path::Path};

use encoding_rs::{
    Encoding, BIG5, EUC_KR, GB18030, SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1252,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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
    pub(super) sections: Vec<TextImportSection>,
    pub(super) chapters: Vec<TextImportChapterPreview>,
}

#[derive(Debug, Clone)]
pub(super) struct TextImportSection {
    pub(super) title: String,
    pub(super) parent: Option<String>,
    pub(super) paragraphs: Vec<String>,
    pub(super) prefix_parent_title: bool,
}

fn create_text_cover_svg(title: &str, creator: &str) -> String {
    let has_creator = !creator.is_empty();
    let title = escape_svg(title);
    let creator = escape_svg(creator);
    let creator_block = if has_creator {
        format!(
            r#"<div xmlns="http://www.w3.org/1999/xhtml" style="margin-top:clamp(10px,3.5vw,20px);font-size:clamp(14px,8vw,22px);line-height:1.18;font-weight:700;overflow-wrap:anywhere;word-break:break-word;">{creator}</div>"#
        )
    } else {
        String::new()
    };

    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" data-flow-generated-cover="true">
  <title>{title}</title>
  <rect width="100%" height="100%" fill="#ead7b5"/>
  <foreignObject x="7.5%" y="14%" width="85%" height="72%">
    <div xmlns="http://www.w3.org/1999/xhtml" style="height:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#3d3122;font-family:Noto Serif CJK SC, Source Han Serif SC, STSong, SimSun, serif;overflow:hidden;">
      <div xmlns="http://www.w3.org/1999/xhtml" style="max-width:100%;font-size:clamp(18px,12vw,30px);line-height:1.12;font-weight:800;overflow-wrap:anywhere;word-break:break-word;">{title}</div>
    {creator_block}
    </div>
  </foreignObject>
</svg>"##
    )
}

pub(super) fn create_text_cover_input(
    metadata: &Value,
    fallback_title: Option<&str>,
) -> Option<CoverInput> {
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
    fn text_cover_uses_responsive_foreign_object_layout() {
        let svg = create_text_cover_svg("A Very Long Generated Title", "Author & Co");

        assert!(svg.contains(r#"data-flow-generated-cover="true""#));
        assert!(svg.contains("<foreignObject"));
        assert!(svg.contains("font-size:clamp("));
        assert!(svg.contains("overflow-wrap:anywhere"));
        assert!(svg.contains(r#"width="100%" height="100%""#));
        assert!(!svg.contains("viewBox"));
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
        "windows-1252" => Some(("windows-1252", "Windows-1252", WINDOWS_1252)),
        _ => None,
    }
}

pub(super) fn decode_text_bytes(bytes: &[u8], encoding: Option<&str>) -> DecodedText {
    if let Some(encoding) = encoding.filter(|encoding| *encoding != "auto") {
        if let Some((id, label, encoding)) = text_encoding_by_id(encoding) {
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
        ("windows-1252", "Windows-1252", WINDOWS_1252),
    ] {
        let (text, had_errors) = decode_with_encoding(&sample, encoding);
        let score = score_decoded_text(&text, had_errors);
        if best
            .as_ref()
            .is_none_or(|(_, _, _, best_score, _)| score > *best_score)
        {
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
            r"^\s*第[0-9一二三四五六七八九十零〇百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+[卷部集篇].*"
                .to_string(),
            r"^\s*(Book|Part|Volume)\s+[0-9IVXLCDM]+.*".to_string(),
        ],
        chapter_patterns: vec![
            r"^\s*第[0-9一二三四五六七八九十零〇百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+[章回节].*"
                .to_string(),
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

            Regex::new(pattern)
                .ok()
                .map(|regex| TextImportRule { role, regex })
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
            prefix_parent_title: false,
        });
    };

    for raw_line in text.replace("\r\n", "\n").replace('\r', "\n").lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(rule) = rules.iter().find(|rule| rule.regex.is_match(line)) {
            found_heading = true;
            flush_section(
                &mut sections,
                &current_parent,
                &current_title,
                &mut paragraphs,
            );
            match rule.role {
                TextImportRuleRole::Group => {
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

    flush_section(
        &mut sections,
        &current_parent,
        &current_title,
        &mut paragraphs,
    );

    if !found_heading || sections.is_empty() {
        let paragraphs = text
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .split('\n')
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        let mut generated_sections = split_paragraphs_into_sections(
            title,
            None,
            paragraphs,
            TARGET_SECTION_CHARS,
            MAX_SECTION_CHARS,
        );
        if generated_sections.is_empty() {
            generated_sections.push(TextImportSection {
                title: title.to_string(),
                parent: None,
                paragraphs: Vec::new(),
                prefix_parent_title: false,
            });
        }
        let generated_chapters = text_sections_to_chapter_previews(&generated_sections);
        return TextImportDocument {
            title: title.to_string(),
            sections: generated_sections,
            chapters: generated_chapters,
        };
    }

    let mut sections = sections
        .into_iter()
        .flat_map(|section| {
            split_paragraphs_into_sections(
                &section.title,
                section.parent,
                section.paragraphs,
                TARGET_SECTION_CHARS,
                MAX_SECTION_CHARS,
            )
        })
        .collect::<Vec<_>>();

    mark_first_group_children(&mut sections);
    let chapters = text_sections_to_chapter_previews(&sections);

    TextImportDocument {
        title: title.to_string(),
        sections,
        chapters,
    }
}

fn mark_first_group_children(sections: &mut [TextImportSection]) {
    let mut seen = HashSet::new();

    for section in sections {
        if let Some(parent) = &section.parent {
            if seen.insert(parent.clone()) {
                section.prefix_parent_title = true;
            }
        }
    }
}

fn text_sections_to_chapter_previews(
    sections: &[TextImportSection],
) -> Vec<TextImportChapterPreview> {
    let mut chapters = Vec::new();
    let mut current_parent: Option<&str> = None;

    for section in sections {
        if section.parent.as_deref() != current_parent {
            current_parent = section.parent.as_deref();
            if let Some(parent) = current_parent {
                chapters.push(TextImportChapterPreview {
                    title: parent.to_string(),
                    level: 1,
                    role: "group".to_string(),
                });
            }
        }

        chapters.push(TextImportChapterPreview {
            title: section.title.clone(),
            level: if section.parent.is_some() { 2 } else { 1 },
            role: "chapter".to_string(),
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
            prefix_parent_title: false,
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
                prefix_parent_title: false,
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
            prefix_parent_title: false,
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

pub(super) fn should_skip_text_import_preview(
    storage: &AppStorage,
    path: &Path,
) -> Result<bool, String> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.txt".to_string());
    let hash = hash_file(path)?;
    let state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;

    Ok(state.library.books.iter().any(|book| {
        book.name == name && !book.content_hash.is_empty() && book.content_hash == hash
    }))
}

pub(super) fn create_text_import_preview(
    path: &Path,
    encoding: Option<&str>,
    rules: Option<&TextImportRulesInput>,
) -> TextImportPreview {
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.txt".to_string());
    let title = text_import_file_title(path, &filename);

    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return TextImportPreview {
                path: path_to_client_string(path),
                filename,
                title,
                encoding: "auto".to_string(),
                encoding_label: "Auto".to_string(),
                confidence: "failed".to_string(),
                status: TextImportStatus::Error.as_str().to_string(),
                selected: false,
                message: Some(error.to_string()),
                sample: String::new(),
                chapters: Vec::new(),
            };
        }
    };

    let decoded = decode_text_bytes(&bytes, encoding);
    let sample = decoded
        .text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("\n");
    let document = parse_text_import_document(&decoded.text, &title, rules);
    let has_text = decoded.text.chars().any(|ch| !ch.is_whitespace());
    let status = if !has_text || decoded.confidence == TextEncodingConfidence::Failed {
        TextImportStatus::Error
    } else if decoded.confidence == TextEncodingConfidence::Low {
        TextImportStatus::NeedsReview
    } else {
        TextImportStatus::Ready
    };

    TextImportPreview {
        path: path_to_client_string(path),
        filename,
        title,
        encoding: decoded.encoding,
        encoding_label: decoded.encoding_label,
        confidence: match decoded.confidence {
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
        } else if document.chapters.is_empty() {
            Some("No chapters detected; sections will be generated by length".to_string())
        } else {
            None
        },
        sample,
        chapters: document.chapters,
    }
}

fn write_text_publication(
    storage: &AppStorage,
    id: &str,
    document: &TextImportDocument,
    encoding_label: &str,
) -> Result<(), String> {
    let unpacked_dir = storage.book_dir(id).join(UNPACKED_DIR);
    if unpacked_dir.exists() {
        fs::remove_dir_all(&unpacked_dir).map_err(|error| error.to_string())?;
    }

    let meta_inf = unpacked_dir.join("META-INF");
    let oebps = unpacked_dir.join("OEBPS");
    let text_dir = oebps.join("Text");
    let styles_dir = oebps.join("Styles");
    fs::create_dir_all(&meta_inf).map_err(|error| error.to_string())?;
    fs::create_dir_all(&text_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&styles_dir).map_err(|error| error.to_string())?;

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

    for (index, section) in document.sections.iter().enumerate() {
        fs::write(
            text_dir.join(format!("part{:04}.xhtml", index + 1)),
            text_section_xhtml(section),
        )
        .map_err(|error| error.to_string())?;
    }

    fs::write(oebps.join("nav.xhtml"), text_nav_xhtml(document))
        .map_err(|error| error.to_string())?;
    fs::write(
        oebps.join("content.opf"),
        text_content_opf(document, encoding_label),
    )
    .map_err(|error| error.to_string())?;

    Ok(())
}

fn text_import_css() -> &'static str {
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

.flow-txt-volume {
  font-size: 1.45em;
  margin: 2.2em 0 1.6em;
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
    let mut body = String::new();
    let heading = if section.prefix_parent_title {
        section
            .parent
            .as_ref()
            .map(|parent| format!("{parent} {}", section.title))
            .unwrap_or_else(|| section.title.clone())
    } else {
        section.title.clone()
    };
    body.push_str(&format!(
        r#"<h2 class="flow-txt-chapter">{}</h2>"#,
        escape_xml(&heading)
    ));

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
<body>
{}
</body>
</html>"#,
        escape_xml(&heading),
        body
    )
}

pub(super) fn text_nav_xhtml(document: &TextImportDocument) -> String {
    let mut nav = String::new();
    let mut open_group: Option<String> = None;
    let mut group_index = 0usize;

    for (index, section) in document.sections.iter().enumerate() {
        if section.parent != open_group {
            if open_group.is_some() {
                nav.push_str("</ol></li>");
            }
            open_group = section.parent.clone();
            if let Some(parent) = &open_group {
                group_index += 1;
                nav.push_str(&format!(
                    r#"<li id="txt-group-{group_index:04}"><span>{}</span><ol>"#,
                    escape_xml(parent)
                ));
            }
        }

        nav.push_str(&format!(
            r#"<li><a href="Text/part{:04}.xhtml">{}</a></li>"#,
            index + 1,
            escape_xml(&section.title)
        ));
    }

    if open_group.is_some() {
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
    <dc:language>zh-CN</dc:language>
    <meta property="source-format">txt</meta>
    <meta property="source-encoding">{}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="Styles/txt.css" media-type="text/css"/>
    {}
  </manifest>
  <spine>
    {}
  </spine>
</package>"#,
        escape_xml(&document.title),
        escape_xml(&document.title),
        escape_xml(encoding_label),
        manifest_items,
        spine_items
    )
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_svg(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(super) fn import_text_path_impl(
    storage: &AppStorage,
    path: &Path,
    encoding: Option<&str>,
    replace_existing: bool,
    rules: Option<&TextImportRulesInput>,
) -> Result<BookRecord, String> {
    fs::create_dir_all(books_root(storage.root())).map_err(|error| error.to_string())?;

    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let decoded = decode_text_bytes(&bytes, encoding);
    if decoded.confidence == TextEncodingConfidence::Failed {
        return Err("Unable to decode text file".to_string());
    }

    let hash = hash_file(path)?;
    let size = fs::metadata(path).map_err(|error| error.to_string())?.len();
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.txt".to_string());
    let title = path
        .file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| name.trim_end_matches(".txt").to_string());

    let document = parse_text_import_document(&decoded.text, &title, rules);
    let metadata = json!({
        "title": title,
        "sourceFormat": "txt",
        "sourceEncoding": decoded.encoding_label,
    });

    let (mut book, id, should_copy) = {
        let mut state = storage
            .inner
            .state
            .lock()
            .map_err(|_| "storage state lock poisoned".to_string())?;
        let filename_index = state
            .library
            .books
            .iter()
            .position(|book| book.name == name);
        let hash_index = state
            .library
            .books
            .iter()
            .position(|book| !book.content_hash.is_empty() && book.content_hash == hash);

        let (index, should_copy) = if let Some(index) = filename_index {
            if !replace_existing || state.library.books[index].content_hash == hash {
                let book = state.library.books[index].clone();
                return storage.compose_book(&mut state, &book);
            }

            let book = &mut state.library.books[index];
            book.size = size;
            book.content_hash = hash;
            book.content_version = book.content_version.saturating_add(1).max(1);
            book.updated_at = Some(now_ms());
            book.last_read_at = book.updated_at;
            book.metadata = metadata.clone();
            (index, true)
        } else if let Some(index) = hash_index {
            let book = &mut state.library.books[index];
            book.name = name;
            book.size = size;
            book.updated_at = Some(now_ms());
            book.metadata = metadata.clone();
            (index, false)
        } else {
            let created_at = now_ms();
            let id = id_from_hash(&hash);
            state.library.books.push(LibraryBook {
                id,
                name,
                size,
                reading_status: None,
                content_hash: hash,
                content_version: 1,
                metadata: metadata.clone(),
                created_at,
                updated_at: None,
                last_read_at: None,
                cfi: None,
                percentage: None,
                tag_ids: Vec::new(),
            });
            (state.library.books.len() - 1, true)
        };

        let book = state.library.books[index].clone();
        let id = book.id.clone();
        (book, id, should_copy)
    };

    if should_copy {
        let dir = storage.book_dir(&id);
        storage.unload_search_text_cache(&id);
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        if dir.join(BOOK_FILE).exists() {
            let _ = fs::remove_file(dir.join(BOOK_FILE));
        }
        fs::copy(path, dir.join(SOURCE_TEXT_FILE)).map_err(|error| error.to_string())?;
        write_text_publication(storage, &id, &document, &decoded.encoding_label)?;
        book.metadata = metadata;
        {
            let mut state = storage
                .inner
                .state
                .lock()
                .map_err(|_| "storage state lock poisoned".to_string())?;
            if let Some(stored_book) = state.library.books.iter_mut().find(|book| book.id == id) {
                stored_book.metadata = book.metadata.clone();
            }
        }
        write_metadata(storage, &id, &book.metadata)?;
        write_cover(
            storage,
            &id,
            create_text_cover_input(
                &book.metadata,
                path.file_stem().and_then(|name| name.to_str()),
            ),
        )?;
        if let Err(error) = build_and_write_search_text_cache(storage, &book) {
            eprintln!("Failed to build search text cache for {}: {error}", book.id);
        }
    }

    storage.mark_library_dirty();
    storage.flush_dirty()?;

    let mut state = storage
        .inner
        .state
        .lock()
        .map_err(|_| "storage state lock poisoned".to_string())?;
    storage.compose_book(&mut state, &book)
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
