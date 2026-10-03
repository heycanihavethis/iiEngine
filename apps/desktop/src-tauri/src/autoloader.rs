use crate::{backup, discovery, health, paths::scoped_path};
use chrono::Utc;
use rand::Rng;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Write,
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const MAX_MOD_BYTES: usize = 25 * 1024 * 1024;

#[derive(Serialize)]
pub struct InstalledMod {
    filename: String,
    relative_path: String,
    byte_size: u64,
    sha256: String,
    enabled: bool,
}

fn safe_filename(value: &str) -> bool {
    let path = Path::new(value);
    let stem = value.split('.').next().unwrap_or("").to_ascii_uppercase();
    path.components()
        .all(|part| matches!(part, Component::Normal(_)))
        && path.file_name().and_then(|name| name.to_str()) == Some(value)
        && value.len() <= 180
        && value.to_ascii_lowercase().ends_with(".dll")
        && !value.chars().any(char::is_control)
        && !value.contains([':', '<', '>', '"', '|', '?', '*', '/', '\\'])
        && !value.ends_with(['.', ' '])
        && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn validated_game(value: &str) -> Result<PathBuf, String> {
    let game = fs::canonicalize(value).map_err(|_| "Cannot resolve the Gorilla Tag folder")?;
    if !discovery::validate_game(&game).valid {
        return Err("Select a valid Gorilla Tag installation".into());
    }
    Ok(game)
}

fn plugins(game: &Path) -> Result<PathBuf, String> {
    let path = scoped_path(game, Path::new("BepInEx/plugins"))
        .map_err(|_| "The plugins folder has an unsafe path")?;
    fs::create_dir_all(&path).map_err(|_| "Could not create the BepInEx plugins folder")?;
    Ok(path)
}

fn allowed_download(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid trusted mod download URL")?;
    let production = url.scheme() == "https"
        && url.host_str() == Some("ii-engine-api-production.up.railway.app")
        && url.username().is_empty()
        && url.password().is_none();
    let local = cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"));
    if !production && !local {
        return Err("Trusted mods must come from the configured ii Engine backend".into());
    }
    Ok(url)
}

fn backup_existing(
    app: &AppHandle,
    source: &Path,
    filename: &str,
) -> Result<Option<PathBuf>, String> {
    if !source.is_file() {
        return Ok(None);
    }
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot resolve the ii Engine data folder")?
        .join("mod-backups");
    fs::create_dir_all(&root).map_err(|_| "Could not create the mod backup folder")?;
    let stamp = Utc::now().format("%Y%m%d-%H%M%S-%3f");
    let destination = root.join(format!("{stamp}-{filename}"));
    fs::copy(source, &destination).map_err(|_| "Could not back up the existing mod")?;
    Ok(Some(destination))
}

fn restore_backup(backup: Option<&Path>, target: &Path) {
    if let Some(backup) = backup {
        let _ = fs::copy(backup, target);
    } else {
        let _ = fs::remove_file(target);
    }
}

fn walk_plugins(
    root: &Path,
    relative: &Path,
    result: &mut Vec<InstalledMod>,
) -> Result<(), String> {
    let directory = if relative.as_os_str().is_empty() {
        root.to_path_buf()
    } else {
        scoped_path(root, relative).map_err(|_| "Plugins contain an unsafe path")?
    };
    for entry in fs::read_dir(directory).map_err(|_| "Could not read installed plugins")? {
        let entry = entry.map_err(|_| "Could not inspect an installed plugin")?;
        let next = relative.join(entry.file_name());
        let path = scoped_path(root, &next).map_err(|_| "Plugins contain an unsafe path")?;
        if path.is_dir() {
            if next.components().count() <= 5 {
                walk_plugins(root, &next, result)?;
            }
        } else if path.is_file() {
            let lower = next.to_string_lossy().to_ascii_lowercase();
            if !lower.ends_with(".dll") && !lower.ends_with(".dll.disabled") {
                continue;
            }
            let (byte_size, sha256) = backup::hash_file(&path)?;
            result.push(InstalledMod {
                filename: entry.file_name().to_string_lossy().into_owned(),
                relative_path: next.to_string_lossy().replace('\\', "/"),
                byte_size,
                sha256,
                enabled: lower.ends_with(".dll"),
            });
        }
    }
    Ok(())
}

#[tauri::command]
pub fn list_installed_mods(game_path: String) -> Result<Vec<InstalledMod>, String> {
    let game = validated_game(&game_path)?;
    let root = plugins(&game)?;
    let mut result = Vec::new();
    walk_plugins(&root, Path::new(""), &mut result)?;
    result.sort_by_key(|item| item.relative_path.to_ascii_lowercase());
    Ok(result)
}

#[tauri::command]
pub async fn install_trusted_mod(
    app: AppHandle,
    game_path: String,
    filename: String,
    sha256: String,
    download_url: String,
) -> Result<InstalledMod, String> {
    if health::running() {
        return Err("Close Gorilla Tag before changing installed mods".into());
    }
    if !safe_filename(&filename)
        || sha256.len() != 64
        || !sha256.bytes().all(|value| value.is_ascii_hexdigit())
    {
        return Err("The trusted mod metadata is invalid".into());
    }
    let url = allowed_download(&download_url)?;
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|_| "Could not download the trusted mod")?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_MOD_BYTES as u64)
    {
        return Err("The trusted mod download was rejected".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Could not read the trusted mod download")?;
    if bytes.is_empty() || bytes.len() > MAX_MOD_BYTES || !bytes.starts_with(b"MZ") {
        return Err("The downloaded mod is not a valid bounded Windows DLL".into());
    }
    let actual = hex::encode(Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(&sha256) {
        return Err("The trusted mod checksum did not match the catalog".into());
    }
    let game = validated_game(&game_path)?;
    let root = plugins(&game)?;
    let target = scoped_path(&root, Path::new(&filename))
        .map_err(|_| "The trusted mod destination is unsafe")?;
    let backup = backup_existing(&app, &target, &filename)?;
    let temporary = root.join(format!(
        ".ii-engine-{}.tmp",
        rand::thread_rng().gen::<u64>()
    ));
    let mut file = File::create_new(&temporary).map_err(|_| "Could not stage the trusted mod")?;
    if file
        .write_all(&bytes)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        let _ = fs::remove_file(&temporary);
        return Err("Could not stage the trusted mod".into());
    }
    if target.exists() {
        fs::remove_file(&target).map_err(|_| "Could not replace the installed mod")?;
    }
    if fs::rename(&temporary, &target).is_err() {
        restore_backup(backup.as_deref(), &target);
        let _ = fs::remove_file(&temporary);
        return Err("Could not install the trusted mod; the previous file was restored".into());
    }
    let (byte_size, installed_hash) = match backup::hash_file(&target) {
        Ok(value) => value,
        Err(error) => {
            restore_backup(backup.as_deref(), &target);
            return Err(format!("{error}; the previous file was restored"));
        }
    };
    if !installed_hash.eq_ignore_ascii_case(&sha256) {
        restore_backup(backup.as_deref(), &target);
        return Err(
            "The installed mod failed final verification; the previous file was restored".into(),
        );
    }
    Ok(InstalledMod {
        filename,
        relative_path: target
            .strip_prefix(&root)
            .unwrap_or(&target)
            .to_string_lossy()
            .replace('\\', "/"),
        byte_size,
        sha256: installed_hash,
        enabled: true,
    })
}

#[tauri::command]
pub fn import_local_mod(
    app: AppHandle,
    game_path: String,
    filename: String,
    bytes: Vec<u8>,
) -> Result<InstalledMod, String> {
    if health::running() {
        return Err("Close Gorilla Tag before changing installed mods".into());
    }
    if !safe_filename(&filename)
        || bytes.is_empty()
        || bytes.len() > MAX_MOD_BYTES
        || !bytes.starts_with(b"MZ")
    {
        return Err("Choose a valid Windows mod DLL smaller than 25 MB".into());
    }
    let game = validated_game(&game_path)?;
    let root = plugins(&game)?;
    let target = scoped_path(&root, Path::new(&filename))
        .map_err(|_| "The local mod destination is unsafe")?;
    let backup = backup_existing(&app, &target, &filename)?;
    let temporary = root.join(format!(
        ".ii-engine-local-{}.tmp",
        rand::thread_rng().gen::<u64>()
    ));
    let mut file = File::create_new(&temporary).map_err(|_| "Could not stage the local mod")?;
    if file
        .write_all(&bytes)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        let _ = fs::remove_file(&temporary);
        return Err("Could not stage the local mod".into());
    }
    if target.exists() {
        fs::remove_file(&target).map_err(|_| "Could not replace the installed mod")?;
    }
    if fs::rename(&temporary, &target).is_err() {
        restore_backup(backup.as_deref(), &target);
        let _ = fs::remove_file(&temporary);
        return Err("Could not import the local mod; the previous file was restored".into());
    }
    let (byte_size, sha256) = backup::hash_file(&target)?;
    Ok(InstalledMod {
        filename,
        relative_path: target
            .strip_prefix(&root)
            .unwrap_or(&target)
            .to_string_lossy()
            .replace('\\', "/"),
        byte_size,
        sha256,
        enabled: true,
    })
}

#[tauri::command]
pub fn set_installed_mod_enabled(
    game_path: String,
    relative_path: String,
    enabled: bool,
) -> Result<(), String> {
    if health::running() {
        return Err("Close Gorilla Tag before changing installed mods".into());
    }
    let relative = Path::new(&relative_path);
    if relative.as_os_str().is_empty()
        || relative.components().count() > 6
        || !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("The installed mod path is invalid".into());
    }
    let lower = relative_path.to_ascii_lowercase();
    if !lower.ends_with(".dll") && !lower.ends_with(".dll.disabled") {
        return Err("Only plugin DLLs can be enabled or disabled".into());
    }
    let game = validated_game(&game_path)?;
    let root = plugins(&game)?;
    let source = scoped_path(&root, relative).map_err(|_| "The installed mod path is unsafe")?;
    if !source.is_file() {
        return Err("That installed mod was not found".into());
    }
    let destination_relative = if enabled {
        if !lower.ends_with(".disabled") {
            return Err("That mod is already enabled".into());
        }
        relative_path[..relative_path.len() - ".disabled".len()].to_owned()
    } else {
        if lower.ends_with(".disabled") {
            return Err("That mod is already disabled".into());
        }
        format!("{relative_path}.disabled")
    };
    let destination = scoped_path(&root, Path::new(&destination_relative))
        .map_err(|_| "The mod destination is unsafe")?;
    if destination.exists() {
        return Err("A plugin with the target name already exists".into());
    }
    fs::rename(source, destination).map_err(|_| "Could not change the mod state".to_string())
}

#[tauri::command]
pub fn remove_installed_mod(
    app: AppHandle,
    game_path: String,
    relative_path: String,
) -> Result<(), String> {
    if health::running() {
        return Err("Close Gorilla Tag before changing installed mods".into());
    }
    let relative = Path::new(&relative_path);
    if relative.as_os_str().is_empty()
        || relative.components().count() > 6
        || !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        || (!relative_path.to_ascii_lowercase().ends_with(".dll")
            && !relative_path
                .to_ascii_lowercase()
                .ends_with(".dll.disabled"))
    {
        return Err("The installed mod path is invalid".into());
    }
    let game = validated_game(&game_path)?;
    let root = plugins(&game)?;
    let target = scoped_path(&root, relative).map_err(|_| "The installed mod path is unsafe")?;
    if !target.is_file() {
        return Err("That installed mod was not found".into());
    }
    let filename = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("The installed mod filename is invalid")?;
    backup_existing(&app, &target, filename)?;
    fs::remove_file(target).map_err(|_| "Could not remove the installed mod".to_string())
}

#[tauri::command]
pub fn backup_plugins_snapshot(app: AppHandle, game_path: String) -> Result<String, String> {
    let game = validated_game(&game_path)?;
    let source = plugins(&game)?;
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot resolve ii Engine local data directory")?;
    let stamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let destination = root.join("kraken-safety").join(format!("plugins-{stamp}"));
    fs::create_dir_all(&destination)
        .map_err(|_| "Could not create the Kraken safety backup folder")?;
    copy_dir(&source, &destination)?;
    Ok(destination.to_string_lossy().into_owned())
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|_| "Could not create backup directory")?;
    for entry in fs::read_dir(from).map_err(|_| "Could not read plugins for backup")? {
        let entry = entry.map_err(|_| "Could not read a plugins entry")?;
        let src = entry.path();
        let name = entry.file_name();
        let dest = to.join(&name);
        if src.is_dir() {
            copy_dir(&src, &dest)?;
        } else if src.is_file() {
            fs::copy(&src, &dest)
                .map_err(|_| "Could not copy a plugin file into the safety backup")?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_dll_filenames_are_installable() {
        assert!(safe_filename("Trusted Mod.dll"));
        for invalid in [
            "../mod.dll",
            "folder/mod.dll",
            "mod.exe",
            "NUL.dll",
            "mod.dll ",
            "mod\n.dll",
        ] {
            assert!(!safe_filename(invalid));
        }
    }
}
