use image::{DynamicImage, GenericImageView, imageops::FilterType};

use crate::{RgbaThumbnail, ThumbnailError, ThumbnailRequest};

pub(crate) const MAX_DECODED_PIXELS: u64 = 24_000_000;
const MIN_REQUEST_EDGE: u32 = 16;
const MAX_REQUEST_EDGE: u32 = 4096;

pub(crate) fn validate_source_dimensions(width: u32, height: u32) -> Result<(), ThumbnailError> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or(ThumbnailError::DimensionOverflow)?;
    if width == 0 || height == 0 || pixels > MAX_DECODED_PIXELS {
        return Err(ThumbnailError::PixelLimit {
            width,
            height,
            max_pixels: MAX_DECODED_PIXELS,
        });
    }
    Ok(())
}

pub(crate) fn render_rgba(
    image: DynamicImage,
    request: ThumbnailRequest,
) -> Result<RgbaThumbnail, ThumbnailError> {
    let (source_width, source_height) = image.dimensions();
    let (width, height) = requested_dimensions(source_width, source_height, request)?;

    let image = if (width, height) == (source_width, source_height) {
        image
    } else {
        image.resize_exact(width, height, FilterType::Lanczos3)
    };
    thumbnail_from_rgba(image.into_rgba8().into_raw(), width, height)
}

pub(crate) fn thumbnail_from_rgba(
    pixels: Vec<u8>,
    width: u32,
    height: u32,
) -> Result<RgbaThumbnail, ThumbnailError> {
    let stride = usize::try_from(width)
        .ok()
        .and_then(|width| width.checked_mul(4))
        .ok_or(ThumbnailError::DimensionOverflow)?;
    let expected_length = stride
        .checked_mul(usize::try_from(height).map_err(|_| ThumbnailError::DimensionOverflow)?)
        .ok_or(ThumbnailError::DimensionOverflow)?;
    if pixels.len() != expected_length {
        return Err(ThumbnailError::DimensionOverflow);
    }
    let has_alpha = pixels
        .as_chunks::<4>()
        .0
        .iter()
        .any(|pixel| pixel[3] != 255);

    Ok(RgbaThumbnail {
        pixels,
        width,
        height,
        stride,
        has_alpha,
    })
}

pub(crate) fn requested_dimensions(
    source_width: u32,
    source_height: u32,
    request: ThumbnailRequest,
) -> Result<(u32, u32), ThumbnailError> {
    validate_source_dimensions(source_width, source_height)?;
    let (max_width, max_height) = pixel_bounds(request)?;
    aspect_fit(source_width, source_height, max_width, max_height)
}

fn pixel_bounds(request: ThumbnailRequest) -> Result<(u32, u32), ThumbnailError> {
    if request.max_width == 0 || request.max_height == 0 {
        return Err(ThumbnailError::InvalidRequest(
            "width and height must be positive".to_string(),
        ));
    }
    if !request.scale.is_finite() || request.scale <= 0.0 {
        return Err(ThumbnailError::InvalidRequest(
            "scale must be finite and positive".to_string(),
        ));
    }

    let width = scaled_edge(request.max_width, request.scale);
    let height = scaled_edge(request.max_height, request.scale);
    Ok((width, height))
}

fn scaled_edge(edge: u32, scale: f32) -> u32 {
    (f64::from(edge) * f64::from(scale))
        .round()
        .clamp(f64::from(MIN_REQUEST_EDGE), f64::from(MAX_REQUEST_EDGE)) as u32
}

fn aspect_fit(
    source_width: u32,
    source_height: u32,
    max_width: u32,
    max_height: u32,
) -> Result<(u32, u32), ThumbnailError> {
    if source_width <= max_width && source_height <= max_height {
        return Ok((source_width, source_height));
    }

    let source_width = u64::from(source_width);
    let source_height = u64::from(source_height);
    let max_width = u64::from(max_width);
    let max_height = u64::from(max_height);
    let (width, height) = if source_width * max_height >= source_height * max_width {
        let height = source_height
            .checked_mul(max_width)
            .and_then(|value| value.checked_add(source_width / 2))
            .ok_or(ThumbnailError::DimensionOverflow)?
            / source_width;
        (max_width, height.max(1))
    } else {
        let width = source_width
            .checked_mul(max_height)
            .and_then(|value| value.checked_add(source_height / 2))
            .ok_or(ThumbnailError::DimensionOverflow)?
            / source_height;
        (width.max(1), max_height)
    };

    Ok((
        u32::try_from(width).map_err(|_| ThumbnailError::DimensionOverflow)?,
        u32::try_from(height).map_err(|_| ThumbnailError::DimensionOverflow)?,
    ))
}
