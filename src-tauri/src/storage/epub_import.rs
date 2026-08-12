use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufReader, BufWriter, Cursor, Read, Seek, Write},
    path::{Path, PathBuf},
};

use regex::Regex;
use serde_json::{Value, json};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use super::*;

pub(super) mod access;
mod metadata_cover;
mod normalize;
mod pipeline;
mod publication_date;

use metadata_cover::*;
use normalize::*;

use access::{EPUB_COVER_READ_LIMIT, EPUB_XML_READ_LIMIT};
pub(super) use access::{
    EPUB_MAX_SEARCH_TEXT_BYTES, find_unpacked_opf_path, inspect_epub_access, read_bounded_bytes, read_epub_xml_file,
    unpack_epub, validate_epub_archive_limits,
};
#[cfg(test)]
pub(super) use metadata_cover::normalize_non_square_pixel_png;
pub(super) use metadata_cover::{clean_xml_text, join_zip_path, normalize_zip_path, parent_zip_path};
#[cfg(test)]
pub(super) use normalize::relative_zip_path;
pub(super) use normalize::{deobfuscate_unpacked_idpf_fonts, normalize_unpacked_epub_structure};
pub(super) use pipeline::{
    commit_prepared_epub_import, materialize_epub_package, open_external_epub_path_impl, prepare_epub_import,
};

pub(super) use publication_date::normalize_publication_date;

const EPUB_SECTION_SPLIT_MIN_BYTES: u64 = 512 * 1024;
const EPUB_SECTION_SPLIT_MIN_NAV_POINTS: usize = 2;
const EPUB_MISSING_SPINE_MIN_NAV_TARGETS: usize = 2;
const EPUB_MISSING_SPINE_MAX_SMALL_READABLE_SPINE: usize = 2;
struct ParsedEpubInfo {
    metadata: Value,
    cover: Option<ParsedEpubCover>,
    generated_cover: bool,
}

struct ParsedEpubCover {
    input: CoverInput,
    archive_path: Option<String>,
}

#[derive(Debug, Clone)]
struct OpfManifestItem {
    id: String,
    href: String,
    media_type: String,
    properties: String,
}

#[derive(Debug, Clone)]
struct OpfSpineItem {
    idref: String,
    linear: Option<String>,
}

#[derive(Debug, Clone)]
struct NcxReference {
    raw_src: String,
    path: String,
    fragment: String,
}

#[derive(Debug, Clone)]
struct SplitSection {
    original_id: String,
    original_abs_path: String,
    original_file_path: PathBuf,
    replacements: Vec<(String, String)>,
    link_targets: Vec<(String, String)>,
    split_items: Vec<SplitItem>,
}

#[derive(Debug, Clone)]
struct SplitItem {
    id: String,
    href: String,
    abs_path: String,
    content: String,
}

#[derive(Debug, Clone)]
struct OpenElement {
    name: String,
    open_tag: String,
    start: usize,
}

#[derive(Debug, Clone)]
struct AnchorSplitPoint {
    anchor_position: usize,
    split_start_position: usize,
    open_ancestors: Vec<OpenElement>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split_test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("flow-reader-{name}-{}-{}", std::process::id(), now_ms()));
        if root.exists() {
            fs::remove_dir_all(&root).unwrap();
        }
        fs::create_dir_all(root.join("META-INF")).unwrap();
        fs::create_dir_all(root.join("OEBPS/Text")).unwrap();
        fs::write(
            root.join("META-INF/container.xml"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
        )
        .unwrap();
        root
    }

    fn write_split_fixture(root: &Path, nav_point_count: usize) {
        fs::write(
            root.join("OEBPS/content.opf"),
            r#"<package>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="part" href="Text/part0000.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="part"/>
  </spine>
</package>"#,
        )
        .unwrap();

        let mut ncx = String::from("<ncx><navMap>");
        for index in 0..nav_point_count {
            ncx.push_str(&format!(
                r#"<navPoint id="nav{index}"><content src="Text/part0000.xhtml#nav_point_{index}"/></navPoint>"#
            ));
        }
        ncx.push_str("</navMap></ncx>");
        fs::write(root.join("OEBPS/toc.ncx"), ncx).unwrap();

        let mut xhtml = String::from(
            r##"<?xml version="1.0" encoding="utf-8"?><html><head><title>Split</title></head><body>
<p><a href="part0000.xhtml#nav_point_7">file target</a><a href="#nav_point_7">local target</a><a href="./part0000.xhtml#nav_point_1">dot target</a><a href="Text/part0000.xhtml#nav_point_2">raw target</a></p>
<table><tr><td>table should not block splitting</td></tr></table>
"##,
        );
        let filler = "x".repeat(EPUB_SECTION_SPLIT_MIN_BYTES as usize / nav_point_count.max(1) + 1_024);
        for index in 0..nav_point_count {
            xhtml.push_str(&format!(
                r#"<h1 id="nav_point_{index}">Section {index}</h1><p>{filler}</p>"#
            ));
        }
        xhtml.push_str("</body></html>");
        fs::write(root.join("OEBPS/Text/part0000.xhtml"), xhtml).unwrap();
    }

    #[test]
    fn normalize_deobfuscates_idpf_fonts_once() {
        const KEY: [u8; 20] = [
            0xb5, 0x62, 0xe8, 0x3e, 0x16, 0x06, 0x57, 0x9a, 0x9c, 0x6c, 0x70, 0xa7, 0x5f, 0x4a, 0x14, 0xd2, 0xea, 0x36,
            0xb0, 0x9e,
        ];

        let root = split_test_root("idpf-font");
        fs::create_dir_all(root.join("OEBPS/fonts")).unwrap();
        fs::write(
            root.join("OEBPS/content.opf"),
            r#"<package unique-identifier="pub-id">
  <metadata><identifier id="pub-id">ocf-font_obfuscation</identifier></metadata>
  <manifest><item id="font" href="fonts/Test.ttf" media-type="font/ttf"/></manifest>
  <spine/>
</package>"#,
        )
        .unwrap();
        fs::write(
            root.join("META-INF/encryption.xml"),
            r#"<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/fonts/Test.ttf"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>"#,
        )
        .unwrap();

        let mut clear = (0..1_100).map(|index| index as u8).collect::<Vec<_>>();
        clear[..4].copy_from_slice(&[0x00, 0x01, 0x00, 0x00]);
        let mut encrypted = clear.clone();
        for (index, byte) in encrypted.iter_mut().take(1_040).enumerate() {
            *byte ^= KEY[index % KEY.len()];
        }
        let font_path = root.join("OEBPS/fonts/Test.ttf");
        fs::write(&font_path, encrypted).unwrap();

        assert!(normalize_unpacked_epub_structure(&root).unwrap());
        assert_eq!(fs::read(&font_path).unwrap(), clear);
        assert!(
            !fs::read_to_string(root.join("META-INF/encryption.xml"))
                .unwrap()
                .contains("EncryptedData")
        );
        assert!(!normalize_unpacked_epub_structure(&root).unwrap());
        assert_eq!(fs::read(&font_path).unwrap(), clear);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_splits_table_sections_and_rewrites_internal_links() {
        let root = split_test_root("split-table-links");
        write_split_fixture(&root, 8);

        assert!(normalize_unpacked_epub_structure(&root).unwrap());

        assert!(!root.join("OEBPS/Text/part0000.xhtml").exists());
        assert!(root.join("OEBPS/Text/part0000-flow-split-0008.xhtml").exists());

        let first_split = fs::read_to_string(root.join("OEBPS/Text/part0000-flow-split-0001.xhtml")).unwrap();
        assert!(first_split.contains("<table>"));
        assert!(!first_split.contains(r#"href="part0000.xhtml#nav_point_7""#));
        assert!(!first_split.contains(r##"href="#nav_point_7""##));
        assert!(!first_split.contains(r#"href="./part0000.xhtml#nav_point_1""#));
        assert!(!first_split.contains(r#"href="Text/part0000.xhtml#nav_point_2""#));
        assert!(first_split.contains(r#"href="part0000-flow-split-0008.xhtml#nav_point_7""#));
        assert!(first_split.contains(r#"href="part0000-flow-split-0002.xhtml#nav_point_1""#));
        assert!(first_split.contains(r#"href="part0000-flow-split-0003.xhtml#nav_point_2""#));

        let ncx = fs::read_to_string(root.join("OEBPS/toc.ncx")).unwrap();
        assert!(ncx.contains("Text/part0000-flow-split-0008.xhtml#nav_point_7"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_splits_two_anchor_oversized_section() {
        let root = split_test_root("split-two-anchors");
        write_split_fixture(&root, 2);

        assert!(normalize_unpacked_epub_structure(&root).unwrap());

        assert!(!root.join("OEBPS/Text/part0000.xhtml").exists());
        assert!(root.join("OEBPS/Text/part0000-flow-split-0002.xhtml").exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_splits_xhtml_doctype_section() {
        let root = split_test_root("split-xhtml-doctype");
        write_split_fixture(&root, 2);
        let xhtml_path = root.join("OEBPS/Text/part0000.xhtml");
        let xhtml = fs::read_to_string(&xhtml_path).unwrap();
        fs::write(
            &xhtml_path,
            xhtml.replacen(
                r#"<?xml version="1.0" encoding="utf-8"?>"#,
                r#"<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">"#,
                1,
            ),
        )
        .unwrap();

        assert!(normalize_unpacked_epub_structure(&root).unwrap());

        assert!(!root.join("OEBPS/Text/part0000.xhtml").exists());
        assert!(root.join("OEBPS/Text/part0000-flow-split-0002.xhtml").exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_splits_html_compatible_named_entities() {
        let root = split_test_root("split-html-entities");
        write_split_fixture(&root, 2);
        let xhtml_path = root.join("OEBPS/Text/part0000.xhtml");
        let xhtml = fs::read_to_string(&xhtml_path).unwrap();
        fs::write(
            &xhtml_path,
            xhtml.replacen(
                r#"<h1 id="nav_point_0">Section 0</h1>"#,
                r#"<h1 id="nav_point_0">Section&nbsp;0</h1>"#,
                1,
            ),
        )
        .unwrap();

        assert!(normalize_unpacked_epub_structure(&root).unwrap());

        assert!(!root.join("OEBPS/Text/part0000.xhtml").exists());
        let first_split = fs::read_to_string(root.join("OEBPS/Text/part0000-flow-split-0001.xhtml")).unwrap();
        assert!(first_split.contains("Section&nbsp;0"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_splits_html_compatible_embedded_svg() {
        let root = split_test_root("split-embedded-svg");
        write_split_fixture(&root, 2);
        let xhtml_path = root.join("OEBPS/Text/part0000.xhtml");
        let xhtml = fs::read_to_string(&xhtml_path).unwrap();
        fs::write(
            &xhtml_path,
            xhtml.replacen(
                r#"<h1 id="nav_point_0">Section 0</h1>"#,
                r#"<svg width="1" height="1"><title>marker</title></svg><h1 id="nav_point_0">Section 0</h1>"#,
                1,
            ),
        )
        .unwrap();

        assert!(normalize_unpacked_epub_structure(&root).unwrap());

        assert!(!root.join("OEBPS/Text/part0000.xhtml").exists());
        let first_split = fs::read_to_string(root.join("OEBPS/Text/part0000-flow-split-0001.xhtml")).unwrap();
        assert!(first_split.contains("<svg"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_splits_rewrites_existing_nav_and_guide_links() {
        let root = split_test_root("split-nav-links");
        write_split_fixture(&root, 3);
        fs::write(
            root.join("OEBPS/content.opf"),
            r#"<package>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="nav" href="Text/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="part" href="Text/part0000.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="part"/>
  </spine>
  <guide>
    <reference type="toc" href="Text/part0000.xhtml#book_toc"/>
  </guide>
</package>"#,
        )
        .unwrap();
        fs::write(
            root.join("OEBPS/Text/nav.xhtml"),
            r#"<?xml version="1.0" encoding="utf-8"?><html><body>
<nav><ol>
  <li><a href="part0000.xhtml#book_toc">Contents</a></li>
  <li><a href="part0000.xhtml#nav_point_0">One</a></li>
  <li><a href="part0000.xhtml#nav_point_1">Two</a></li>
  <li><a href="part0000.xhtml#nav_point_2">Three</a></li>
</ol></nav>
</body></html>"#,
        )
        .unwrap();

        let xhtml_path = root.join("OEBPS/Text/part0000.xhtml");
        let xhtml = fs::read_to_string(&xhtml_path).unwrap();
        fs::write(
            &xhtml_path,
            xhtml.replacen("<body>", r#"<body><div id="book_toc">Contents</div>"#, 1),
        )
        .unwrap();

        normalize_unpacked_epub_structure(&root).unwrap();

        let nav = fs::read_to_string(root.join("OEBPS/Text/nav.xhtml")).unwrap();
        assert!(!nav.contains("part0000.xhtml#"));
        assert!(nav.contains("part0000-flow-split-0001.xhtml#book_toc"));
        assert!(nav.contains("part0000-flow-split-0001.xhtml#nav_point_0"));
        assert!(nav.contains("part0000-flow-split-0002.xhtml#nav_point_1"));
        assert!(nav.contains("part0000-flow-split-0003.xhtml#nav_point_2"));

        let opf = fs::read_to_string(root.join("OEBPS/content.opf")).unwrap();
        assert!(opf.contains(r#"href="Text/part0000-flow-split-0001.xhtml#book_toc""#));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_splits_from_block_boundaries_when_anchor_is_wrapped() {
        let root = split_test_root("split-block-boundary");
        fs::write(
            root.join("OEBPS/content.opf"),
            r#"<package>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="part" href="Text/part0000.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="part"/>
  </spine>
</package>"#,
        )
        .unwrap();

        let mut ncx = String::from("<ncx><navMap>");
        for index in 0..8 {
            ncx.push_str(&format!(
                r#"<navPoint id="nav{index}"><content src="Text/part0000.xhtml#nav_point_{index}"/></navPoint>"#
            ));
        }
        ncx.push_str("</navMap></ncx>");
        fs::write(root.join("OEBPS/toc.ncx"), ncx).unwrap();

        let filler = "x".repeat(70_000);
        let mut xhtml = String::from(r#"<?xml version="1.0" encoding="utf-8"?><html><body><div id="book">"#);
        for index in 0..8 {
            xhtml.push_str(&format!(
                r#"<div class="text"><p id="nav_point_{index}">Section {index}</p><p>{filler}</p></div>"#
            ));
        }
        xhtml.push_str("</div></body></html>");
        fs::write(root.join("OEBPS/Text/part0000.xhtml"), xhtml).unwrap();

        normalize_unpacked_epub_structure(&root).unwrap();

        assert!(!root.join("OEBPS/Text/part0000.xhtml").exists());
        for index in 1..=8 {
            let split_path = root.join(format!("OEBPS/Text/part0000-flow-split-{index:04}.xhtml"));
            let split = fs::read_to_string(split_path).unwrap();
            assert!(
                !split.contains("</body></html></div>"),
                "split should not contain trailing orphan closing tags"
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_splits_html_compatible_namespace_prefixed_tags() {
        let root = split_test_root("split-undeclared-prefix");
        fs::write(
            root.join("OEBPS/content.opf"),
            r#"<package>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="part" href="Text/part0000.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="part"/>
  </spine>
</package>"#,
        )
        .unwrap();
        fs::write(
            root.join("OEBPS/toc.ncx"),
            r#"<ncx><navMap>
  <navPoint id="nav0"><content src="Text/part0000.xhtml#nav_point_0"/></navPoint>
  <navPoint id="nav1"><content src="Text/part0000.xhtml#nav_point_1"/></navPoint>
</navMap></ncx>"#,
        )
        .unwrap();

        let filler = "x".repeat(270_000);
        fs::write(
            root.join("OEBPS/Text/part0000.xhtml"),
            format!(
                r#"<?xml version="1.0" encoding="utf-8"?><html><body><mbp:pagebreak/><h1 id="nav_point_0">One</h1><p>{filler}</p><h1 id="nav_point_1">Two</h1><p>{filler}</p></body></html>"#
            ),
        )
        .unwrap();

        normalize_unpacked_epub_structure(&root).unwrap();

        assert!(!root.join("OEBPS/Text/part0000.xhtml").exists());
        assert!(root.join("OEBPS/Text/part0000-flow-split-0002.xhtml").exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_adds_manifest_chapters_missing_from_spine() {
        let root = split_test_root("missing-spine-chapters");
        fs::write(
            root.join("OEBPS/content.opf"),
            r#"<package>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="toc" href="Text/part0000.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-1" href="Text/part0001.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-2" href="Text/part0002.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-3" href="Text/part0003.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="toc"/>
  </spine>
</package>"#,
        )
        .unwrap();
        fs::write(
            root.join("OEBPS/toc.ncx"),
            r#"<ncx><navMap>
  <navPoint id="toc"><content src="Text/part0000.xhtml"/></navPoint>
  <navPoint id="chapter-1"><content src="Text/part0001.xhtml"/></navPoint>
  <navPoint id="chapter-2"><content src="Text/part0002.xhtml"/></navPoint>
  <navPoint id="chapter-3"><content src="Text/part0003.xhtml"/></navPoint>
</navMap></ncx>"#,
        )
        .unwrap();
        for index in 0..=3 {
            fs::write(
                root.join(format!("OEBPS/Text/part000{index}.xhtml")),
                format!(r#"<html><body><h1>Part {index}</h1></body></html>"#),
            )
            .unwrap();
        }

        assert!(normalize_unpacked_epub_structure(&root).unwrap());

        let opf = fs::read_to_string(root.join("OEBPS/content.opf")).unwrap();
        assert!(opf.contains(r#"<itemref idref="toc"/>"#));
        assert!(opf.contains(r#"<itemref idref="chapter-1"/>"#));
        assert!(opf.contains(r#"<itemref idref="chapter-2"/>"#));
        assert!(opf.contains(r#"<itemref idref="chapter-3"/>"#));
        assert!(root.join("OEBPS/Text/part0001.xhtml").exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_leaves_small_missing_nav_targets_out_of_full_spine() {
        let root = split_test_root("small-missing-spine-targets");
        fs::write(
            root.join("OEBPS/content.opf"),
            r#"<package>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="chapter-1" href="Text/part0001.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-2" href="Text/part0002.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-3" href="Text/part0003.xhtml" media-type="application/xhtml+xml"/>
    <item id="appendix" href="Text/appendix.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter-1"/>
    <itemref idref="chapter-2"/>
    <itemref idref="chapter-3"/>
  </spine>
</package>"#,
        )
        .unwrap();
        fs::write(
            root.join("OEBPS/toc.ncx"),
            r#"<ncx><navMap>
  <navPoint id="chapter-1"><content src="Text/part0001.xhtml"/></navPoint>
  <navPoint id="chapter-2"><content src="Text/part0002.xhtml"/></navPoint>
  <navPoint id="chapter-3"><content src="Text/part0003.xhtml"/></navPoint>
  <navPoint id="appendix"><content src="Text/appendix.xhtml"/></navPoint>
</navMap></ncx>"#,
        )
        .unwrap();
        for name in ["part0001", "part0002", "part0003", "appendix"] {
            fs::write(
                root.join(format!("OEBPS/Text/{name}.xhtml")),
                format!(r#"<html><body><h1>{name}</h1></body></html>"#),
            )
            .unwrap();
        }

        assert!(!normalize_unpacked_epub_structure(&root).unwrap());

        let opf = fs::read_to_string(root.join("OEBPS/content.opf")).unwrap();
        assert!(!opf.contains(r#"<itemref idref="appendix"/>"#));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_marks_only_toc_linear_no_targets_readable() {
        let root = split_test_root("linear-no-toc-targets");
        fs::write(
            root.join("OEBPS/content.opf"),
            r#"<package>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="nav" href="Text/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="book-toc" href="Text/part0000.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="Text/cover_page.xhtml" media-type="application/xhtml+xml"/>
    <item id="volume-cover-ncx" href="Text/part0001.xhtml" media-type="application/xhtml+xml"/>
    <item id="volume-cover-nav" href="Text/part0002.xhtml" media-type="application/xhtml+xml"/>
    <item id="volume-cover-html-toc" href="Text/part0003.xhtml" media-type="application/xhtml+xml"/>
    <item id="untouched-linear-no" href="Text/part0004.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="cover" linear="no"/>
    <itemref idref="book-toc" linear="yes"/>
    <itemref idref="volume-cover-ncx" linear="no"/>
    <itemref idref="volume-cover-nav" linear="no"/>
    <itemref idref="volume-cover-html-toc" linear="no"/>
    <itemref idref="untouched-linear-no" linear="no"/>
  </spine>
  <guide>
    <reference type="toc" href="Text/part0000.xhtml"/>
    <reference type="cover" href="Text/cover_page.xhtml"/>
  </guide>
</package>"#,
        )
        .unwrap();
        fs::write(
            root.join("OEBPS/toc.ncx"),
            r#"<ncx><navMap>
  <navPoint id="toc"><content src="Text/part0000.xhtml"/></navPoint>
  <navPoint id="from-ncx"><content src="Text/part0001.xhtml"/></navPoint>
</navMap></ncx>"#,
        )
        .unwrap();
        fs::write(
            root.join("OEBPS/Text/nav.xhtml"),
            r#"<?xml version="1.0" encoding="utf-8"?><html><body>
<nav epub:type="landmarks"><ol><li><a href="cover_page.xhtml">Cover</a></li></ol></nav>
<nav epub:type="toc"><ol><li><a href="part0002.xhtml">Volume from nav</a></li></ol></nav>
</body></html>"#,
        )
        .unwrap();
        fs::write(
            root.join("OEBPS/Text/part0000.xhtml"),
            r#"<?xml version="1.0" encoding="utf-8"?><html><body>
<p><a href="part0003.xhtml">Volume from HTML TOC</a></p>
</body></html>"#,
        )
        .unwrap();
        for name in ["cover_page", "part0001", "part0002", "part0003", "part0004"] {
            fs::write(
                root.join(format!("OEBPS/Text/{name}.xhtml")),
                format!(r#"<html><body><h1>{name}</h1></body></html>"#),
            )
            .unwrap();
        }

        assert!(normalize_unpacked_epub_structure(&root).unwrap());

        let opf = fs::read_to_string(root.join("OEBPS/content.opf")).unwrap();
        assert!(opf.contains(r#"<itemref idref="volume-cover-ncx" linear="yes"/>"#));
        assert!(opf.contains(r#"<itemref idref="volume-cover-nav" linear="yes"/>"#));
        assert!(opf.contains(r#"<itemref idref="volume-cover-html-toc" linear="yes"/>"#));
        assert!(opf.contains(r#"<itemref idref="cover" linear="no"/>"#));
        assert!(opf.contains(r#"<itemref idref="untouched-linear-no" linear="no"/>"#));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replace_quoted_values_by_lookup_scans_text_once() {
        let replacements = HashMap::from([
            (
                "part0000.xhtml#nav_point_2".to_string(),
                "part0000-flow-split-0003.xhtml#nav_point_2".to_string(),
            ),
            (
                "#nav_point_7".to_string(),
                "part0000-flow-split-0008.xhtml#nav_point_7".to_string(),
            ),
        ]);

        let updated = replace_quoted_values_by_lookup(
            r#"<a href="part0000.xhtml#nav_point_2">two</a><a href='#nav_point_7'>seven</a><span title="keep">x</span>"#,
            &replacements,
        );

        assert_eq!(
            updated,
            r#"<a href="part0000-flow-split-0003.xhtml#nav_point_2">two</a><a href='part0000-flow-split-0008.xhtml#nav_point_7'>seven</a><span title="keep">x</span>"#
        );
    }

    #[test]
    fn collect_anchor_starts_scans_body_once() {
        let xhtml =
            r#"<html><body><p id="first">One</p><a name='second'></a><span id="first">Later</span></body></html>"#;
        let (body_start, body_end) = local_body_content_range(xhtml).unwrap();
        let anchors = collect_anchor_starts(xhtml, body_start, body_end).unwrap();

        assert_eq!(anchors.get("first"), Some(&xhtml.find(r#"<p id="first""#).unwrap()));
        assert_eq!(anchors.get("second"), Some(&xhtml.find(r#"<a name='second'"#).unwrap()));
    }

    #[test]
    fn find_cover_path_falls_back_to_image_manifest_id_prefix() {
        let doc = roxmltree::Document::parse(
            r#"<package>
  <manifest>
    <item id="cover.jpg" href="Images/obfuscated-image.jpg" media-type="image/jpeg"/>
  </manifest>
</package>"#,
        )
        .unwrap();

        assert_eq!(
            find_cover_path(&doc),
            Some(("Images/obfuscated-image.jpg".to_string(), "image/jpeg".to_string()))
        );
    }
}
