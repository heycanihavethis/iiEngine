use crate::{discovery, paths::scoped_path};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

const FILENAME: &str = "ii-engine-bridge.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct BridgeFile {
    pub schema_version: u32,
    pub api_base: String,
    pub ticket: String,
    pub pro: bool,
    pub features: Vec<String>,
    pub issued_at: String,
    pub expires_at: String,
}

fn validated_game(value: &str) -> Result<PathBuf, String> {
    let game = fs::canonicalize(value).map_err(|_| "Cannot resolve the Gorilla Tag folder")?;
    if !discovery::validate_game(&game).valid {
        return Err("Select a valid Gorilla Tag installation".into());
    }
    Ok(game)
}

fn bridge_path(game: &Path) -> Result<PathBuf, String> {
    let folder = scoped_path(game, Path::new("iisStupidMenu"))
        .map_err(|_| "The ii Reborn Menu folder has an unsafe path")?;
    fs::create_dir_all(&folder).map_err(|_| "Could not create the ii Reborn Menu folder")?;
    scoped_path(game, Path::new(&format!("iisStupidMenu/{FILENAME}")))
        .map_err(|_| "The bridge claim path is unsafe".into())
}

#[tauri::command]
pub fn write_menu_bridge(game_path: String, payload: BridgeFile) -> Result<String, String> {
    if payload.schema_version != 1 {
        return Err("Unsupported menu bridge schema".into());
    }
    if payload.ticket.len() < 40 || payload.ticket.len() > 4096 {
        return Err("Menu bridge ticket is invalid".into());
    }
    if payload.api_base.is_empty() || payload.api_base.len() > 300 {
        return Err("Menu bridge API base is invalid".into());
    }
    if !(payload.api_base.starts_with("https://")
        || (cfg!(debug_assertions)
            && (payload.api_base.starts_with("http://127.0.0.1")
                || payload.api_base.starts_with("http://localhost"))))
    {
        return Err("Menu bridge API base must be the configured HTTPS backend".into());
    }
    if payload.features.len() > 32 || payload.features.iter().any(|item| item.len() > 64) {
        return Err("Menu bridge features are invalid".into());
    }
    let game = validated_game(&game_path)?;
    let path = bridge_path(&game)?;
    let bytes = serde_json::to_vec_pretty(&payload).map_err(|_| "Could not encode bridge claim")?;
    let temporary = path.with_extension("json.tmp");
    {
        let mut file =
            File::create(&temporary).map_err(|_| "Could not stage the menu bridge claim")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not write the menu bridge claim")?;
    }
    fs::rename(&temporary, &path).map_err(|_| "Could not publish the menu bridge claim")?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn clear_menu_bridge(game_path: String) -> Result<(), String> {
    let game = validated_game(&game_path)?;
    let path = bridge_path(&game)?;
    if path.is_file() {
        fs::remove_file(&path).map_err(|_| "Could not clear the menu bridge claim")?;
    }
    let temporary = path.with_extension("json.tmp");
    if temporary.is_file() {
        let _ = fs::remove_file(temporary);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fake_game() -> (tempfile::TempDir, PathBuf) {
        let root = tempdir().unwrap();
        let game = root.path().join("Gorilla Tag");
        fs::create_dir_all(game.join("Gorilla Tag_Data")).unwrap();
        File::create(game.join("Gorilla Tag.exe")).unwrap();
        File::create(game.join("UnityPlayer.dll")).unwrap();
        (root, game)
    }

    #[test]
    fn writes_and_clears_bridge_file() {
        let (_keep, game) = fake_game();
        let written = write_menu_bridge(
            game.display().to_string(),
            BridgeFile {
                schema_version: 1,
                api_base: "https://ii-engine-api-production.up.railway.app".into(),
                ticket: "a".repeat(48),
                pro: true,
                features: vec!["engine_pro_mods".into()],
                issued_at: "2026-09-23T00:00:00Z".into(),
                expires_at: "2026-09-23T12:00:00Z".into(),
            },
        )
        .unwrap();
        let path = PathBuf::from(written);
        assert!(path.is_file());
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"pro\": true"));
        assert!(text.contains("engine_pro_mods"));
        clear_menu_bridge(game.display().to_string()).unwrap();
        assert!(!path.is_file());
    }
}
