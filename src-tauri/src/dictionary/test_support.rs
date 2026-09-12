use std::{fs, path::Path};

pub(crate) fn write_mdict_header(path: &Path, tag: &str) {
    let header = format!(
        r#"<{tag} GeneratedByEngineVersion="2.0" RequiredEngineVersion="2.0" Encoding="UTF-8" Encrypted="No"/>"#
    );
    let header = header.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
    let mut a = 1_u32;
    let mut b = 0_u32;
    for byte in &header {
        a = (a + u32::from(*byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&(header.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(&((b << 16) | a).to_le_bytes());
    fs::write(path, bytes).unwrap();
}
