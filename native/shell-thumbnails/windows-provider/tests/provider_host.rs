#![cfg(windows)]

use std::{
    ffi::{CString, c_void},
    io::{Cursor, Write},
    mem::{MaybeUninit, size_of},
    os::windows::ffi::OsStrExt,
    path::PathBuf,
};

use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use windows::{
    Win32::{
        Foundation::{FreeLibrary, HMODULE, S_OK},
        Graphics::Gdi::{BITMAP, DeleteObject, GetObjectW, HBITMAP, HGDIOBJ},
        System::{
            Com::{IClassFactory, STGM_READ},
            LibraryLoader::{GetProcAddress, LoadLibraryW},
        },
        UI::Shell::{
            IThumbnailProvider, PropertiesSystem::IInitializeWithStream, SHCreateMemStream,
            WTS_ALPHATYPE, WTSAT_RGB,
        },
    },
    core::{GUID, HRESULT, Interface, PCSTR, PCWSTR},
};
use zip::{ZipWriter, write::SimpleFileOptions};

include!(concat!(env!("OUT_DIR"), "/provider_clsid.rs"));

type DllGetClassObject =
    unsafe extern "system" fn(*const GUID, *const GUID, *mut *mut c_void) -> HRESULT;
type DllCanUnloadNow = unsafe extern "system" fn() -> HRESULT;

struct LoadedProvider(HMODULE);

impl LoadedProvider {
    fn load() -> Self {
        let dll_path = provider_dll_path();
        let wide_path = dll_path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let module = unsafe { LoadLibraryW(PCWSTR(wide_path.as_ptr())) }
            .unwrap_or_else(|error| panic!("failed to load {}: {error}", dll_path.display()));
        Self(module)
    }

    fn procedure<T>(&self, name: &str) -> T
    where
        T: Copy,
    {
        let name = CString::new(name).unwrap();
        let address = unsafe { GetProcAddress(self.0, PCSTR(name.as_ptr().cast())) }
            .unwrap_or_else(|| panic!("missing export {name:?}"));
        assert_eq!(size_of::<T>(), size_of_val(&address));
        unsafe { std::mem::transmute_copy(&address) }
    }
}

impl Drop for LoadedProvider {
    fn drop(&mut self) {
        unsafe {
            FreeLibrary(self.0).unwrap();
        }
    }
}

#[test]
fn exported_provider_renders_requested_dib_sizes_from_an_epub_stream() {
    let library = LoadedProvider::load();
    let get_class_object = library.procedure::<DllGetClassObject>("DllGetClassObject");
    let can_unload = library.procedure::<DllCanUnloadNow>("DllCanUnloadNow");
    let epub = synthetic_epub();

    for requested_edge in [96, 256, 1024] {
        let mut factory = std::ptr::null_mut();
        unsafe {
            get_class_object(&PROVIDER_CLSID, &IClassFactory::IID, &mut factory)
                .ok()
                .unwrap();
        }
        let factory = unsafe { IClassFactory::from_raw(factory) };
        let provider: IThumbnailProvider = unsafe { factory.CreateInstance(None) }.unwrap();
        let initializer = provider.cast::<IInitializeWithStream>().unwrap();
        let stream = unsafe { SHCreateMemStream(Some(&epub)) }.unwrap();
        unsafe {
            initializer.Initialize(&stream, STGM_READ.0).unwrap();
        }

        let mut bitmap = HBITMAP::default();
        let mut alpha = WTS_ALPHATYPE::default();
        unsafe {
            provider
                .GetThumbnail(requested_edge, &mut bitmap, &mut alpha)
                .unwrap();
        }
        assert_eq!(alpha, WTSAT_RGB);

        let mut details = MaybeUninit::<BITMAP>::zeroed();
        let copied = unsafe {
            GetObjectW(
                HGDIOBJ(bitmap.0),
                size_of::<BITMAP>() as i32,
                Some(details.as_mut_ptr().cast()),
            )
        };
        assert_eq!(copied, size_of::<BITMAP>() as i32);
        let details = unsafe { details.assume_init() };
        assert_eq!(
            details.bmWidth,
            i32::try_from(requested_edge * 3 / 4).unwrap()
        );
        assert_eq!(details.bmHeight, i32::try_from(requested_edge).unwrap());
        assert_eq!(details.bmBitsPixel, 32);
        assert!(!details.bmBits.is_null());

        let byte_length = usize::try_from(details.bmWidth).unwrap()
            * usize::try_from(details.bmHeight).unwrap()
            * 4;
        let bytes = unsafe { std::slice::from_raw_parts(details.bmBits.cast::<u8>(), byte_length) };
        assert!(
            bytes
                .as_chunks::<4>()
                .0
                .iter()
                .any(|pixel| pixel != &bytes[..4])
        );
        assert!(unsafe { DeleteObject(HGDIOBJ(bitmap.0)) }.as_bool());
    }

    assert_eq!(unsafe { can_unload() }, S_OK);
}

fn provider_dll_path() -> PathBuf {
    let executable = std::env::current_exe().unwrap();
    executable
        .parent()
        .and_then(|deps| deps.parent())
        .unwrap()
        .join("flow_reader_thumbnail.dll")
}

fn synthetic_epub() -> Vec<u8> {
    let mut png = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(RgbaImage::from_fn(768, 1024, |x, y| {
        Rgba([(x % 256) as u8, (y % 256) as u8, 120, 255])
    }))
    .write_to(&mut png, ImageFormat::Png)
    .unwrap();
    let container =
        r#"<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>"#;
    let package = r#"<package xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata><dc:title>Shell thumbnail</dc:title><dc:creator>Flow Reader</dc:creator></metadata>
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
