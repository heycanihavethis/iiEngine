#[cfg(target_os = "windows")]
pub fn register_auth_protocol() {
    use std::env;
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    let Ok(exe) = env::current_exe() else {
        return;
    };
    let exe_path = exe.to_string_lossy().replace('/', "\\");
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok((key, _)) = hkcu.create_subkey("Software\\Classes\\iiengine") else {
        return;
    };
    let _ = key.set_value("", &"URL:ii Engine Protocol");
    let _ = key.set_value("URL Protocol", &"");
    let Ok((command, _)) = key.create_subkey("shell\\open\\command") else {
        return;
    };
    let cmd = format!("\"{exe_path}\" \"%1\"");
    let _ = command.set_value("", &cmd);
}

#[cfg(not(target_os = "windows"))]
pub fn register_auth_protocol() {}

pub fn launched_from_auth_complete() -> bool {
    std::env::args().any(|arg| {
        let lower = arg.to_ascii_lowercase();
        lower.starts_with("iiengine://auth-complete") || lower.starts_with("iiengine:auth-complete")
    })
}
