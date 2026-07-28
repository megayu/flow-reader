use super::*;

pub(in crate::storage) fn inspect_epub_access(path: &Path) -> Result<EpubAccessInfo, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut flags = Vec::new();
    let mut has_non_portable_path = false;
    let mut declares_encryption = false;

    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = file.name().replace('\\', "/");
        if non_portable_zip_path(&name) {
            has_non_portable_path = true;
        }
        if name.eq_ignore_ascii_case("META-INF/encryption.xml") {
            declares_encryption = true;
        }
    }

    if has_non_portable_path {
        flags.push(BookContentFlag::NonPortableArchivePaths);
    }
    if declares_encryption {
        flags.push(BookContentFlag::DeclaresEncryption);
    }

    Ok(EpubAccessInfo {
        mode: if has_non_portable_path {
            BookContentMode::ArchiveOnly
        } else {
            BookContentMode::Normal
        },
        flags,
    })
}

pub(super) fn non_portable_zip_path(path: &str) -> bool {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .any(non_portable_path_segment)
}

pub(super) fn non_portable_path_segment(segment: &str) -> bool {
    let invalid_character = segment
        .chars()
        .any(|character| matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*'));
    if invalid_character || segment.ends_with(' ') || segment.ends_with('.') {
        return true;
    }

    let stem = segment
        .split_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(segment)
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

pub(in crate::storage) fn unpack_epub(path: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(dest).map_err(|error| error.to_string())?;

    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
        let Some(enclosed_name) = file.enclosed_name() else {
            continue;
        };
        let outpath = dest.join(enclosed_name);

        if file.is_dir() {
            fs::create_dir_all(&outpath).map_err(|error| error.to_string())?;
            continue;
        }

        if let Some(parent) = outpath.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }

        let mut outfile = fs::File::create(&outpath).map_err(|error| error.to_string())?;
        std::io::copy(&mut file, &mut outfile).map_err(|error| error.to_string())?;
    }

    Ok(())
}

pub(in crate::storage) fn find_unpacked_opf_path(unpacked_dir: &Path) -> Result<PathBuf, String> {
    let container_path = unpacked_dir.join("META-INF").join("container.xml");
    let container = fs::read_to_string(&container_path).map_err(|error| error.to_string())?;
    let container_doc =
        roxmltree::Document::parse(&container).map_err(|error| error.to_string())?;
    let opf_path = container_doc
        .descendants()
        .find(|node| node.has_tag_name("rootfile"))
        .and_then(|node| node.attribute("full-path"))
        .ok_or_else(|| "EPUB container has no rootfile".to_string())?;
    let normalized = normalize_zip_path(opf_path.replace('\\', "/"));
    if normalized.is_empty() {
        return Err("EPUB container has invalid rootfile".to_string());
    }

    Ok(unpacked_dir.join(normalized))
}
