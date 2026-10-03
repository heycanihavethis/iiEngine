use crate::{
    auth,
    backup::{self, Inventory},
    baseline, discovery, health,
    manifest::Manifest,
    metadata,
    paths::scoped_path,
    transaction,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State};

const MAX_BASELINE_BYTES: usize = 20 * 1024 * 1024;
const MENUVERSION_URLS: &[&str] = &[
    "https://github.com/iireborn/menu/raw/refs/heads/main/menuversion.json",
    "https://raw.githubusercontent.com/iireborn/menu/refs/heads/main/menuversion.json",
    "https://raw.githubusercontent.com/iireborn/menu/main/menuversion.json",
];
const MENUSTATUS_URLS: &[&str] = &[
    "https://github.com/iireborn/menu/raw/refs/heads/main/menustatus.json",
    "https://raw.githubusercontent.com/iireborn/menu/refs/heads/main/menustatus.json",
    "https://raw.githubusercontent.com/iireborn/menu/main/menustatus.json",
];
const LATEST_MENU_DLL: &str =
    "https://github.com/iireborn/menu/releases/latest/download/ii.Reborn.dll";

#[derive(Clone, Serialize)]
pub struct GithubMenuMetadata {
    pub version: String,
    pub sha256: String,
    pub download_url: String,
    pub release_url: String,
    pub byte_size: u64,
    pub published_at: String,
    pub menu_online: bool,
}

fn github_download_host_allowed(host: &str) -> bool {
    matches!(
        host,
        "github.com" | "objects.githubusercontent.com" | "release-assets.githubusercontent.com"
    ) || host.ends_with(".githubusercontent.com")
        || (host.starts_with("github-production-release-asset-")
            && host.ends_with(".s3.amazonaws.com"))
}

fn menu_download_url_from_payload(payload: &serde_json::Value) -> Result<String, String> {
    if let Some(tagged) = payload
        .get("downloadUrl")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if crate::manifest::validate_url(tagged, true).is_ok() {
            return Ok(tagged.to_string());
        }
    }
    crate::manifest::validate_url(LATEST_MENU_DLL, true)?;
    Ok(LATEST_MENU_DLL.to_string())
}

async fn fetch_github_json(
    client: &reqwest::Client,
    urls: &[&str],
) -> Result<serde_json::Value, String> {
    let mut last_error = String::from("Could not reach the official menu metadata");
    for url in urls {
        let bust = format!(
            "{}{}_ts={}",
            url,
            if url.contains('?') { '&' } else { '?' },
            chrono::Utc::now().timestamp_millis()
        );
        match client
            .get(&bust)
            .header("Cache-Control", "no-cache")
            .header("Pragma", "no-cache")
            .send()
            .await
        {
            Ok(response) => match response.error_for_status() {
                Ok(ok) => match ok.json::<serde_json::Value>().await {
                    Ok(payload) => return Ok(payload),
                    Err(_) => last_error = "Official menu metadata was not valid JSON".into(),
                },
                Err(_) => last_error = "Official menu metadata returned an error".into(),
            },
            Err(_) => last_error = "Could not reach the official menu metadata".into(),
        }
    }
    Err(last_error)
}

async fn resolve_github_menu_metadata() -> Result<GithubMenuMetadata, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("ii-Engine/0.2.2")
        .build()
        .map_err(|_| "Cannot initialize GitHub metadata client")?;
    let online = match fetch_github_json(&client, MENUSTATUS_URLS).await {
        Ok(payload) => match payload.get("menustatus").or_else(|| payload.get("status")) {
            Some(serde_json::Value::Bool(value)) => *value,
            Some(serde_json::Value::String(value)) => {
                let lowered = value.trim().to_ascii_lowercase();
                !(lowered == "false" || lowered == "offline" || lowered == "0" || lowered == "no")
            }
            _ => true,
        },
        Err(_) => true,
    };
    if !online {
        return Err("Menu is marked offline in menustatus.json".into());
    }
    let payload = fetch_github_json(&client, MENUVERSION_URLS).await?;
    let version = payload
        .get("version")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Official menu version list is missing version".to_string())?
        .to_string();
    let sha_raw = payload
        .get("sha256")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .ok_or_else(|| "Official menu version list is missing sha256".to_string())?;
    let sha256 = sha_raw
        .strip_prefix("sha256:")
        .unwrap_or(sha_raw)
        .to_ascii_lowercase();
    if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Official menu version list has an invalid SHA-256".into());
    }
    let download_url = menu_download_url_from_payload(&payload)?;
    let release_url = payload
        .get("releaseUrl")
        .and_then(|value| value.as_str())
        .unwrap_or("https://github.com/iireborn/menu/releases")
        .to_string();
    let _ = crate::manifest::validate_url(&release_url, false);
    let mut byte_size = 0_u64;
    if let Ok(head) = client
        .head(&download_url)
        .header("Cache-Control", "no-cache")
        .send()
        .await
    {
        if let Some(length) = head.content_length() {
            if (1024..=100_000_000).contains(&length) {
                byte_size = length;
            }
        }
    }
    Ok(GithubMenuMetadata {
        version,
        sha256,
        download_url,
        release_url,
        byte_size,
        published_at: chrono::Utc::now().to_rfc3339(),
        menu_online: online,
    })
}

#[tauri::command]
pub async fn fetch_github_menu_metadata() -> Result<GithubMenuMetadata, String> {
    resolve_github_menu_metadata().await
}

fn menu_packages_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot resolve ii Engine app data")?
        .join("menu-packages"))
}

fn read_cached_menu_bytes(app: &AppHandle, sha256: &str) -> Option<Vec<u8>> {
    let root = menu_packages_root(app).ok()?;
    let path = root.join(sha256.to_ascii_lowercase()).join("ii.Reborn.dll");
    let bytes = fs::read(path).ok()?;
    if bytes.len() < 64 || &bytes[..2] != b"MZ" {
        return None;
    }
    if hex::encode(Sha256::digest(&bytes)) != sha256.to_ascii_lowercase() {
        return None;
    }
    Some(bytes)
}

fn write_cached_menu_bytes(app: &AppHandle, meta: &GithubMenuMetadata, bytes: &[u8]) {
    let Ok(root) = menu_packages_root(app) else {
        return;
    };
    let dir = root.join(meta.sha256.to_ascii_lowercase());
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("ii.Reborn.dll");
    if fs::write(&path, bytes).is_ok() {
        let _ = fs::write(
            dir.join("menuversion.json"),
            serde_json::json!({
                "version": meta.version,
                "sha256": meta.sha256,
                "downloadUrl": meta.download_url,
                "releaseUrl": meta.release_url,
            })
            .to_string(),
        );
    }
}

async fn download_verified_github_menu(
    app: &AppHandle,
) -> Result<(GithubMenuMetadata, Vec<u8>), String> {
    let mut last_error = String::from("Downloaded menu failed SHA-256 verification");
    for attempt in 0..2 {
        let meta = resolve_github_menu_metadata().await?;
        if let Some(cached) = read_cached_menu_bytes(app, &meta.sha256) {
            if metadata::verify_menu(&cached, &meta.version).is_ok() {
                return Ok((meta, cached));
            }
        }
        let mut urls = vec![meta.download_url.clone()];
        if meta.download_url != LATEST_MENU_DLL {
            urls.push(LATEST_MENU_DLL.to_string());
        }
        for url in urls {
            crate::manifest::validate_url(&url, true)?;
            let menu = match download(&url, 100_000_000).await {
                Ok(bytes) => bytes,
                Err(error) => {
                    last_error = error;
                    continue;
                }
            };
            if menu.len() < 64 || &menu[..2] != b"MZ" {
                last_error = "Downloaded menu was not a Windows DLL".into();
                continue;
            }
            let actual = hex::encode(Sha256::digest(&menu));
            if actual == meta.sha256.to_lowercase() {
                metadata::verify_menu(&menu, &meta.version)?;
                write_cached_menu_bytes(app, &meta, &menu);
                return Ok((meta, menu));
            }
            last_error = "Downloaded menu failed SHA-256 verification".into();
        }
        if attempt == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        }
    }
    Err(last_error)
}

struct Prepared {
    game: PathBuf,
    source: PathBuf,
    preview: Inventory,
    version: String,
}

#[derive(Default)]
pub struct InstallState(Mutex<HashMap<String, Prepared>>);

#[derive(Serialize)]
pub struct InstallPreview {
    pub token: String,
    pub menu_version: String,
    pub backup_bytes: u64,
    pub scopes: Vec<String>,
    pub changes: usize,
}

#[derive(Serialize)]
pub struct InstallResult {
    pub operation_id: String,
    pub menu_version: String,
}

fn roots(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot resolve ii Engine local data directory")?;
    let downloads = root.join("Downloads");
    let backups = root.join("Backups");
    fs::create_dir_all(&downloads).map_err(|_| "Cannot create download directory")?;
    fs::create_dir_all(&backups).map_err(|_| "Cannot create backup directory")?;
    Ok((root, downloads, backups))
}

fn public_key() -> Result<[u8; 32], String> {
    let bytes = STANDARD
        .decode(baseline::MANIFEST_PUBLIC_KEY_B64)
        .map_err(|_| "Pinned manifest public key is invalid")?;
    bytes
        .try_into()
        .map_err(|_| "Pinned manifest public key has the wrong size".into())
}

async fn download(url: &str, maximum: usize) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let allowed = attempt
                .url()
                .host_str()
                .is_some_and(github_download_host_allowed);
            if !allowed {
                attempt.error("Download redirect left the approved GitHub hosts")
            } else if attempt.previous().len() >= 8 {
                attempt.error("Too many download redirects")
            } else {
                attempt.follow()
            }
        }))
        .user_agent("ii-Engine/0.2.2")
        .build()
        .map_err(|_| "Cannot initialize secure download")?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Download failed")?
        .error_for_status()
        .map_err(|_| "Download service returned an error")?;
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err("Download exceeds the approved size limit".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Download was interrupted")?;
    if bytes.len() > maximum {
        return Err("Download exceeds the approved size limit".into());
    }
    Ok(bytes.to_vec())
}

#[allow(dead_code)]
async fn download_managed(url: &str, release_id: &str, maximum: usize) -> Result<Vec<u8>, String> {
    if release_id.len() != 36
        || !release_id
            .bytes()
            .all(|value| value.is_ascii_hexdigit() || value == b'-')
    {
        return Err("Managed release ID is invalid".into());
    }
    let expected_origin = reqwest::Url::parse(&auth::backend()?)
        .map_err(|_| "Configured backend origin is invalid")?;
    let parsed = reqwest::Url::parse(url).map_err(|_| "Managed release URL is invalid")?;
    let expected_path = format!("/v1/menu-releases/{release_id}/download");
    let query: Vec<_> = parsed.query_pairs().collect();
    if parsed.scheme() != expected_origin.scheme()
        || parsed.host_str() != expected_origin.host_str()
        || parsed.port_or_known_default() != expected_origin.port_or_known_default()
        || parsed.path() != expected_path
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || query.len() != 1
        || query[0].0 != "ticket"
        || query[0].1.len() < 40
    {
        return Err("Managed release URL left the configured ii Engine backend".into());
    }
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("ii-Engine/0.2.2")
        .build()
        .map_err(|_| "Cannot initialize managed release download")?
        .get(parsed)
        .send()
        .await
        .map_err(|_| "Managed release download failed")?
        .error_for_status()
        .map_err(|_| "Managed release download was rejected")?;
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err("Managed release exceeds the approved size limit".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Managed release download was interrupted")?;
    if bytes.len() > maximum {
        return Err("Managed release exceeds the approved size limit".into());
    }
    Ok(bytes.to_vec())
}

#[derive(Clone)]
struct BepInExPackage {
    #[allow(dead_code)]
    version: String,
    download_url: String,
    sha256: Option<String>,
}

fn bepinex_tag_is_v5(tag: &str) -> bool {
    let trimmed = tag.trim().trim_start_matches('v');
    trimmed.starts_with("5.")
}

fn parse_github_digest(value: &str) -> Option<String> {
    let raw = value
        .strip_prefix("sha256:")
        .unwrap_or(value)
        .trim()
        .to_ascii_lowercase();
    if raw.len() == 64 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(raw)
    } else {
        None
    }
}

fn parse_latest_bepinex_package(payload: &serde_json::Value) -> Result<BepInExPackage, String> {
    let tag = payload
        .get("tag_name")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "BepInEx GitHub latest release is missing tag_name".to_string())?;
    if !bepinex_tag_is_v5(tag) {
        return Err(format!(
            "Latest BepInEx release {tag} is not a supported 5.x LTS package"
        ));
    }
    let assets = payload
        .get("assets")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "BepInEx GitHub latest release has no assets".to_string())?;
    let asset = assets
        .iter()
        .find(|asset| {
            asset
                .get("name")
                .and_then(|value| value.as_str())
                .is_some_and(|name| {
                    name.starts_with(baseline::WIN_X64_ASSET_PREFIX)
                        && name.to_ascii_lowercase().ends_with(".zip")
                })
        })
        .ok_or_else(|| "BepInEx GitHub latest release has no win_x64 zip".to_string())?;
    let download_url = asset
        .get("browser_download_url")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "BepInEx win_x64 asset is missing a download URL".to_string())?;
    if !download_url.starts_with("https://github.com/BepInEx/BepInEx/releases/download/") {
        return Err("BepInEx download URL left the official GitHub releases host".into());
    }
    let version = tag.trim_start_matches('v').to_string();
    let sha256 = asset
        .get("digest")
        .and_then(|value| value.as_str())
        .and_then(parse_github_digest);
    Ok(BepInExPackage {
        version,
        download_url: download_url.to_string(),
        sha256,
    })
}

async fn resolve_github_bepinex() -> Result<BepInExPackage, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("ii-Engine/0.2.2")
        .build()
        .map_err(|_| "Cannot initialize BepInEx GitHub client")?;
    let bust = format!(
        "{}?_ts={}",
        baseline::GITHUB_LATEST_API,
        chrono::Utc::now().timestamp_millis()
    );
    let payload = client
        .get(&bust)
        .header("Accept", "application/vnd.github+json")
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .map_err(|_| "Could not reach BepInEx GitHub releases")?
        .error_for_status()
        .map_err(|_| "BepInEx GitHub releases returned an error")?
        .json::<serde_json::Value>()
        .await
        .map_err(|_| "BepInEx GitHub latest release was not valid JSON")?;
    parse_latest_bepinex_package(&payload)
}

fn required_file_structurally_ok(relative: &str, bytes: &[u8]) -> bool {
    if relative.eq_ignore_ascii_case("doorstop_config.ini") {
        if bytes.len() < 80 || bytes.len() > 64_000 {
            return false;
        }
        let text = String::from_utf8_lossy(bytes).to_ascii_lowercase();
        return text.contains("doorstop") || text.contains("target_assembly");
    }
    bytes.len() >= 8_192 && bytes.len() <= 8_000_000 && bytes.len() >= 2 && &bytes[..2] == b"MZ"
}

fn extract_bepinex(bytes: &[u8], destination: &Path, pinned: bool) -> Result<(), String> {
    if pinned && hex::encode(Sha256::digest(bytes)) != baseline::ARCHIVE_SHA256 {
        return Err("BepInEx archive does not match the owner-approved baseline".into());
    }
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "BepInEx archive is invalid")?;
    if archive.len() > 1000 {
        return Err("BepInEx archive contains too many files".into());
    }
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "Cannot inspect BepInEx archive")?;
        let relative = entry
            .enclosed_name()
            .ok_or("BepInEx archive contains an unsafe path")?
            .to_path_buf();
        if entry.is_symlink() {
            return Err("BepInEx archive contains an unsupported link".into());
        }
        total = total
            .checked_add(entry.size())
            .ok_or("BepInEx archive size overflow")?;
        if total > MAX_BASELINE_BYTES as u64 {
            return Err("BepInEx archive expands beyond its approved limit".into());
        }
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(output).map_err(|_| "Cannot stage BepInEx directory")?;
            continue;
        }
        fs::create_dir_all(output.parent().ok_or("Invalid BepInEx path")?)
            .map_err(|_| "Cannot stage BepInEx parent")?;
        let mut file = File::create_new(output).map_err(|_| "Cannot stage BepInEx file")?;
        std::io::copy(&mut entry, &mut file).map_err(|_| "Cannot extract BepInEx file")?;
        file.sync_all()
            .map_err(|_| "Cannot flush staged BepInEx file")?;
    }
    for (relative, size, hash) in baseline::REQUIRED_FILES {
        let path = destination.join(relative);
        if pinned {
            let actual = backup::hash_file(&path)
                .map_err(|_| format!("Antivirus is locking staged {relative} for verification."))?;
            if actual != (size, hash.into()) {
                return Err("Extracted BepInEx baseline failed verification".into());
            }
            continue;
        }
        let bytes = fs::read(&path)
            .map_err(|_| format!("Live BepInEx package is missing required file {relative}"))?;
        if !required_file_structurally_ok(relative, &bytes) {
            return Err(format!(
                "Live BepInEx package failed structural checks for {relative}"
            ));
        }
    }
    Ok(())
}

async fn download_bepinex_archive() -> Result<(Vec<u8>, bool), String> {
    match resolve_github_bepinex().await {
        Ok(package) => match download(&package.download_url, MAX_BASELINE_BYTES).await {
            Ok(bytes) => {
                let digest_ok = match &package.sha256 {
                    Some(expected) => hex::encode(Sha256::digest(&bytes)) == *expected,
                    None => true,
                };
                if digest_ok {
                    return Ok((bytes, false));
                }
            }
            Err(_) => {}
        },
        Err(_) => {}
    }
    let bytes = download(baseline::ARCHIVE_URL, MAX_BASELINE_BYTES).await?;
    Ok((bytes, true))
}

fn menu_scopes(game: &Path, repair_mode: &str) -> Result<Vec<String>, String> {
    if repair_mode == "full" {
        return Ok(vec![
            "winhttp.dll".into(),
            "doorstop_config.ini".into(),
            "BepInEx".into(),
            "iisStupidMenu".into(),
        ]);
    }
    if !matches!(repair_mode, "targeted" | "menu" | "bepinex") {
        return Err("Unknown repair mode".into());
    }
    let mut scopes: Vec<String> = Vec::new();
    if repair_mode != "menu" {
        scopes.extend([
            "winhttp.dll".into(),
            "doorstop_config.ini".into(),
            "BepInEx/core".into(),
        ]);
    }
    if repair_mode != "bepinex" {
        scopes.push("BepInEx/plugins/ii.Reborn.dll".into());
        scopes.push("BepInEx/plugins/ii.s.Stupid.Menu.dll".into());
        for file in health::inspect(game)?
            .files
            .into_iter()
            .filter(|file| file.menu)
        {
            let relative = file.name.replace('\\', "/");
            if !scopes
                .iter()
                .any(|scope| scope.eq_ignore_ascii_case(&relative))
            {
                scopes.push(relative);
            }
        }
    }
    scopes.sort_by_key(|scope| scope.to_lowercase());
    Ok(scopes)
}

async fn prepare_menu(
    app: &AppHandle,
    state: &InstallState,
    game_path: &str,
    menu: Vec<u8>,
    version: String,
    repair_mode: &str,
    operation: &str,
) -> Result<InstallPreview, String> {
    let game = fs::canonicalize(game_path).map_err(|_| "Cannot resolve selected game folder")?;
    if !discovery::validate_game(&game).valid {
        return Err("Select a valid Gorilla Tag installation".into());
    }
    if health::running() {
        return Err("Close Gorilla Tag before preparing an installation".into());
    }
    let (_, downloads, _) = roots(app)?;
    let token = hex::encode(rand::random::<[u8; 16]>());
    let source = scoped_path(&downloads, Path::new(&token))
        .map_err(|_| "Cannot create safe download stage")?;
    fs::create_dir(&source).map_err(|_| "Cannot create download stage")?;
    if repair_mode == "menu" {
        fs::create_dir_all(source.join("BepInEx/plugins"))
            .map_err(|_| "Cannot create menu stage")?;
    } else {
        let (baseline_bytes, pinned) = download_bepinex_archive().await?;
        if let Err(live_error) = extract_bepinex(&baseline_bytes, &source, pinned) {
            if pinned {
                return Err(live_error);
            }
            let _ = fs::remove_dir_all(&source);
            fs::create_dir(&source).map_err(|_| "Cannot recreate download stage")?;
            let backup_bytes = download(baseline::ARCHIVE_URL, MAX_BASELINE_BYTES).await?;
            extract_bepinex(&backup_bytes, &source, true)?;
        }
    }
    let menu_path = source.join("BepInEx/plugins/ii.Reborn.dll");
    fs::create_dir_all(menu_path.parent().ok_or("Invalid menu stage path")?)
        .map_err(|_| "Cannot create menu stage")?;
    File::create_new(&menu_path)
        .and_then(|mut file| file.write_all(&menu).and_then(|_| file.sync_all()))
        .map_err(|_| "Cannot stage verified menu")?;
    let approved: Vec<String> = baseline::APPROVED_BOOTSTRAP
        .iter()
        .map(|value| (*value).into())
        .collect();
    let scopes = menu_scopes(&game, repair_mode)?;
    let preview = backup::preview(&game, &scopes, &approved, operation)?;
    let changes = backup::preview(&source, &scopes, &approved, "desired-install")?
        .entries
        .len();
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "Install review state unavailable")?;
    if pending.len() >= 3 {
        return Err("Too many pending installation reviews; restart ii Engine".into());
    }
    pending.insert(
        token.clone(),
        Prepared {
            game,
            source,
            preview: preview.clone(),
            version: version.clone(),
        },
    );
    Ok(InstallPreview {
        token,
        menu_version: version,
        backup_bytes: preview.total_bytes,
        scopes,
        changes,
    })
}

#[tauri::command]
pub async fn prepare_install(
    app: AppHandle,
    state: State<'_, InstallState>,
    game_path: String,
    manifest_json: String,
    repair_mode: Option<String>,
) -> Result<InstallPreview, String> {
    let manifest: Manifest =
        serde_json::from_str(&manifest_json).map_err(|_| "Signed release manifest is malformed")?;
    manifest.verify(&public_key()?, "stable", chrono::Utc::now())?;
    let menu = download(&manifest.download_url, 100_000_000).await?;
    manifest.verify_hash(&menu)?;
    metadata::verify_menu(&menu, &manifest.menu_version)?;
    let mode = repair_mode.as_deref().unwrap_or("targeted");
    prepare_menu(
        &app,
        &state,
        &game_path,
        menu,
        manifest.menu_version,
        mode,
        "install-stable",
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn prepare_github_menu_install(
    app: AppHandle,
    state: State<'_, InstallState>,
    game_path: String,
    version: String,
    sha256: String,
    download_url: String,
    repair_mode: Option<String>,
) -> Result<InstallPreview, String> {
    let _ = (version, sha256, download_url);
    let (meta, menu) = download_verified_github_menu(&app).await?;
    prepare_menu(
        &app,
        &state,
        &game_path,
        menu,
        meta.version,
        repair_mode.as_deref().unwrap_or("targeted"),
        "install-github-menuversion",
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn prepare_managed_install(
    app: AppHandle,
    state: State<'_, InstallState>,
    game_path: String,
    release_id: String,
    version: String,
    sha256: String,
    download_url: String,
    repair_mode: Option<String>,
) -> Result<InstallPreview, String> {
    let _ = (
        app,
        state,
        game_path,
        release_id,
        version,
        sha256,
        download_url,
        repair_mode,
    );
    Err("Managed menu downloads are disabled. ii Engine installs from GitHub Releases only.".into())
}

#[tauri::command]
pub async fn download_github_menu_release(
    app: AppHandle,
    version: String,
    sha256: String,
    download_url: String,
) -> Result<String, String> {
    let _ = (version, sha256, download_url);
    let (meta, menu) = download_verified_github_menu(&app).await?;
    let safe_version: String = meta
        .version
        .chars()
        .filter(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '_'))
        .take(48)
        .collect();
    if safe_version.is_empty() {
        return Err("Official release version cannot be used as a filename".into());
    }
    let downloads = app
        .path()
        .download_dir()
        .map_err(|_| "Cannot resolve the Windows Downloads folder")?;
    let destination = downloads.join(format!("ii.Reborn-{safe_version}.dll"));
    let mut file = File::create(&destination).map_err(|_| "Cannot create the downloaded DLL")?;
    file.write_all(&menu)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not save the downloaded DLL")?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn warm_github_menu_cache(
    app: AppHandle,
    version: String,
    sha256: String,
    download_url: String,
) -> Result<String, String> {
    let _ = (version, sha256, download_url);
    let (meta, _menu) = download_verified_github_menu(&app).await?;
    Ok(meta.sha256)
}

#[tauri::command]
pub async fn download_managed_release(
    app: AppHandle,
    release_id: String,
    version: String,
    sha256: String,
    download_url: String,
) -> Result<String, String> {
    let _ = (app, release_id, version, sha256, download_url);
    Err("Managed menu downloads are disabled. Use GitHub Releases.".into())
}

#[tauri::command]
pub fn prepare_reset_settings(
    app: AppHandle,
    state: State<'_, InstallState>,
    game_path: String,
) -> Result<InstallPreview, String> {
    let game = fs::canonicalize(game_path).map_err(|_| "Cannot resolve selected game folder")?;
    if !discovery::validate_game(&game).valid {
        return Err("Select a valid Gorilla Tag installation".into());
    }
    if health::running() {
        return Err("Close Gorilla Tag before resetting ii settings".into());
    }
    let (_, downloads, _) = roots(&app)?;
    let token = hex::encode(rand::random::<[u8; 16]>());
    let source = scoped_path(&downloads, Path::new(&token))
        .map_err(|_| "Cannot create safe settings stage")?;
    fs::create_dir(&source).map_err(|_| "Cannot create settings stage")?;
    let scopes = vec!["iisStupidMenu".to_string()];
    let preview = backup::preview(&game, &scopes, &[], "reset-ii-settings")?;
    state
        .0
        .lock()
        .map_err(|_| "Install review state unavailable")?
        .insert(
            token.clone(),
            Prepared {
                game,
                source,
                preview: preview.clone(),
                version: "Settings reset".into(),
            },
        );
    Ok(InstallPreview {
        token,
        menu_version: "Settings reset".into(),
        backup_bytes: preview.total_bytes,
        scopes,
        changes: 0,
    })
}

#[tauri::command]
pub fn open_game_folder(game_path: String) -> Result<(), String> {
    let game = fs::canonicalize(game_path).map_err(|_| "Cannot resolve selected game folder")?;
    if !discovery::validate_game(&game).valid {
        return Err("Select a valid Gorilla Tag installation".into());
    }
    open::that(game).map_err(|_| "Could not open the Gorilla Tag folder".into())
}

#[tauri::command]
pub fn open_ii_folder(game_path: String) -> Result<(), String> {
    let game = fs::canonicalize(game_path).map_err(|_| "Cannot resolve selected game folder")?;
    if !discovery::validate_game(&game).valid {
        return Err("Select a valid Gorilla Tag installation".into());
    }
    let folder = scoped_path(&game, Path::new("iisStupidMenu"))
        .map_err(|_| "The ii settings folder has an unsafe path")?;
    fs::create_dir_all(&folder).map_err(|_| "Could not create the ii settings folder")?;
    open::that(folder).map_err(|_| "Could not open the ii settings folder".into())
}

#[tauri::command]
pub fn start_clean_game_reinstall(
    app: AppHandle,
    game_path: String,
    confirmation: String,
) -> Result<String, String> {
    if confirmation != "RESET GORILLA TAG" {
        return Err("Type RESET GORILLA TAG to confirm the clean reinstall".into());
    }
    if health::running() {
        return Err("Close Gorilla Tag before starting a clean reinstall".into());
    }
    let game = fs::canonicalize(game_path).map_err(|_| "Cannot resolve selected game folder")?;
    if !discovery::validate_game(&game).valid {
        return Err("Select a valid Gorilla Tag installation".into());
    }
    if !game
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("Gorilla Tag"))
    {
        return Err("The selected folder is not named Gorilla Tag".into());
    }
    let parent = game
        .parent()
        .ok_or("The selected Gorilla Tag folder has no parent")?;
    if !parent
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
        .ends_with("/steamapps/common")
    {
        return Err("The selected game is not inside a Steam steamapps/common folder".into());
    }
    let (app_root, _, backups) = roots(&app)?;
    let _lock = backup::OperationLock::acquire(&app_root)?;
    let plugins = scoped_path(&game, Path::new("BepInEx/plugins"))
        .map_err(|_| "The BepInEx plugins folder has an unsafe path")?;
    let backup_location = if plugins.is_dir() {
        let scopes = vec!["BepInEx/plugins".to_owned()];
        let preview = backup::preview(&game, &scopes, &[], "clean-reset-plugin-backup")?;
        if preview.entries.is_empty() {
            "No plugins were present to back up.".to_owned()
        } else {
            backup::create(&game, &backups, &preview, &[])?
                .to_string_lossy()
                .into_owned()
        }
    } else {
        "No plugins folder was present to back up.".to_owned()
    };
    fs::remove_dir_all(&game)
        .map_err(|_| "Could not remove the Gorilla Tag installation folder")?;
    open::that("steam://uninstall/1533390").map_err(|_| {
        "The game folder was removed, but Steam could not open the uninstall prompt"
    })?;
    Ok(backup_location)
}

#[tauri::command]
pub fn continue_clean_game_reinstall() -> Result<(), String> {
    open::that("steam://install/1533390")
        .map_err(|_| "Steam could not open the Gorilla Tag install prompt".into())
}

#[tauri::command]
pub async fn execute_install(
    app: AppHandle,
    state: State<'_, InstallState>,
    token: String,
) -> Result<InstallResult, String> {
    let prepared = state
        .0
        .lock()
        .map_err(|_| "Install review state unavailable")?
        .remove(&token)
        .ok_or("Installation review expired; prepare it again")?;
    let (app_root, _, backups) = roots(&app)?;
    let approved: Vec<String> = baseline::APPROVED_BOOTSTRAP
        .iter()
        .map(|value| (*value).into())
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        let operation_id = transaction::execute(
            &app_root,
            &prepared.game,
            &backups,
            &prepared.preview,
            &prepared.source,
            &approved,
        )?;
        backup::prune_successful(&backups)?;
        Ok(InstallResult {
            operation_id,
            menu_version: prepared.version,
        })
    })
    .await
    .map_err(|_| "Install worker stopped unexpectedly".to_string())?
}

fn engine_data_dir(game: &Path) -> Result<PathBuf, String> {
    let dir = scoped_path(game, Path::new("ii Engine"))
        .map_err(|_| "The ii Engine data folder has an unsafe path")?;
    if dir.is_file() {
        fs::remove_file(&dir).map_err(|_| "Could not migrate the legacy ii Engine marker")?;
    }
    fs::create_dir_all(&dir).map_err(|_| "Could not create the ii Engine data folder")?;
    Ok(dir)
}

fn ensure_engine_marker(game: &Path) -> Result<(), String> {
    let dir = engine_data_dir(game)?;
    let marker = dir.join(".installed");
    if marker.exists() {
        return Ok(());
    }
    fs::write(&marker, "ii Engine\n")
        .map_err(|_| "Could not create the ii Engine marker file".into())
}

#[tauri::command]
pub fn launch_game(game_path: String) -> Result<(), String> {
    let game = fs::canonicalize(game_path).map_err(|_| "Cannot resolve selected game folder")?;
    if !discovery::validate_game(&game).valid {
        return Err("Select a valid Gorilla Tag installation".into());
    }
    ensure_engine_marker(&game)?;
    open::that("steam://run/1533390")
        .map_err(|_| "Could not ask Steam to launch Gorilla Tag".into())
}

#[tauri::command]
pub fn launch_without_ii(game_path: String) -> Result<(), String> {
    let game = fs::canonicalize(game_path).map_err(|_| "Cannot resolve selected game folder")?;
    if !discovery::validate_game(&game).valid {
        return Err("Select a valid Gorilla Tag installation".into());
    }
    if health::running() {
        return Err("Gorilla Tag is already running".into());
    }
    for relative in menu_scopes(&game, "targeted")? {
        let path = scoped_path(&game, Path::new(&relative))
            .map_err(|_| "An installed menu has an unsafe path")?;
        if path.is_file() {
            let disabled = path.with_extension("dll.disabled");
            if disabled.exists() {
                fs::remove_file(&disabled).map_err(|_| "Could not replace a disabled menu copy")?;
            }
            fs::rename(&path, disabled).map_err(|_| "Could not disable the ii menu for launch")?;
        }
    }
    ensure_engine_marker(&game)?;
    open::that("steam://run/1533390")
        .map_err(|_| "Could not ask Steam to launch Gorilla Tag".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_latest_bepinex_win_x64_package() {
        let payload = serde_json::json!({
            "tag_name": "v5.4.23.5",
            "assets": [
                {
                    "name": "BepInEx_linux_x64_5.4.23.5.zip",
                    "browser_download_url": "https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.5/BepInEx_linux_x64_5.4.23.5.zip"
                },
                {
                    "name": "BepInEx_win_x64_5.4.23.5.zip",
                    "browser_download_url": "https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.5/BepInEx_win_x64_5.4.23.5.zip",
                    "digest": "sha256:82f9878551030f54657792c0740d9d51a09500eeae1fba21106b0c441e6732c4"
                }
            ]
        });
        let package = parse_latest_bepinex_package(&payload).expect("package");
        assert_eq!(package.version, "5.4.23.5");
        assert!(package
            .download_url
            .contains("BepInEx_win_x64_5.4.23.5.zip"));
        assert_eq!(
            package.sha256.as_deref(),
            Some("82f9878551030f54657792c0740d9d51a09500eeae1fba21106b0c441e6732c4")
        );
    }

    #[test]
    fn rejects_bepinex_6_latest_release() {
        let payload = serde_json::json!({
            "tag_name": "v6.0.0",
            "assets": [{
                "name": "BepInEx_win_x64_6.0.0.zip",
                "browser_download_url": "https://github.com/BepInEx/BepInEx/releases/download/v6.0.0/BepInEx_win_x64_6.0.0.zip"
            }]
        });
        assert!(parse_latest_bepinex_package(&payload).is_err());
    }

    #[test]
    fn review_finds_nested_menu_aliases_and_preserves_unrelated_mods() {
        let root = tempfile::tempdir().expect("temporary game root");
        fs::write(root.path().join("Gorilla Tag.exe"), b"fixture").expect("game executable");
        fs::write(root.path().join("UnityPlayer.dll"), b"fixture").expect("unity player");
        fs::create_dir(root.path().join("Gorilla Tag_Data")).expect("game data");
        let nested = root.path().join("BepInEx/plugins/old/menu");
        fs::create_dir_all(&nested).expect("plugin directory");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../work/managed-fixtures/MenuFixture.dll");
        fs::copy(&fixture, nested.join("legacy.dll")).expect("menu fixture");
        fs::write(nested.join("unrelated.dll"), b"another plugin").expect("unrelated plugin");

        let scopes = menu_scopes(root.path(), "targeted").expect("installation scopes");

        assert!(scopes
            .iter()
            .any(|path| path == "BepInEx/plugins/old/menu/legacy.dll"));
        assert!(scopes
            .iter()
            .any(|path| path == "BepInEx/plugins/ii.Reborn.dll"));
        assert!(!scopes.iter().any(|path| path.ends_with("unrelated.dll")));
    }

    #[test]
    fn launch_marker_is_created_once() {
        let root = tempfile::tempdir().expect("temporary game root");
        fs::write(root.path().join("Gorilla Tag.exe"), b"fixture").expect("game executable");
        fs::write(root.path().join("UnityPlayer.dll"), b"fixture").expect("unity player");
        fs::create_dir(root.path().join("Gorilla Tag_Data")).expect("game data");
        let marker = root.path().join("ii Engine").join(".installed");
        assert!(!marker.exists());
        ensure_engine_marker(root.path()).expect("create marker");
        assert!(root.path().join("ii Engine").is_dir());
        assert_eq!(fs::read_to_string(&marker).unwrap().trim(), "ii Engine");
        let first_modified = fs::metadata(&marker).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        ensure_engine_marker(root.path()).expect("idempotent marker");
        let second_modified = fs::metadata(&marker).unwrap().modified().unwrap();
        assert_eq!(first_modified, second_modified);
    }

    #[test]
    fn migrates_legacy_file_marker_into_data_folder() {
        let root = tempfile::tempdir().expect("temporary game root");
        fs::write(root.path().join("Gorilla Tag.exe"), b"fixture").expect("game executable");
        fs::write(root.path().join("UnityPlayer.dll"), b"fixture").expect("unity player");
        fs::create_dir(root.path().join("Gorilla Tag_Data")).expect("game data");
        fs::write(root.path().join("ii Engine"), b"ii Engine\n").expect("legacy marker file");
        ensure_engine_marker(root.path()).expect("migrate marker");
        assert!(root.path().join("ii Engine").is_dir());
        assert_eq!(
            fs::read_to_string(root.path().join("ii Engine/.installed"))
                .unwrap()
                .trim(),
            "ii Engine"
        );
    }
}
