use std::{env, fs, path::PathBuf};

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let identifiers_path = manifest_dir.join("../windows-identifiers.json");
    println!("cargo:rerun-if-changed={}", identifiers_path.display());

    let source = fs::read_to_string(&identifiers_path).expect("read Windows identifier manifest");
    let identifiers: serde_json::Value =
        serde_json::from_str(&source).expect("parse Windows identifier manifest");
    let provider_clsid = identifiers["providerClsid"]
        .as_str()
        .expect("providerClsid must be a string");
    let provider_value = parse_guid(provider_clsid, "providerClsid");

    let generated = format!(
        "pub const PROVIDER_CLSID: windows::core::GUID = windows::core::GUID::from_u128(0x{provider_value:032x});\n"
    );
    let output_path = PathBuf::from(env::var_os("OUT_DIR").expect("build output directory"))
        .join("provider_clsid.rs");
    fs::write(output_path, generated).expect("write generated provider CLSID");
}

fn parse_guid(value: &str, name: &str) -> u128 {
    let compact = value
        .strip_prefix('{')
        .and_then(|value| value.strip_suffix('}'))
        .unwrap_or_else(|| panic!("{name} must use braced GUID syntax"))
        .replace('-', "");
    assert!(
        compact.len() == 32 && compact.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "{name} must be a valid GUID"
    );
    u128::from_str_radix(&compact, 16).unwrap_or_else(|_| panic!("{name} must be a valid GUID"))
}
