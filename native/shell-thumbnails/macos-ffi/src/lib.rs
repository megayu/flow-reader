use std::{
    ffi::c_uchar,
    fs::File,
    panic::{AssertUnwindSafe, catch_unwind},
    path::Path,
};

use flow_epub_thumbnail::{ThumbnailRequest, render_epub_thumbnail};

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct FlowThumbnailRequest {
    pub max_width: u32,
    pub max_height: u32,
    pub scale: f32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct FlowThumbnailOutput {
    pub pixels: *mut c_uchar,
    pub len: usize,
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub has_alpha: u8,
}

impl Default for FlowThumbnailOutput {
    fn default() -> Self {
        Self {
            pixels: std::ptr::null_mut(),
            len: 0,
            width: 0,
            height: 0,
            stride: 0,
            has_alpha: 0,
        }
    }
}

#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowThumbnailStatus {
    Ok = 0,
    InvalidArgument = 1,
    RenderError = 2,
    Panic = 3,
}

/// Returns a static UTF-8 description for a thumbnail status code.
///
/// # Safety
///
/// `message_len` must be null or point to writable storage for one `usize`. The returned bytes
/// have static lifetime and must not be freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn flow_thumbnail_status_message(
    status: i32,
    message_len: *mut usize,
) -> *const c_uchar {
    let message: &'static [u8] = match status {
        0 => b"thumbnail rendered successfully",
        1 => b"invalid thumbnail request",
        2 => b"could not render the EPUB thumbnail",
        3 => b"thumbnail renderer panicked",
        _ => b"unknown thumbnail status",
    };
    if let Some(message_len) = unsafe { message_len.as_mut() } {
        *message_len = message.len();
    }
    message.as_ptr()
}

/// Renders an EPUB thumbnail and transfers ownership of its RGBA buffer to the caller.
///
/// # Safety
///
/// `path` must reference `path_len` readable UTF-8 bytes for the duration of this call, and
/// `output` must point to writable storage for one [`FlowThumbnailOutput`]. A successful output
/// must be released exactly once with [`flow_thumbnail_free`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn flow_thumbnail_render_file(
    path: *const c_uchar,
    path_len: usize,
    request: FlowThumbnailRequest,
    output: *mut FlowThumbnailOutput,
) -> FlowThumbnailStatus {
    if output.is_null() {
        return FlowThumbnailStatus::InvalidArgument;
    }
    unsafe {
        *output = FlowThumbnailOutput::default();
    }

    match catch_unwind(AssertUnwindSafe(|| unsafe {
        render_file(path, path_len, request, output)
    })) {
        Ok(status) => status,
        Err(_) => FlowThumbnailStatus::Panic,
    }
}

unsafe fn render_file(
    path: *const c_uchar,
    path_len: usize,
    request: FlowThumbnailRequest,
    output: *mut FlowThumbnailOutput,
) -> FlowThumbnailStatus {
    if path.is_null()
        || path_len == 0
        || request.max_width == 0
        || request.max_height == 0
        || !request.scale.is_finite()
        || request.scale <= 0.0
    {
        return FlowThumbnailStatus::InvalidArgument;
    }
    let path_bytes = unsafe { std::slice::from_raw_parts(path, path_len) };
    let Ok(path_text) = std::str::from_utf8(path_bytes) else {
        return FlowThumbnailStatus::InvalidArgument;
    };
    let path = Path::new(path_text);
    let Ok(file) = File::open(path) else {
        return FlowThumbnailStatus::RenderError;
    };
    let Ok(thumbnail) = render_epub_thumbnail(
        file,
        ThumbnailRequest {
            max_width: request.max_width,
            max_height: request.max_height,
            scale: request.scale,
        },
    ) else {
        return FlowThumbnailStatus::RenderError;
    };

    let pixels = thumbnail.pixels.into_boxed_slice();
    let len = pixels.len();
    let pixels = Box::into_raw(pixels).cast::<c_uchar>();
    unsafe {
        *output = FlowThumbnailOutput {
            pixels,
            len,
            width: thumbnail.width,
            height: thumbnail.height,
            stride: thumbnail.stride,
            has_alpha: u8::from(thumbnail.has_alpha),
        };
    }
    FlowThumbnailStatus::Ok
}

/// Releases a pixel buffer returned by [`flow_thumbnail_render_file`] and zeros the output.
///
/// # Safety
///
/// `output` must be null or point to a value last initialized by this library. It must not have
/// been freed previously or modified by the caller.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn flow_thumbnail_free(output: *mut FlowThumbnailOutput) {
    let Some(output) = (unsafe { output.as_mut() }) else {
        return;
    };
    let pixels = output.pixels;
    let len = output.len;
    *output = FlowThumbnailOutput::default();
    if !pixels.is_null() && len != 0 {
        let slice = std::ptr::slice_from_raw_parts_mut(pixels, len);
        unsafe {
            drop(Box::from_raw(slice));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Cursor, Write},
        path::PathBuf,
    };

    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
    use zip::{ZipWriter, write::SimpleFileOptions};

    use super::{
        FlowThumbnailOutput, FlowThumbnailRequest, FlowThumbnailStatus, flow_thumbnail_free,
        flow_thumbnail_render_file,
    };

    struct TemporaryEpub(PathBuf);

    impl Drop for TemporaryEpub {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[test]
    fn render_and_free_transfer_pixel_ownership_across_the_c_abi() {
        let path =
            std::env::temp_dir().join(format!("flow-thumbnail-ffi-{}.epub", std::process::id()));
        std::fs::write(&path, synthetic_epub()).unwrap();
        let temporary_epub = TemporaryEpub(path);
        let path = temporary_epub.0.to_string_lossy();
        let mut output = FlowThumbnailOutput::default();

        let status = unsafe {
            flow_thumbnail_render_file(
                path.as_bytes().as_ptr(),
                path.len(),
                FlowThumbnailRequest {
                    max_width: 300,
                    max_height: 400,
                    scale: 1.0,
                },
                &mut output,
            )
        };

        assert_eq!(status, FlowThumbnailStatus::Ok);
        assert_eq!((output.width, output.height), (300, 400));
        assert_eq!(output.stride, 300 * 4);
        assert_eq!(output.len, 300 * 400 * 4);
        assert!(!output.pixels.is_null());
        let pixels = unsafe { std::slice::from_raw_parts(output.pixels, output.len) };
        assert!(pixels.iter().any(|value| *value != 0));

        unsafe {
            flow_thumbnail_free(&mut output);
        }
        assert!(output.pixels.is_null());
        assert_eq!(output.len, 0);
        assert_eq!((output.width, output.height), (0, 0));
    }

    fn synthetic_epub() -> Vec<u8> {
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(300, 400, Rgba([40, 80, 120, 255])))
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        let container =
            r#"<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>"#;
        let package = r#"<package xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata><dc:title>FFI ownership</dc:title><dc:creator>Flow Reader</dc:creator></metadata>
  <manifest><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/></manifest>
</package>"#;
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
        archive.finish().unwrap().into_inner()
    }
}
