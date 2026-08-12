#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpubCoverInspection {
    pub opf_xml: String,
    pub cover: Option<CoverAsset>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoverAsset {
    pub bytes: Vec<u8>,
    pub media_type: String,
    pub extension: String,
    pub archive_path: String,
}
