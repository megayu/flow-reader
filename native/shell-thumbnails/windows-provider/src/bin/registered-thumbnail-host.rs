#[cfg(windows)]
mod host {
    use std::{env, error::Error, fs, mem::MaybeUninit, path::PathBuf};

    use windows::{
        Win32::{
            Graphics::Gdi::{BITMAP, DeleteObject, GetObjectW, HBITMAP, HGDIOBJ},
            System::Com::{
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
                CoUninitialize, STGM_READ,
            },
            UI::Shell::{
                IThumbnailProvider, PropertiesSystem::IInitializeWithStream, SHCreateMemStream,
                WTS_ALPHATYPE, WTSAT_RGB,
            },
        },
        core::Interface,
    };

    include!(concat!(env!("OUT_DIR"), "/provider_clsid.rs"));

    struct ComApartment;

    impl ComApartment {
        fn initialize() -> windows::core::Result<Self> {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };
            Ok(Self)
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    struct OwnedBitmap(HBITMAP);

    impl Drop for OwnedBitmap {
        fn drop(&mut self) {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(self.0.0));
            }
        }
    }

    pub fn run() -> Result<(), Box<dyn Error>> {
        let (epub_path, requested_edge) = arguments()?;
        let epub = fs::read(&epub_path)?;
        let _apartment = ComApartment::initialize()?;
        let provider: IThumbnailProvider =
            unsafe { CoCreateInstance(&PROVIDER_CLSID, None, CLSCTX_INPROC_SERVER)? };
        let initializer = provider.cast::<IInitializeWithStream>()?;
        let stream = unsafe { SHCreateMemStream(Some(&epub)) }
            .ok_or("Windows could not create the EPUB memory stream")?;
        unsafe { initializer.Initialize(&stream, STGM_READ.0)? };

        let mut bitmap = HBITMAP::default();
        let mut alpha = WTS_ALPHATYPE::default();
        unsafe { provider.GetThumbnail(requested_edge, &mut bitmap, &mut alpha)? };
        let bitmap = OwnedBitmap(bitmap);
        if alpha != WTSAT_RGB {
            return Err(format!("provider returned unexpected alpha type: {alpha:?}").into());
        }

        let mut details = MaybeUninit::<BITMAP>::zeroed();
        let copied = unsafe {
            GetObjectW(
                HGDIOBJ(bitmap.0.0),
                size_of::<BITMAP>() as i32,
                Some(details.as_mut_ptr().cast()),
            )
        };
        if copied != size_of::<BITMAP>() as i32 {
            return Err("provider returned an unreadable bitmap".into());
        }
        let details = unsafe { details.assume_init() };
        let expected_width = i32::try_from(requested_edge * 3 / 4)?;
        let expected_height = i32::try_from(requested_edge)?;
        if details.bmWidth != expected_width
            || details.bmHeight != expected_height
            || details.bmBitsPixel != 32
            || details.bmBits.is_null()
        {
            return Err(format!(
                "unexpected bitmap: {}x{}, {} bpp",
                details.bmWidth, details.bmHeight, details.bmBitsPixel
            )
            .into());
        }

        let byte_length = usize::try_from(details.bmWidthBytes)?
            .checked_mul(usize::try_from(details.bmHeight)?)
            .ok_or("bitmap byte length overflowed")?;
        let bytes = unsafe { std::slice::from_raw_parts(details.bmBits.cast::<u8>(), byte_length) };
        let first_pixel = bytes.get(..4).ok_or("bitmap contains no pixels")?;
        if !bytes.chunks_exact(4).any(|pixel| pixel != first_pixel) {
            return Err("provider returned a uniform placeholder bitmap".into());
        }

        println!(
            "registered provider rendered {} as {}x{} BGRA pixels",
            epub_path.display(),
            details.bmWidth,
            details.bmHeight
        );
        Ok(())
    }

    fn arguments() -> Result<(PathBuf, u32), Box<dyn Error>> {
        let mut arguments = env::args_os().skip(1);
        let epub_path = arguments
            .next()
            .map(PathBuf::from)
            .ok_or("usage: registered-thumbnail-host <epub-path> <requested-edge>")?;
        let requested_edge = arguments
            .next()
            .ok_or("usage: registered-thumbnail-host <epub-path> <requested-edge>")?
            .to_string_lossy()
            .parse::<u32>()?;
        if arguments.next().is_some() || requested_edge == 0 {
            return Err("usage: registered-thumbnail-host <epub-path> <requested-edge>".into());
        }
        Ok((epub_path, requested_edge))
    }
}

#[cfg(windows)]
fn main() {
    if let Err(error) = host::run() {
        eprintln!("registered thumbnail request failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("registered-thumbnail-host is only available on Windows");
    std::process::exit(1);
}
