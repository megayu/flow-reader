use std::{ffi::c_void, mem::size_of, ptr::copy_nonoverlapping};

use flow_epub_thumbnail::RgbaThumbnail;
use windows::Win32::{
    Foundation::{E_FAIL, E_INVALIDARG},
    Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateDIBSection, DIB_RGB_COLORS, DeleteObject,
        HBITMAP, HGDIOBJ,
    },
};

pub(crate) struct DibSection {
    bitmap: Option<HBITMAP>,
}

impl DibSection {
    pub(crate) fn from_rgba(thumbnail: &RgbaThumbnail) -> windows::core::Result<Self> {
        let expected_length = usize::try_from(thumbnail.width)
            .ok()
            .and_then(|width| {
                usize::try_from(thumbnail.height)
                    .ok()
                    .and_then(|height| width.checked_mul(height))
            })
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| windows::core::Error::from_hresult(E_INVALIDARG))?;
        if thumbnail.pixels.len() != expected_length {
            return Err(windows::core::Error::from_hresult(E_INVALIDARG));
        }
        let width = i32::try_from(thumbnail.width)
            .map_err(|_| windows::core::Error::from_hresult(E_INVALIDARG))?;
        let height = i32::try_from(thumbnail.height)
            .map_err(|_| windows::core::Error::from_hresult(E_INVALIDARG))?;
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut destination: *mut c_void = std::ptr::null_mut();
        let bitmap =
            unsafe { CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut destination, None, 0) }?;
        if destination.is_null() {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
            }
            return Err(windows::core::Error::from_hresult(E_FAIL));
        }

        let destination = destination.cast::<u8>();
        for (index, rgba) in thumbnail.pixels.chunks_exact(4).enumerate() {
            let bgra = [rgba[2], rgba[1], rgba[0], rgba[3]];
            unsafe {
                copy_nonoverlapping(bgra.as_ptr(), destination.add(index * 4), 4);
            }
        }
        Ok(Self {
            bitmap: Some(bitmap),
        })
    }

    pub(crate) fn into_raw(mut self) -> HBITMAP {
        self.bitmap.take().expect("DIB section owns a bitmap")
    }
}

impl Drop for DibSection {
    fn drop(&mut self) {
        if let Some(bitmap) = self.bitmap.take() {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
            }
        }
    }
}
