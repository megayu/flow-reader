use std::{
    cell::RefCell,
    io::{Seek, SeekFrom},
    panic::{AssertUnwindSafe, catch_unwind},
};

use flow_epub_thumbnail::{ThumbnailRequest, render_epub_thumbnail};
use windows::{
    Win32::{
        Foundation::{E_FAIL, E_INVALIDARG, E_POINTER, E_UNEXPECTED, ERROR_ALREADY_INITIALIZED},
        Graphics::Gdi::HBITMAP,
        System::Com::IStream,
        UI::Shell::{
            IThumbnailProvider, IThumbnailProvider_Impl, PropertiesSystem::IInitializeWithStream,
            PropertiesSystem::IInitializeWithStream_Impl, WTS_ALPHATYPE, WTSAT_ARGB, WTSAT_RGB,
            WTSAT_UNKNOWN,
        },
    },
    core::{Error, HRESULT, Ref, Result, implement},
};

use crate::{bitmap::DibSection, module_state, stream::StreamReader};

#[implement(IThumbnailProvider, IInitializeWithStream)]
pub(crate) struct ThumbnailProvider {
    stream: RefCell<Option<IStream>>,
}

impl ThumbnailProvider {
    pub(crate) fn new() -> Self {
        module_state::add_object();
        Self {
            stream: RefCell::new(None),
        }
    }

    fn render(&self, requested_edge: u32) -> Result<(DibSection, WTS_ALPHATYPE)> {
        if requested_edge == 0 {
            return Err(Error::from_hresult(E_INVALIDARG));
        }
        let stream = self
            .stream
            .try_borrow()
            .map_err(|_| Error::from_hresult(E_UNEXPECTED))?
            .clone()
            .ok_or_else(|| Error::from_hresult(E_UNEXPECTED))?;
        let mut reader = StreamReader::new(&stream);
        reader
            .seek(SeekFrom::Start(0))
            .map_err(|_| Error::from_hresult(E_FAIL))?;
        let thumbnail = render_epub_thumbnail(
            &mut reader,
            ThumbnailRequest {
                max_width: requested_edge,
                max_height: requested_edge,
                scale: 1.0,
            },
        )
        .map_err(|_| Error::from_hresult(E_FAIL))?;
        let alpha = if thumbnail.has_alpha {
            WTSAT_ARGB
        } else {
            WTSAT_RGB
        };
        Ok((DibSection::from_rgba(&thumbnail)?, alpha))
    }
}

impl Drop for ThumbnailProvider {
    fn drop(&mut self) {
        module_state::remove_object();
    }
}

#[allow(non_snake_case)]
impl IInitializeWithStream_Impl for ThumbnailProvider_Impl {
    fn Initialize(&self, stream: Ref<IStream>, _mode: u32) -> Result<()> {
        let stream = stream
            .cloned()
            .ok_or_else(|| Error::from_hresult(E_POINTER))?;
        let mut current = self
            .stream
            .try_borrow_mut()
            .map_err(|_| Error::from_hresult(E_UNEXPECTED))?;
        if current.is_some() {
            return Err(Error::from_hresult(HRESULT::from_win32(
                ERROR_ALREADY_INITIALIZED.0,
            )));
        }
        *current = Some(stream);
        Ok(())
    }
}

#[allow(non_snake_case)]
impl IThumbnailProvider_Impl for ThumbnailProvider_Impl {
    fn GetThumbnail(
        &self,
        requested_edge: u32,
        bitmap: *mut HBITMAP,
        alpha: *mut WTS_ALPHATYPE,
    ) -> Result<()> {
        if bitmap.is_null() || alpha.is_null() {
            return Err(Error::from_hresult(E_POINTER));
        }
        unsafe {
            *bitmap = HBITMAP::default();
            *alpha = WTSAT_UNKNOWN;
        }

        let rendered = catch_unwind(AssertUnwindSafe(|| self.render(requested_edge)))
            .map_err(|_| Error::from_hresult(E_UNEXPECTED))??;
        let (dib, alpha_type) = rendered;
        let raw_bitmap = dib.into_raw();
        unsafe {
            *bitmap = raw_bitmap;
            *alpha = alpha_type;
        }
        Ok(())
    }
}
