use serde::Serialize;
use std::{
    fs::{self, File},
    io::Write,
    path::Path,
};
use tauri::{AppHandle, Manager};

const RELEASES_API: &str = "https://api.github.com/repos/iireborn/iiEngine/releases";
const RELEASES_PAGE: &str = "https://github.com/iireborn/iiEngine/releases";
const MAX_INSTALLER_BYTES: usize = 200 * 1024 * 1024;

#[derive(Clone, Serialize)]
pub struct EngineUpdateStatus {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub outdated: bool,
    pub download_url: Option<String>,
    pub release_url: Option<String>,
    pub can_install: bool,
    pub detail: String,
}

fn github_download_host_allowed(host: &str) -> bool {
    matches!(
        host,
        "github.com" | "objects.githubusercontent.com" | "release-assets.githubusercontent.com"
    ) || host.ends_with(".githubusercontent.com")
        || (host.starts_with("github-production-release-asset-")
            && host.ends_with(".s3.amazonaws.com"))
}

fn parse_semver_like(value: &str) -> Option<semver::Version> {
    let trimmed = value.trim().trim_start_matches('v');
    if let Ok(version) = semver::Version::parse(trimmed) {
        return Some(version);
    }
    let parts: Vec<&str> = trimmed.split('.').collect();
    if parts.len() == 4
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    {
        let compacted = format!("{}.{}.{}", parts[0], parts[1], parts[2]);
        return semver::Version::parse(&compacted).ok();
    }
    None
}

fn version_from_asset_name(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    if !(lower.ends_with("-setup.exe") || lower.ends_with(".msi") || lower.ends_with(".exe")) {
        return None;
    }
    if !lower.contains("engine") {
        return None;
    }
    let mut best: Option<(semver::Version, String)> = None;
    for token in name
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .filter(|token| !token.is_empty())
    {
        if let Some(version) = parse_semver_like(token) {
            let label = version.to_string();
            if best.as_ref().is_none_or(|(current, _)| version > *current) {
                best = Some((version, label));
            }
        }
    }
    best.map(|(_, label)| label)
}

fn engine_installer_url_allowed(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed.host_str() == Some("github.com")
        && parsed
            .path()
            .to_ascii_lowercase()
            .starts_with("/iireborn/iiengine/releases/download/")
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.port().is_none()
        && parsed.fragment().is_none()
}

fn pick_latest_from_releases(payload: &[serde_json::Value]) -> EngineUpdateStatus {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let current = parse_semver_like(&current_version);
    let mut best: Option<(semver::Version, String, Option<String>, String)> = None;

    for release in payload {
        if release
            .get("draft")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            continue;
        }
        let release_url = release
            .get("html_url")
            .and_then(|value| value.as_str())
            .unwrap_or(RELEASES_PAGE)
            .to_string();
        let tag_version = release
            .get("tag_name")
            .and_then(|value| value.as_str())
            .and_then(parse_semver_like);
        let assets = release
            .get("assets")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();

        let mut asset_pick: Option<(semver::Version, String, String)> = None;
        for asset in &assets {
            let name = asset
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let Some(label) = version_from_asset_name(name) else {
                continue;
            };
            let Some(version) = parse_semver_like(&label) else {
                continue;
            };
            let Some(url) = asset
                .get("browser_download_url")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| engine_installer_url_allowed(value))
            else {
                continue;
            };
            if asset_pick
                .as_ref()
                .is_none_or(|(current, _, _)| version > *current)
            {
                asset_pick = Some((version, label, url.to_string()));
            }
        }

        if let Some((version, label, url)) = asset_pick {
            if best
                .as_ref()
                .is_none_or(|(current, _, _, _)| version > *current)
            {
                best = Some((version, label, Some(url), release_url));
            }
            continue;
        }

        if let Some(version) = tag_version {
            let label = version.to_string();
            if best
                .as_ref()
                .is_none_or(|(current, _, _, _)| version > *current)
            {
                best = Some((version, label, None, release_url));
            }
        }
    }

    let Some((latest, latest_label, download_url, release_url)) = best else {
        return EngineUpdateStatus {
            current_version: current_version.clone(),
            latest_version: None,
            outdated: false,
            download_url: None,
            release_url: Some(RELEASES_PAGE.into()),
            can_install: false,
            detail: format!(
                "ii Engine {current_version}. No published installer version was found on GitHub Releases yet."
            ),
        };
    };

    let outdated = current
        .as_ref()
        .map(|value| latest > *value)
        .unwrap_or(false);
    let can_install = outdated && download_url.is_some();
    let detail = if outdated {
        if can_install {
            format!("ii Engine {current_version} is behind {latest_label}. An installer is ready to download.")
        } else {
            format!(
                "ii Engine {current_version} is behind {latest_label}, but no setup.exe/msi asset was published on that release."
            )
        }
    } else {
        format!(
            "ii Engine {current_version} matches the newest published release ({latest_label})."
        )
    };

    EngineUpdateStatus {
        current_version,
        latest_version: Some(latest_label),
        outdated,
        download_url,
        release_url: Some(release_url),
        can_install,
        detail,
    }
}

#[tauri::command]
pub async fn check_engine_update() -> Result<EngineUpdateStatus, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("ii-Engine/0.2.2")
        .build()
        .map_err(|_| "Cannot initialize Engine update client")?;
    let bust = format!(
        "{}?per_page=15&_ts={}",
        RELEASES_API,
        chrono::Utc::now().timestamp_millis()
    );
    let response = client
        .get(&bust)
        .header("Accept", "application/vnd.github+json")
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .map_err(|_| "Could not reach ii Engine GitHub releases")?;
    if response.status().as_u16() == 404 {
        return Ok(EngineUpdateStatus {
            current_version: env!("CARGO_PKG_VERSION").into(),
            latest_version: None,
            outdated: false,
            download_url: None,
            release_url: Some(RELEASES_PAGE.into()),
            can_install: false,
            detail: format!(
                "ii Engine {}. GitHub Releases are not available for update checks yet.",
                env!("CARGO_PKG_VERSION")
            ),
        });
    }
    let payload = response
        .error_for_status()
        .map_err(|_| "ii Engine GitHub releases returned an error")?
        .json::<Vec<serde_json::Value>>()
        .await
        .map_err(|_| "ii Engine GitHub releases payload was not valid JSON")?;
    Ok(pick_latest_from_releases(&payload))
}

#[tauri::command]
pub async fn download_engine_installer(
    app: AppHandle,
    download_url: String,
) -> Result<String, String> {
    if !engine_installer_url_allowed(&download_url) {
        return Err("Engine installer URL left the official GitHub releases host".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
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
        .map_err(|_| "Cannot initialize Engine installer download")?;
    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|_| "Engine installer download failed")?
        .error_for_status()
        .map_err(|_| "Engine installer download was rejected")?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_INSTALLER_BYTES as u64)
    {
        return Err("Engine installer exceeds the approved size limit".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Engine installer download was interrupted")?;
    if bytes.len() > MAX_INSTALLER_BYTES || bytes.len() < 64 {
        return Err("Engine installer size is outside the approved range".into());
    }
    let file_name = Path::new(
        reqwest::Url::parse(&download_url)
            .ok()
            .and_then(|url| {
                url.path_segments()
                    .and_then(|mut parts| parts.next_back().map(|value| value.to_string()))
            })
            .unwrap_or_else(|| "ii-Engine-setup.exe".into())
            .as_str(),
    )
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or("ii-Engine-setup.exe")
    .chars()
    .filter(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '_' | ' '))
    .take(120)
    .collect::<String>();
    if file_name.is_empty() {
        return Err("Engine installer filename is invalid".into());
    }
    let downloads = app
        .path()
        .download_dir()
        .map_err(|_| "Cannot resolve the Windows Downloads folder")?;
    fs::create_dir_all(&downloads).map_err(|_| "Cannot create the Downloads folder")?;
    let destination = downloads.join(&file_name);
    let mut file = File::create(&destination).map_err(|_| "Cannot create the installer file")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not save the Engine installer")?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_local_path(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Installer path is empty".into());
    }
    let candidate = Path::new(trimmed);
    if !candidate.is_file() {
        return Err("Installer file was not found".into());
    }
    open::that(candidate).map_err(|_| "Could not open the downloaded installer".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_newer_setup_asset() {
        let payload = vec![
            serde_json::json!({
                "draft": false,
                "tag_name": "Engine_PreBeta",
                "html_url": "https://github.com/iireborn/iiEngine/releases/tag/Engine_PreBeta",
                "assets": []
            }),
            serde_json::json!({
                "draft": false,
                "tag_name": "v0.3.0",
                "html_url": "https://github.com/iireborn/iiEngine/releases/tag/v0.3.0",
                "assets": [{
                    "name": "ii Engine_0.3.0_x64-setup.exe",
                    "browser_download_url": "https://github.com/iireborn/iiEngine/releases/download/v0.3.0/ii%20Engine_0.3.0_x64-setup.exe"
                }]
            }),
        ];
        let status = pick_latest_from_releases(&payload);
        assert_eq!(status.latest_version.as_deref(), Some("0.3.0"));
        assert!(status.outdated);
        assert!(status.can_install);
        assert!(status
            .download_url
            .as_deref()
            .unwrap_or_default()
            .contains("0.3.0"));
    }

    #[test]
    fn current_build_is_not_outdated_without_newer_assets() {
        let payload = vec![serde_json::json!({
            "draft": false,
            "tag_name": "Engine_PreBeta",
            "html_url": "https://github.com/iireborn/iiEngine/releases/tag/Engine_PreBeta",
            "assets": []
        })];
        let status = pick_latest_from_releases(&payload);
        assert!(!status.outdated);
        assert!(!status.can_install);
        assert!(status.detail.contains(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn parses_version_from_installer_name() {
        assert_eq!(
            version_from_asset_name("ii Engine_0.2.3_x64-setup.exe").as_deref(),
            Some("0.2.3")
        );
        assert_eq!(
            version_from_asset_name("ii Engine_0.2.3_x64_en-US.msi").as_deref(),
            Some("0.2.3")
        );
        assert!(version_from_asset_name("notes.txt").is_none());
    }
}
