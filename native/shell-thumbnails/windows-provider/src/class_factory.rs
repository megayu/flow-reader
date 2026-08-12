use std::ffi::c_void;

use windows::{
    Win32::{
        Foundation::{CLASS_E_NOAGGREGATION, E_POINTER},
        System::Com::{IClassFactory, IClassFactory_Impl},
        UI::Shell::IThumbnailProvider,
    },
    core::{Error, GUID, IUnknown, Interface, Ref, Result, implement},
};
use windows_core::BOOL;

use crate::{module_state, provider::ThumbnailProvider};

#[implement(IClassFactory)]
pub(crate) struct ThumbnailClassFactory;

impl ThumbnailClassFactory {
    pub(crate) fn new() -> Self {
        module_state::add_object();
        Self
    }
}

impl Drop for ThumbnailClassFactory {
    fn drop(&mut self) {
        module_state::remove_object();
    }
}

#[allow(non_snake_case)]
impl IClassFactory_Impl for ThumbnailClassFactory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<IUnknown>,
        interface_id: *const GUID,
        object: *mut *mut c_void,
    ) -> Result<()> {
        if object.is_null() || interface_id.is_null() {
            return Err(Error::from_hresult(E_POINTER));
        }
        unsafe {
            *object = std::ptr::null_mut();
        }
        if !outer.is_null() {
            return Err(Error::from_hresult(CLASS_E_NOAGGREGATION));
        }

        let provider: IThumbnailProvider = ThumbnailProvider::new().into();
        unsafe { provider.query(interface_id, object).ok() }
    }

    fn LockServer(&self, locked: BOOL) -> Result<()> {
        module_state::set_server_lock(locked.as_bool());
        Ok(())
    }
}
