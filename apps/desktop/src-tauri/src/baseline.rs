pub const ID: &str = "bepinex-5.4.23.5-win-x64";
pub const VERSION: &str = "5.4.23.5";
pub const ARCHIVE_URL: &str =
    "https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.5/BepInEx_win_x64_5.4.23.5.zip";
pub const ARCHIVE_SHA256: &str = "82f9878551030f54657792c0740d9d51a09500eeae1fba21106b0c441e6732c4";
pub const MANIFEST_PUBLIC_KEY_B64: &str = "+lO7hkzYZdQCyQza/a0eUD7z5C5VTaNFcmD/7GTkCeI=";

pub const GITHUB_LATEST_API: &str = "https://api.github.com/repos/BepInEx/BepInEx/releases/latest";
pub const WIN_X64_ASSET_PREFIX: &str = "BepInEx_win_x64_";

pub const REQUIRED_FILES: [(&str, u64, &str); 3] = [
    (
        "winhttp.dll",
        26_112,
        "8c6cdbc38836dee87e3368f5de1994d7c0ccebf29e4ce7aba3c0981f9375412c",
    ),
    (
        "doorstop_config.ini",
        1_460,
        "4d5c6dfa0f771c6a5b1b0c559aca0bd0ece7d08b08fff894708dc3b73ce73cfc",
    ),
    (
        "BepInEx/core/BepInEx.dll",
        128_512,
        "8255b28902886085c578b9e427d3073c97002db85176d2090cdeda90ef14ce70",
    ),
];

pub const APPROVED_BOOTSTRAP: [&str; 2] = ["winhttp.dll", "doorstop_config.ini"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_anchor_is_complete_and_specific() {
        assert_eq!(ID, "bepinex-5.4.23.5-win-x64");
        assert!(ARCHIVE_URL.starts_with("https://github.com/BepInEx/BepInEx/releases/download/"));
        assert!(ARCHIVE_URL.contains("BepInEx_win_x64_5.4.23.5.zip"));
        assert!(GITHUB_LATEST_API.contains("BepInEx/BepInEx/releases/latest"));
        assert_eq!(ARCHIVE_SHA256.len(), 64);
        assert_eq!(MANIFEST_PUBLIC_KEY_B64.len(), 44);
        assert!(REQUIRED_FILES
            .iter()
            .all(|(_, size, hash)| *size > 0 && hash.len() == 64));
    }
}
