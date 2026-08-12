use crate::{CoverError, path};

pub(crate) fn package_path(container_xml: &str) -> Result<String, CoverError> {
    let document = parse_xml(container_xml, "META-INF/container.xml")?;
    let full_path = document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "rootfile")
        .and_then(|node| node.attribute("full-path"))
        .ok_or_else(|| CoverError::InvalidEpub("container has no rootfile".to_string()))?;
    path::resolve_href("", full_path)
}

pub(crate) fn parse_xml<'a>(
    xml: &'a str,
    entry: &str,
) -> Result<roxmltree::Document<'a>, CoverError> {
    roxmltree::Document::parse_with_options(
        xml,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            ..roxmltree::ParsingOptions::default()
        },
    )
    .map_err(|error| CoverError::InvalidXml {
        entry: entry.to_string(),
        message: error.to_string(),
    })
}
