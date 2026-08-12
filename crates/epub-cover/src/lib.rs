mod archive;
mod container;
mod error;
mod opf;
mod path;
mod types;

use std::io::{Read, Seek};

use zip::ZipArchive;

pub use error::CoverError;
pub use types::{CoverAsset, EpubCoverInspection};

pub fn inspect_epub_cover<R: Read + Seek>(source: R) -> Result<EpubCoverInspection, CoverError> {
    let mut archive = ZipArchive::new(source)?;
    inspect_epub_cover_archive(&mut archive)
}

pub fn inspect_epub_cover_archive<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<EpubCoverInspection, CoverError> {
    let (container_xml, _) = archive::read_xml_entry(archive, "META-INF/container.xml")?;
    let requested_opf_path = container::package_path(&container_xml)?;
    let (opf_xml, opf_path) = archive::read_xml_entry(archive, &requested_opf_path)?;
    let cover = opf::inspect_cover(archive, &opf_path, &opf_xml)?;

    Ok(EpubCoverInspection { opf_xml, cover })
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use zip::{ZipWriter, write::SimpleFileOptions};

    use super::inspect_epub_cover;

    #[test]
    fn discovers_epub3_cover_image_from_package_manifest() {
        let container = r#"<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#;
        let package = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Synthetic Title</dc:title>
    <dc:creator>Synthetic Creator</dc:creator>
  </metadata>
  <manifest>
    <item id="cover" href="Images/front.jpg" media-type="image/jpeg" properties="cover-image"/>
  </manifest>
</package>"#;
        let cover_bytes = b"synthetic-jpeg-bytes";

        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        archive
            .start_file("META-INF/container.xml", options)
            .unwrap();
        archive.write_all(container.as_bytes()).unwrap();
        archive.start_file("OPS/package.opf", options).unwrap();
        archive.write_all(package.as_bytes()).unwrap();
        archive.start_file("OPS/Images/front.jpg", options).unwrap();
        archive.write_all(cover_bytes).unwrap();
        let source = archive.finish().unwrap().into_inner();

        let inspection = inspect_epub_cover(Cursor::new(source)).unwrap();
        let cover = inspection.cover.unwrap();

        assert_eq!(cover.archive_path, "OPS/Images/front.jpg");
        assert_eq!(cover.media_type, "image/jpeg");
        assert_eq!(cover.extension, "jpg");
        assert_eq!(cover.bytes, cover_bytes);
    }

    #[test]
    fn falls_back_to_cover_prefixed_manifest_image_id() {
        let container =
            r#"<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>"#;
        let package = r#"<package>
  <manifest>
    <item id="cover.jpg" href="Images/obfuscated-image.jpg" media-type="image/jpeg"/>
  </manifest>
</package>"#;
        let cover_bytes = b"synthetic-fallback-cover";

        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        archive
            .start_file("META-INF/container.xml", options)
            .unwrap();
        archive.write_all(container.as_bytes()).unwrap();
        archive.start_file("package.opf", options).unwrap();
        archive.write_all(package.as_bytes()).unwrap();
        archive
            .start_file("Images/obfuscated-image.jpg", options)
            .unwrap();
        archive.write_all(cover_bytes).unwrap();
        let source = archive.finish().unwrap().into_inner();

        let cover = inspect_epub_cover(Cursor::new(source))
            .unwrap()
            .cover
            .unwrap();

        assert_eq!(cover.archive_path, "Images/obfuscated-image.jpg");
        assert_eq!(cover.bytes, cover_bytes);
    }

    #[test]
    fn discovers_cover_from_utf16_xml_documents() {
        fn utf16_le(value: &str) -> Vec<u8> {
            let mut bytes = vec![0xff, 0xfe];
            bytes.extend(value.encode_utf16().flat_map(u16::to_le_bytes));
            bytes
        }

        let container = r#"<?xml version="1.0" encoding="UTF-16"?><container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>"#;
        let package = r#"<?xml version="1.0" encoding="UTF-16"?><package><manifest>
  <item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>
</manifest></package>"#;
        let cover_bytes = b"synthetic-png-bytes";
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        archive
            .start_file("META-INF/container.xml", options)
            .unwrap();
        archive.write_all(&utf16_le(container)).unwrap();
        archive.start_file("package.opf", options).unwrap();
        archive.write_all(&utf16_le(package)).unwrap();
        archive.start_file("cover.png", options).unwrap();
        archive.write_all(cover_bytes).unwrap();
        let source = archive.finish().unwrap().into_inner();

        let cover = inspect_epub_cover(Cursor::new(source))
            .unwrap()
            .cover
            .unwrap();

        assert_eq!(cover.archive_path, "cover.png");
        assert_eq!(cover.bytes, cover_bytes);
    }
}
