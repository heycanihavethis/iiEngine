use crate::{discovery, paths::scoped_path};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

const SCHEMA: u32 = 1;
const FLAG_REL: &str = "iisStupidMenu/ii-engine-tracker.json";
const PRESENCE_REL: &str = "iisStupidMenu/ii-engine-presence.json";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct TrackerFlag {
    pub schema_version: u32,
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct LocalPresence {
    pub schema_version: u32,
    pub username: String,
    pub room_code: String,
    pub in_room: bool,
    pub updated_at: String,
}

fn validated_game(value: &str) -> Result<PathBuf, String> {
    let game = fs::canonicalize(value).map_err(|_| "Cannot resolve the Gorilla Tag folder")?;
    if !discovery::validate_game(&game).valid {
        return Err("Select a valid Gorilla Tag installation".into());
    }
    Ok(game)
}

fn menu_dir(game: &Path) -> Result<PathBuf, String> {
    let folder = scoped_path(game, Path::new("iisStupidMenu"))
        .map_err(|_| "The ii Reborn Menu folder has an unsafe path")?;
    fs::create_dir_all(&folder).map_err(|_| "Could not create the ii Reborn Menu folder")?;
    Ok(folder)
}

fn flag_path(game: &Path) -> Result<PathBuf, String> {
    scoped_path(game, Path::new(FLAG_REL)).map_err(|_| "The tracker flag path is unsafe".into())
}

fn presence_path(game: &Path) -> Result<PathBuf, String> {
    scoped_path(game, Path::new(PRESENCE_REL)).map_err(|_| "The presence path is unsafe".into())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    {
        let mut file = File::create(&temporary).map_err(|_| "Could not stage tracker file")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not write tracker file")?;
    }
    fs::rename(&temporary, path).map_err(|_| "Could not publish tracker file")?;
    Ok(())
}

#[tauri::command]
pub fn get_self_tracker(game_path: String) -> Result<TrackerFlag, String> {
    let game = validated_game(&game_path)?;
    let path = flag_path(&game)?;
    if !path.is_file() {
        return Ok(TrackerFlag {
            schema_version: SCHEMA,
            enabled: false,
        });
    }
    let raw = fs::read_to_string(&path).map_err(|_| "Could not read tracker flag")?;
    let parsed =
        serde_json::from_str::<TrackerFlag>(&raw).map_err(|_| "Tracker flag is invalid")?;
    if parsed.schema_version != SCHEMA {
        return Err("Unsupported tracker schema".into());
    }
    Ok(parsed)
}

#[tauri::command]
pub fn set_self_tracker(game_path: String, enabled: bool) -> Result<TrackerFlag, String> {
    let game = validated_game(&game_path)?;
    menu_dir(&game)?;
    let path = flag_path(&game)?;
    if !enabled {
        if path.is_file() {
            fs::remove_file(&path).map_err(|_| "Could not clear tracker flag")?;
        }
        let temporary = path.with_extension("json.tmp");
        if temporary.is_file() {
            let _ = fs::remove_file(temporary);
        }
        return Ok(TrackerFlag {
            schema_version: SCHEMA,
            enabled: false,
        });
    }
    let flag = TrackerFlag {
        schema_version: SCHEMA,
        enabled: true,
    };
    let bytes = serde_json::to_vec_pretty(&flag).map_err(|_| "Could not encode tracker flag")?;
    write_atomic(&path, &bytes)?;
    Ok(flag)
}

#[tauri::command]
pub fn read_local_presence(game_path: String) -> Result<Option<LocalPresence>, String> {
    let game = validated_game(&game_path)?;
    let path = presence_path(&game)?;
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|_| "Could not read presence file")?;
    let parsed =
        serde_json::from_str::<LocalPresence>(&raw).map_err(|_| "Presence file is invalid")?;
    if parsed.schema_version != SCHEMA {
        return Err("Unsupported presence schema".into());
    }
    if parsed.username.len() > 100 || parsed.room_code.len() > 32 || parsed.updated_at.len() > 64 {
        return Err("Presence file fields are invalid".into());
    }
    Ok(Some(parsed))
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
    fn enables_disables_and_reads_presence() {
        let (_keep, game) = fake_game();
        let path = game.display().to_string();
        assert!(!get_self_tracker(path.clone()).unwrap().enabled);
        assert!(set_self_tracker(path.clone(), true).unwrap().enabled);
        let raw = fs::read_to_string(flag_path(&game).unwrap()).unwrap();
        assert!(raw.contains("\"enabled\": true"));
        assert!(raw.contains("\"schema_version\": 1"));
        let presence = LocalPresence {
            schema_version: 1,
            username: "Player".into(),
            room_code: "ABCD".into(),
            in_room: true,
            updated_at: "2026-09-23T16:00:00.0000000+00:00".into(),
        };
        write_atomic(
            &presence_path(&game).unwrap(),
            &serde_json::to_vec_pretty(&presence).unwrap(),
        )
        .unwrap();
        let read = read_local_presence(path.clone()).unwrap().unwrap();
        assert_eq!(read.room_code, "ABCD");
        assert!(!set_self_tracker(path, false).unwrap().enabled);
        assert!(!flag_path(&game).unwrap().is_file());
    }
}
