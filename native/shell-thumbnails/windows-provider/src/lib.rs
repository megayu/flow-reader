#![cfg(windows)]
#![allow(
    linker_messages,
    reason = "MSVC emits LNK4104 for the two conventional COM exports in rustc's generated DEF"
)]

mod bitmap;
mod class_factory;
mod ids;
mod module_state;
mod provider;
mod stream;

use std::{ffi::c_void, panic::catch_unwind};

use windows::{
    Win32::{
        Foundation::{CLASS_E_CLASSNOTAVAILABLE, E_POINTER, S_FALSE, S_OK},
        System::Com::IClassFactory,
    },
    core::{GUID, HRESULT, Interface},
};

use class_factory::ThumbnailClassFactory;
use ids::PROVIDER_CLSID;

/// Returns the Flow Reader thumbnail provider class factory to COM.
///
/// # Safety
///
/// `class_id` and `interface_id` must point to readable GUIDs, and `object` must point to writable
/// storage for one COM interface pointer. The returned pointer follows normal COM ownership rules.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn DllGetClassObject(
    class_id: *const GUID,
    interface_id: *const GUID,
    object: *mut *mut c_void,
) -> HRESULT {
    match catch_unwind(|| unsafe { get_class_object(class_id, interface_id, object) }) {
        Ok(result) => result,
        Err(_) => windows::Win32::Foundation::E_UNEXPECTED,
    }
}

unsafe fn get_class_object(
    class_id: *const GUID,
    interface_id: *const GUID,
    object: *mut *mut c_void,
) -> HRESULT {
    if object.is_null() {
        return E_POINTER;
    }
    unsafe {
        *object = std::ptr::null_mut();
    }
    if class_id.is_null() || interface_id.is_null() {
        return E_POINTER;
    }
    if unsafe { *class_id } != PROVIDER_CLSID {
        return CLASS_E_CLASSNOTAVAILABLE;
    }

    let factory: IClassFactory = ThumbnailClassFactory::new().into();
    unsafe { factory.query(interface_id, object) }
}

#[unsafe(no_mangle)]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    if module_state::can_unload() {
        S_OK
    } else {
        S_FALSE
    }
}
