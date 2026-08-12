use thiserror::Error;

#[derive(Debug, Error)]
pub enum ThumbnailError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Cover(#[from] flow_epub_cover::CoverError),
    #[error(transparent)]
    Image(#[from] image::ImageError),
    #[error("EPUB has no cover image")]
    MissingCover,
    #[error("unsupported cover image format")]
    UnsupportedFormat,
    #[error("invalid thumbnail request: {0}")]
    InvalidRequest(String),
    #[error("cover image exceeds the {max_pixels} pixel limit: {width}x{height}")]
    PixelLimit {
        width: u32,
        height: u32,
        max_pixels: u64,
    },
    #[error("thumbnail dimensions overflow the supported range")]
    DimensionOverflow,
}
