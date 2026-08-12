use std::io::Cursor;

use flow_epub_cover::CoverAsset;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};

use crate::{ThumbnailError, resize::validate_source_dimensions};

pub(crate) fn raster_cover(cover: &CoverAsset) -> Result<DynamicImage, ThumbnailError> {
    let reader = ImageReader::new(Cursor::new(cover.bytes.as_slice())).with_guessed_format()?;
    let format = reader.format().ok_or(ThumbnailError::UnsupportedFormat)?;
    if !matches!(
        format,
        ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::Gif | ImageFormat::WebP
    ) {
        return Err(ThumbnailError::UnsupportedFormat);
    }

    let mut decoder = reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    validate_source_dimensions(width, height)?;
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    Ok(image)
}
