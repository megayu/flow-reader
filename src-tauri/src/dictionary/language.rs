pub(super) fn infer_language(value: &str) -> Option<String> {
    let value = value.trim().replace('_', "-").to_lowercase();
    if value == "zh"
        || value.starts_with("zh-")
        || matches!(
            value.as_str(),
            "zho" | "chi" | "chinese" | "中文" | "汉语" | "漢語"
        )
    {
        return Some("zh".to_string());
    }
    if value == "en"
        || value.starts_with("en-")
        || matches!(value.as_str(), "eng" | "english" | "英文" | "英语" | "英語")
    {
        return Some("en".to_string());
    }

    match value.as_str() {
        "de" | "deu" | "ger" | "german" | "deutsch" => Some("de"),
        "es" | "spa" | "spanish" | "español" => Some("es"),
        "fr" | "fra" | "fre" | "french" | "français" => Some("fr"),
        "it" | "ita" | "italian" | "italiano" => Some("it"),
        "ja" | "jpn" | "japanese" | "日本語" => Some("ja"),
        "ko" | "kor" | "korean" | "한국어" => Some("ko"),
        "nl" | "nld" | "dut" | "dutch" | "nederlands" => Some("nl"),
        "pl" | "pol" | "polish" | "polski" => Some("pl"),
        "pt" | "por" | "portuguese" | "português" => Some("pt"),
        "ru" | "rus" | "russian" | "русский" => Some("ru"),
        _ => None,
    }
    .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::infer_language;

    #[test]
    fn recognizes_explicit_dictionary_language_metadata() {
        assert_eq!(infer_language("zh_Hant"), Some("zh".to_string()));
        assert_eq!(infer_language("English"), Some("en".to_string()));
        assert_eq!(infer_language("Français"), Some("fr".to_string()));
        assert_eq!(infer_language("fr-FR"), None);
    }
}
