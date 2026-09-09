use super::SystemFont;

pub fn list() -> Vec<SystemFont> {
    let mut families = platform::families();
    families.retain(|family| !family.trim().is_empty());
    families.sort();
    families.dedup();
    families
        .into_iter()
        .map(|family| SystemFont {
            label: family.clone(),
            family,
        })
        .collect()
}

#[cfg(target_os = "windows")]
mod platform {
    use windows_sys::Win32::Graphics::Gdi::{
        DEFAULT_CHARSET, EnumFontFamiliesExW, GetDC, LOGFONTW, ReleaseDC, TEXTMETRICW,
    };

    pub fn families() -> Vec<String> {
        let mut names = Vec::new();
        // Enumeration is synchronous; the callback borrows names only during this call.
        unsafe {
            let dc = GetDC(std::ptr::null_mut());
            if dc.is_null() {
                return names;
            }
            let font = LOGFONTW {
                lfCharSet: DEFAULT_CHARSET,
                ..std::mem::zeroed()
            };
            EnumFontFamiliesExW(dc, &font, Some(collect), &mut names as *mut Vec<String> as isize, 0);
            ReleaseDC(std::ptr::null_mut(), dc);
        }
        names
    }

    unsafe extern "system" fn collect(font: *const LOGFONTW, _: *const TEXTMETRICW, _: u32, context: isize) -> i32 {
        // GDI supplies a valid LOGFONTW and the context passed by families.
        let (font, names) = unsafe { (&*font, &mut *(context as *mut Vec<String>)) };
        let length = font
            .lfFaceName
            .iter()
            .position(|ch| *ch == 0)
            .unwrap_or(font.lfFaceName.len());
        let name = String::from_utf16_lossy(&font.lfFaceName[..length]);
        // @ names are vertical aliases, not separate CSS font families.
        if !name.starts_with('@') {
            names.push(name);
        }
        1
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{CStr, c_char, c_void};

    #[link(name = "CoreText", kind = "framework")]
    unsafe extern "C" {
        fn CTFontManagerCopyAvailableFontFamilyNames() -> *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
        fn CFStringGetLength(string: *const c_void) -> isize;
        fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
        fn CFStringGetCString(string: *const c_void, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
        fn CFRelease(value: *const c_void);
    }

    pub fn families() -> Vec<String> {
        const UTF8: u32 = 0x08000100;
        let mut names = Vec::new();
        // The copied array owns its CFStrings; release it after copying their UTF-8 names.
        unsafe {
            let array = CTFontManagerCopyAvailableFontFamilyNames();
            if array.is_null() {
                return names;
            }
            for index in 0..CFArrayGetCount(array) {
                let string = CFArrayGetValueAtIndex(array, index);
                let size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(string), UTF8);
                if size < 0 || size == isize::MAX {
                    continue;
                }
                let mut buffer = vec![0u8; size as usize + 1];
                if CFStringGetCString(string, buffer.as_mut_ptr().cast(), buffer.len() as isize, UTF8) != 0 {
                    names.push(CStr::from_ptr(buffer.as_ptr().cast()).to_string_lossy().into_owned());
                }
            }
            CFRelease(array);
        }
        names
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::ffi::{CStr, c_char, c_int, c_void};

    #[repr(C)]
    struct FontSet {
        count: c_int,
        capacity: c_int,
        fonts: *mut *mut c_void,
    }

    #[link(name = "fontconfig")]
    unsafe extern "C" {
        fn FcPatternCreate() -> *mut c_void;
        fn FcPatternDestroy(pattern: *mut c_void);
        fn FcObjectSetCreate() -> *mut c_void;
        fn FcObjectSetAdd(set: *mut c_void, object: *const c_char) -> c_int;
        fn FcObjectSetDestroy(set: *mut c_void);
        fn FcFontList(config: *mut c_void, pattern: *mut c_void, objects: *mut c_void) -> *mut FontSet;
        fn FcFontSetDestroy(set: *mut FontSet);
        fn FcPatternGetString(pattern: *mut c_void, object: *const c_char, index: c_int, value: *mut *mut u8) -> c_int;
    }

    pub fn families() -> Vec<String> {
        let mut names = Vec::new();
        // A null config uses Fontconfig's system configuration. All owned objects
        // are released here; font strings remain borrowed until the set is destroyed.
        unsafe {
            let pattern = FcPatternCreate();
            if pattern.is_null() {
                return names;
            }
            let objects = FcObjectSetCreate();
            if objects.is_null() {
                FcPatternDestroy(pattern);
                return names;
            }
            if FcObjectSetAdd(objects, c"family".as_ptr()) != 0 {
                let set = FcFontList(std::ptr::null_mut(), pattern, objects);
                if !set.is_null() {
                    for index in 0..(*set).count {
                        let font = *(*set).fonts.add(index as usize);
                        let mut value = std::ptr::null_mut();
                        if FcPatternGetString(font, c"family".as_ptr(), 0, &mut value) == 0 && !value.is_null() {
                            names.push(CStr::from_ptr(value.cast()).to_string_lossy().into_owned());
                        }
                    }
                    FcFontSetDestroy(set);
                }
            }
            FcObjectSetDestroy(objects);
            FcPatternDestroy(pattern);
        }
        names
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform {
    pub fn families() -> Vec<String> {
        Vec::new()
    }
}
