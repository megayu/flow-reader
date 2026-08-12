mod decode;
mod error;
mod resize;

use std::io::{Read, Seek};

pub use error::ThumbnailError;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThumbnailRequest {
    pub max_width: u32,
    pub max_height: u32,
    pub scale: f32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RgbaThumbnail {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub has_alpha: bool,
}

pub fn render_epub_thumbnail<R: Read + Seek>(
    source: R,
    request: ThumbnailRequest,
) -> Result<RgbaThumbnail, ThumbnailError> {
    let inspection = flow_epub_cover::inspect_epub_cover(source)?;
    let cover = inspection.cover.ok_or(ThumbnailError::MissingCover)?;
    decode::raster_cover(&cover).and_then(|image| resize::render_rgba(image, request))
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
    use zip::{ZipWriter, write::SimpleFileOptions};

    use super::{ThumbnailError, ThumbnailRequest, render_epub_thumbnail};

    #[test]
    fn raster_cover_is_aspect_fit_to_requested_pixel_bounds() {
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(32, 16, Rgba([40, 80, 120, 255])))
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        let container =
            r#"<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>"#;
        let package = r#"<package><manifest>
  <item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>
</manifest></package>"#;

        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        archive
            .start_file("META-INF/container.xml", options)
            .unwrap();
        archive.write_all(container.as_bytes()).unwrap();
        archive.start_file("package.opf", options).unwrap();
        archive.write_all(package.as_bytes()).unwrap();
        archive.start_file("cover.png", options).unwrap();
        archive.write_all(png.get_ref()).unwrap();
        let source = archive.finish().unwrap().into_inner();

        let thumbnail = render_epub_thumbnail(
            Cursor::new(source),
            ThumbnailRequest {
                max_width: 16,
                max_height: 16,
                scale: 1.0,
            },
        )
        .unwrap();

        assert_eq!((thumbnail.width, thumbnail.height), (16, 8));
        assert_eq!(thumbnail.stride, 16 * 4);
        assert_eq!(thumbnail.pixels.len(), 16 * 8 * 4);
        assert!(thumbnail.pixels.iter().any(|value| *value != 0));
    }

    #[test]
    fn svg_and_missing_cover_are_not_rendered() {
        let container =
            r#"<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>"#;
        let package = r#"<package><manifest>
  <item id="cover" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>
</manifest></package>"#;
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16" viewBox="0 0 32 16">
  <rect width="32" height="16" fill="#285078"/>
</svg>"##;

        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        archive
            .start_file("META-INF/container.xml", options)
            .unwrap();
        archive.write_all(container.as_bytes()).unwrap();
        archive.start_file("package.opf", options).unwrap();
        archive.write_all(package.as_bytes()).unwrap();
        archive.start_file("cover.svg", options).unwrap();
        archive.write_all(svg.as_bytes()).unwrap();
        let source = archive.finish().unwrap().into_inner();

        let svg_error = render_epub_thumbnail(
            Cursor::new(source),
            ThumbnailRequest {
                max_width: 16,
                max_height: 16,
                scale: 1.0,
            },
        )
        .unwrap_err();
        assert!(matches!(svg_error, ThumbnailError::UnsupportedFormat));

        let container =
            r#"<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>"#;
        let package = r#"<package><manifest/></package>"#;

        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        archive
            .start_file("META-INF/container.xml", options)
            .unwrap();
        archive.write_all(container.as_bytes()).unwrap();
        archive.start_file("package.opf", options).unwrap();
        archive.write_all(package.as_bytes()).unwrap();
        let source = archive.finish().unwrap().into_inner();

        let missing_cover_error = render_epub_thumbnail(
            Cursor::new(source),
            ThumbnailRequest {
                max_width: 300,
                max_height: 400,
                scale: 1.0,
            },
        )
        .unwrap_err();
        assert!(matches!(missing_cover_error, ThumbnailError::MissingCover));
    }
}
