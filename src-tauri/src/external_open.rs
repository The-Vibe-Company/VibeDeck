use url::Url;

#[cfg(target_os = "macos")]
pub(crate) fn open(url: &Url) -> bool {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    let value = NSString::from_str(url.as_str());
    NSURL::URLWithString(&value)
        .is_some_and(|native_url| NSWorkspace::sharedWorkspace().openURL(&native_url))
}

#[cfg(target_os = "windows")]
pub(crate) fn open(url: &Url) -> bool {
    use std::{iter, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

    let operation = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let target = std::ffi::OsStr::new(url.as_str())
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            ptr::null(),
            ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    result as isize > 32
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn open(_url: &Url) -> bool {
    false
}
