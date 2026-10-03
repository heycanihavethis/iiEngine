use crate::{backup, baseline, discovery, metadata, paths::scoped_path};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, path::Path, time::UNIX_EPOCH};

#[derive(Serialize)]
pub struct Check {
    pub name: String,
    pub status: &'static str,
    pub detail: String,
}
#[derive(Serialize)]
pub struct PluginFile {
    pub name: String,
    pub size: u64,
    pub sha256: String,
    pub modified_at: u64,
    pub signer: Option<String>,
    pub menu: bool,
    pub plugins: Vec<metadata::Plugin>,
}
#[derive(Serialize)]
pub struct HealthReport {
    pub status: &'static str,
    pub checks: Vec<Check>,
    pub files: Vec<PluginFile>,
}

pub fn running() -> bool {
    let system = sysinfo::System::new_all();
    system.processes().values().any(|p| {
        p.name()
            .to_string_lossy()
            .eq_ignore_ascii_case("Gorilla Tag.exe")
    })
}

#[tauri::command]
pub fn is_game_running() -> bool {
    running()
}

fn check(name: &str, status: &'static str, detail: impl Into<String>) -> Check {
    Check {
        name: name.into(),
        status,
        detail: detail.into(),
    }
}

fn version_parts(value: &str) -> Option<Vec<u64>> {
    let parts: Vec<u64> = value
        .trim()
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse::<u64>().ok())
        .collect::<Option<Vec<_>>>()?;
    if parts.is_empty() || parts.len() > 6 {
        None
    } else {
        Some(parts)
    }
}

fn cmp_version_parts(left: &[u64], right: &[u64]) -> std::cmp::Ordering {
    let width = left.len().max(right.len());
    for index in 0..width {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        match a.cmp(&b) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

fn loader_file_check(
    root: &Path,
    relative: &str,
    expected_size: u64,
    expected_hash: &str,
) -> Check {
    let path = match scoped_path(root, Path::new(relative)) {
        Ok(path) => path,
        Err(_) => return check(relative, "Error", "Unsafe loader path"),
    };
    if !path.is_file() {
        return check(
            relative,
            "Error",
            "Required approved loader file is missing",
        );
    }
    if let Ok(actual) = backup::hash_file(&path) {
        if actual == (expected_size, expected_hash.to_owned()) {
            return check(
                relative,
                "Healthy",
                format!("Matches approved {} baseline", baseline::ID),
            );
        }
    }
    match fs::read(&path) {
        Ok(bytes) if required_loader_bytes_ok(relative, &bytes) => check(
            relative,
            "Healthy",
            format!(
                "Present (live BepInEx install; backup baseline {})",
                baseline::VERSION
            ),
        ),
        Ok(_) => check(
            relative,
            "Error",
            format!(
                "Present but does not match approved {} baseline or live structural checks",
                baseline::VERSION
            ),
        ),
        Err(_) => check(
            relative,
            "Error",
            format!("Antivirus is locking {relative} for verification."),
        ),
    }
}

fn required_loader_bytes_ok(relative: &str, bytes: &[u8]) -> bool {
    if relative.eq_ignore_ascii_case("doorstop_config.ini") {
        if bytes.len() < 80 || bytes.len() > 64_000 {
            return false;
        }
        let text = String::from_utf8_lossy(bytes).to_ascii_lowercase();
        return text.contains("doorstop") || text.contains("target_assembly");
    }
    bytes.len() >= 8_192 && bytes.len() <= 8_000_000 && bytes.len() >= 2 && &bytes[..2] == b"MZ"
}

fn loader_version_check(version: Option<&str>) -> Check {
    let Some(found) = version.map(str::trim).filter(|value| !value.is_empty()) else {
        return check(
            "Loader version",
            "Error",
            format!(
                "Expected BepInEx 5.x LTS (backup {}); found invalid managed metadata",
                baseline::VERSION
            ),
        );
    };
    if found.starts_with("6.") {
        return check(
            "Loader version",
            "Error",
            format!("BepInEx 6 is not supported; expected 5.x LTS (found {found})"),
        );
    }
    if !found.starts_with("5.") {
        return check(
            "Loader version",
            "Error",
            format!(
                "Expected BepInEx 5.x LTS (backup {}); found {found}",
                baseline::VERSION
            ),
        );
    }
    let status_detail = match (version_parts(found), version_parts(baseline::VERSION)) {
        (Some(found_parts), Some(baseline_parts))
            if cmp_version_parts(&found_parts, &baseline_parts) == std::cmp::Ordering::Less =>
        {
            (
                "Warning",
                format!(
                    "BepInEx {found} is older than the approved backup baseline {}",
                    baseline::VERSION
                ),
            )
        }
        _ => (
            "Healthy",
            format!(
                "BepInEx {found} (5.x LTS; backup baseline {})",
                baseline::VERSION
            ),
        ),
    };
    check("Loader version", status_detail.0, status_detail.1)
}

fn plugins(
    root: &Path,
    relative: &Path,
    files: &mut Vec<PluginFile>,
    checks: &mut Vec<Check>,
    depth: usize,
) -> Result<(), String> {
    if depth > 12 || files.len() > 1000 {
        return Err("Plugin scan limit reached".into());
    }
    let directory = scoped_path(root, relative)
        .map_err(|_| "Plugin path contains an unsafe link or filename")?;
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(directory).map_err(|_| "Cannot read plugins directory")? {
        let entry = entry.map_err(|_| "Cannot read plugin entry")?;
        let rel = relative.join(entry.file_name());
        let path = scoped_path(root, &rel)
            .map_err(|_| "Plugin path contains an unsafe link or filename")?;
        if path.is_dir() {
            plugins(root, &rel, files, checks, depth + 1)?;
            continue;
        }
        let name = rel.to_string_lossy().into_owned();
        let meta = fs::metadata(&path).map_err(|_| "Cannot read plugin metadata")?;
        if meta.len() == 0 {
            checks.push(check(&name, "Warning", "Empty or incomplete file"));
        }
        let ext = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        if ["zip", "part", "tmp"].contains(&ext.as_str()) {
            checks.push(check(
                &name,
                "Warning",
                "Misplaced archive or incomplete download",
            ));
        }
        if ext != "dll" {
            continue;
        }
        if meta.len() > 100_000_000 {
            checks.push(check(
                &name,
                "Warning",
                "DLL exceeds static inspection size limit",
            ));
            continue;
        }
        let bytes = fs::read(&path).map_err(|_| "Cannot read plugin DLL")?;
        let assembly = metadata::inspect(&bytes);
        let detected = assembly.map(|a| a.plugins).unwrap_or_default();
        let menu = detected
            .iter()
            .any(|plugin| metadata::is_menu_guid(&plugin.guid));
        files.push(PluginFile {
            name,
            size: meta.len(),
            sha256: hex::encode(Sha256::digest(&bytes)),
            modified_at: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|t| t.as_secs())
                .unwrap_or(0),
            signer: None,
            menu,
            plugins: detected,
        });
    }
    Ok(())
}

pub fn inspect(root: &Path) -> Result<HealthReport, String> {
    scoped_path(root, Path::new("BepInEx"))
        .map_err(|_| "Game directory contains a link, junction, or invalid path")?;
    let candidate = discovery::validate_game(root);
    if !candidate.valid {
        return Err(format!(
            "Select a Gorilla Tag installation. Missing: {}",
            candidate.missing.join(", ")
        ));
    }
    let mut checks = vec![check(
        "Game installation",
        if candidate.valid { "Healthy" } else { "Error" },
        if candidate.valid {
            "Required game files present".into()
        } else {
            format!("Missing: {}", candidate.missing.join(", "))
        },
    )];
    checks.push(check(
        "Game process",
        if running() { "Error" } else { "Healthy" },
        "Game must be closed before any installation or repair",
    ));
    for (relative, expected_size, expected_hash) in baseline::REQUIRED_FILES {
        checks.push(loader_file_check(
            root,
            relative,
            expected_size,
            expected_hash,
        ));
    }
    for relative in [
        "BepInEx/plugins",
        "BepInEx/config",
        "BepInEx/patchers",
        "iisStupidMenu",
    ] {
        let path =
            scoped_path(root, Path::new(relative)).map_err(|_| "Unsafe configuration directory")?;
        checks.push(check(
            relative,
            if path.is_dir() {
                "Healthy"
            } else if path.exists() {
                "Error"
            } else {
                "Warning"
            },
            if path.is_dir() {
                "Directory is within the selected game root"
            } else {
                "Expected directory is missing or is a file"
            },
        ));
    }
    let loader = scoped_path(root, Path::new("BepInEx/core/BepInEx.dll"))
        .map_err(|_| "Unsafe loader path")?;
    if loader.is_file() {
        let version = fs::read(&loader)
            .ok()
            .and_then(|bytes| metadata::inspect(&bytes).ok())
            .map(|m| m.version);
        checks.push(loader_version_check(version.as_deref()));
    }
    let mut files = Vec::new();
    plugins(
        root,
        Path::new("BepInEx/plugins"),
        &mut files,
        &mut checks,
        0,
    )?;
    let copies = files.iter().filter(|file| file.menu).count();
    checks.push(check(
        "Menu copies",
        if copies == 1 { "Healthy" } else { "Error" },
        format!("{copies} copies identified by managed BepInPlugin GUID metadata"),
    ));
    let extra_dlls = files.iter().filter(|file| !file.menu).count();
    checks.push(check(
        "Release integrity",
        "Healthy",
        if copies == 1 {
            "ii menu DLL is present. Use Repair to match a published release when you want a verified copy."
        } else {
            "No single ii menu DLL yet. Repair installs the selected release."
        },
    ));
    if extra_dlls > 0 {
        checks.push(check(
            "Extra plugins",
            "Healthy",
            format!(
                "{extra_dlls} additional DLL(s) outside the repair catalog. Listed below — not treated as unhealthy."
            ),
        ));
    }
    let status = if checks.iter().any(|c| c.status == "Error") {
        "Error"
    } else if checks.iter().any(|c| c.status == "Warning") {
        "Warning"
    } else {
        "Healthy"
    };
    Ok(HealthReport {
        status,
        checks,
        files,
    })
}

#[derive(Serialize)]
pub struct GameDirEntry {
    pub name: String,
    pub relative: String,
    pub directory: bool,
    pub size: u64,
}

#[tauri::command]
pub fn list_game_directory(
    game_path: String,
    relative: Option<String>,
) -> Result<Vec<GameDirEntry>, String> {
    let game = fs::canonicalize(&game_path).map_err(|_| "Cannot resolve selected game folder")?;
    if !discovery::validate_game(&game).valid {
        return Err("Select a valid Gorilla Tag installation".into());
    }
    let rel = relative.unwrap_or_default().replace('\\', "/");
    let rel = rel.trim_matches('/');
    let directory = if rel.is_empty() {
        game.clone()
    } else {
        scoped_path(&game, Path::new(rel)).map_err(|_| "That folder has an unsafe path")?
    };
    if !directory.is_dir() {
        return Err("That path is not a folder".into());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|_| "Cannot read that folder")? {
        if entries.len() >= 400 {
            break;
        }
        let entry = entry.map_err(|_| "Cannot read a folder entry")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "." || name == ".." {
            continue;
        }
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let path = scoped_path(&game, Path::new(&child_rel))
            .map_err(|_| "A folder entry has an unsafe path")?;
        let meta = match fs::metadata(&path) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        entries.push(GameDirEntry {
            name,
            relative: child_rel.replace('\\', "/"),
            directory: meta.is_dir(),
            size: if meta.is_file() { meta.len() } else { 0 },
        });
    }
    entries.sort_by(|left, right| {
        right
            .directory
            .cmp(&left.directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn health_check(game_path: String) -> Result<HealthReport, String> {
    tauri::async_runtime::spawn_blocking(move || inspect(Path::new(&game_path)))
        .await
        .map_err(|_| "Health worker stopped unexpectedly".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_newer_bepinex_5_loader_version() {
        let check = loader_version_check(Some("5.4.23.5"));
        assert_eq!(check.status, "Healthy");
        assert!(check.detail.contains("5.4.23.5"));
    }

    #[test]
    fn warns_on_older_bepinex_5_loader_version() {
        let check = loader_version_check(Some("5.4.23.0"));
        assert_eq!(check.status, "Warning");
    }

    #[test]
    fn rejects_bepinex_6_loader_version() {
        let check = loader_version_check(Some("6.0.0"));
        assert_eq!(check.status, "Error");
    }
}
