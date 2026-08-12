use crate::CoverError;

pub(crate) fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

pub(crate) fn resolve_href(parent: &str, href: &str) -> Result<String, CoverError> {
    let href = local_reference(href)?;
    let joined = if href.starts_with('/') || parent.is_empty() {
        href.trim_start_matches('/').to_string()
    } else {
        format!("{parent}/{href}")
    };
    normalize(&joined)
}

pub(crate) fn lookup_candidates(path: &str) -> Result<Vec<String>, CoverError> {
    let normalized = normalize(path)?;
    let mut candidates = vec![normalized.clone()];
    let decoded = percent_decode(&normalized);
    if decoded != normalized
        && let Ok(decoded) = normalize(&decoded)
    {
        candidates.push(decoded);
    }
    Ok(candidates)
}

pub(crate) fn equivalent(left: &str, right: &str) -> bool {
    let Ok(left) = lookup_candidates(left) else {
        return false;
    };
    let Ok(right) = lookup_candidates(right) else {
        return false;
    };
    left.iter()
        .any(|left| right.iter().any(|right| left.eq_ignore_ascii_case(right)))
}

fn local_reference(value: &str) -> Result<&str, CoverError> {
    let value = value.split(['?', '#']).next().unwrap_or("").trim();
    if value.is_empty() || has_uri_scheme(value) {
        return Err(CoverError::UnsafePath(value.to_string()));
    }
    Ok(value)
}

fn normalize(value: &str) -> Result<String, CoverError> {
    let value = value.replace('\\', "/");
    if value.contains('\0') {
        return Err(CoverError::UnsafePath(value));
    }

    let mut parts = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(CoverError::UnsafePath(value));
                }
            }
            _ => parts.push(part),
        }
    }

    if parts.is_empty() {
        return Err(CoverError::UnsafePath(value));
    }
    Ok(parts.join("/"))
}

fn has_uri_scheme(value: &str) -> bool {
    let prefix = value.split(['/', '\\']).next().unwrap_or("");
    prefix.split_once(':').is_some_and(|(scheme, _)| {
        !scheme.is_empty()
            && scheme
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
    })
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
        {
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).unwrap_or_else(|_| value.to_string())
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}
