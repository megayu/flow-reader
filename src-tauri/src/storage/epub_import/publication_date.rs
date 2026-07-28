use super::clean_xml_text;

pub(crate) fn normalize_publication_date(value: &str) -> String {
    let text = clean_xml_text(value);
    if text.is_empty() {
        return text;
    }

    extract_normalized_publication_date(&text).unwrap_or(text)
}

fn extract_normalized_publication_date(text: &str) -> Option<String> {
    for (index, _) in text.char_indices() {
        if !starts_with_ascii_digits(text, index, 4) {
            continue;
        }
        if previous_char_is_ascii_digit(text, index) {
            continue;
        }

        let digit_count = text[index..]
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .count();

        if let Some(date) = parse_compact_publication_date(text, index, digit_count) {
            return Some(date);
        }

        if digit_count >= 6 {
            continue;
        }

        if let Some(date) = parse_separated_publication_date(text, index) {
            return Some(date);
        }

        if text[index + 4..]
            .chars()
            .next()
            .is_some_and(is_publication_date_separator)
        {
            continue;
        }

        let end = index + 4;
        if !next_char_is_ascii_digit(text, end) {
            return Some(text[index..end].to_string());
        }
    }

    None
}

fn parse_compact_publication_date(text: &str, index: usize, digit_count: usize) -> Option<String> {
    if digit_count >= 8 {
        let year = &text[index..index + 4];
        let month = parse_date_component(&text[index + 4..index + 6], 1, 12)?;
        let day = parse_date_component(&text[index + 6..index + 8], 1, 31)?;
        return Some(format!("{year}-{month:02}-{day:02}"));
    }

    if digit_count == 6 {
        let year = &text[index..index + 4];
        let month = parse_date_component(&text[index + 4..index + 6], 1, 12)?;
        return Some(format!("{year}-{month:02}"));
    }

    None
}

fn parse_separated_publication_date(text: &str, index: usize) -> Option<String> {
    let year = &text[index..index + 4];
    let mut cursor = index + 4;
    let separator = text[cursor..].chars().next()?;

    if !is_publication_date_separator(separator) {
        return None;
    }

    cursor += separator.len_utf8();
    let (month, next_cursor) = read_numeric_component(text, cursor, 2)?;
    let month = parse_date_component(month, 1, 12)?;
    cursor = next_cursor;

    let Some(next) = text[cursor..].chars().next() else {
        return Some(format!("{year}-{month:02}"));
    };

    if next == '月' || is_publication_date_separator(next) {
        cursor += next.len_utf8();
    } else {
        return Some(format!("{year}-{month:02}"));
    }

    let Some((day, next_cursor)) = read_numeric_component(text, cursor, 2) else {
        return Some(format!("{year}-{month:02}"));
    };
    let day = parse_date_component(day, 1, 31)?;
    cursor = next_cursor;

    if text[cursor..].starts_with('日') {
        cursor += '日'.len_utf8();
    }

    if next_char_is_ascii_digit(text, cursor) {
        return None;
    }

    Some(format!("{year}-{month:02}-{day:02}"))
}

fn starts_with_ascii_digits(text: &str, index: usize, count: usize) -> bool {
    text[index..]
        .chars()
        .take(count)
        .filter(|character| character.is_ascii_digit())
        .count()
        == count
}

fn previous_char_is_ascii_digit(text: &str, index: usize) -> bool {
    text[..index]
        .chars()
        .next_back()
        .is_some_and(|character| character.is_ascii_digit())
}

fn next_char_is_ascii_digit(text: &str, index: usize) -> bool {
    text[index..]
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_digit())
}

fn is_publication_date_separator(character: char) -> bool {
    matches!(character, '-' | '/' | '.' | '年')
}

fn read_numeric_component(text: &str, index: usize, max_digits: usize) -> Option<(&str, usize)> {
    let mut end = index;
    let mut digits = 0;

    for (offset, character) in text[index..].char_indices() {
        if !character.is_ascii_digit() || digits >= max_digits {
            break;
        }

        digits += 1;
        end = index + offset + character.len_utf8();
    }

    if digits == 0 {
        None
    } else {
        Some((&text[index..end], end))
    }
}

fn parse_date_component(value: &str, min: u32, max: u32) -> Option<u32> {
    let value = value.parse::<u32>().ok()?;
    (min..=max).contains(&value).then_some(value)
}
