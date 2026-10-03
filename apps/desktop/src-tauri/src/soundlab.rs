use crate::{discovery, health, paths::scoped_path};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Write,
    path::{Component, Path, PathBuf},
};
use tauri::AppHandle;

const MAX_SOUND_BYTES: usize = 40 * 1024 * 1024;
const SOUNDS_REL: &str = "iisStupidMenu/Sounds";
const FX_SETTINGS_REL: &str = "iisStupidMenu/sounds-fx-settings.json";
const PLAYLIST_REL: &str = "iisStupidMenu/EnginePlaylist";
const MAX_PLAYLIST_TRACKS: usize = 40;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SoundFxSettings {
    pub bass: f32,
    pub volume: f32,
    pub speed: f32,
    pub distortion: f32,
    pub pitch: f32,
    pub reverb: f32,
}

#[derive(Serialize)]
pub struct MenuSoundEntry {
    pub filename: String,
    pub byte_size: u64,
    pub enabled: bool,
    pub media: String,
    pub fx: SoundFxSettings,
}

#[derive(Serialize, Deserialize, Default)]
struct FxSettingsFile {
    #[serde(default)]
    files: BTreeMap<String, SoundFxSettings>,
}

fn validated_game(value: &str) -> Result<PathBuf, String> {
    let game = fs::canonicalize(value).map_err(|_| "Cannot resolve the Gorilla Tag folder")?;
    if !discovery::validate_game(&game).valid {
        return Err("Select a valid Gorilla Tag installation".into());
    }
    Ok(game)
}

fn sounds_dir(game: &Path) -> Result<PathBuf, String> {
    let path = scoped_path(game, Path::new(SOUNDS_REL))
        .map_err(|_| "The menu Sounds folder path is unsafe")?;
    fs::create_dir_all(&path).map_err(|_| "Could not create the menu Sounds folder")?;
    Ok(path)
}

fn fx_settings_path(game: &Path) -> Result<PathBuf, String> {
    scoped_path(game, Path::new(FX_SETTINGS_REL))
        .map_err(|_| "The menu FX settings path is unsafe".into())
}

fn load_fx_file(game: &Path) -> Result<FxSettingsFile, String> {
    let path = fx_settings_path(game)?;
    if !path.is_file() {
        return Ok(FxSettingsFile::default());
    }
    let raw = fs::read_to_string(&path).map_err(|_| "Could not read menu sound FX settings")?;
    serde_json::from_str(&raw).map_err(|_| "Menu sound FX settings are invalid JSON".into())
}

fn save_fx_file(game: &Path, file: &FxSettingsFile) -> Result<(), String> {
    let path = fx_settings_path(game)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "Could not create menu settings folder")?;
    }
    let encoded = serde_json::to_string_pretty(file).map_err(|_| "Could not encode FX settings")?;
    let temporary = path.with_extension(format!("tmp-{}", rand::thread_rng().gen::<u64>()));
    {
        let mut out = File::create(&temporary).map_err(|_| "Could not write FX settings")?;
        out.write_all(encoded.as_bytes())
            .map_err(|_| "Could not write FX settings")?;
    }
    fs::rename(&temporary, &path).map_err(|_| "Could not save FX settings")?;
    Ok(())
}

fn safe_sound_filename(value: &str) -> bool {
    let path = Path::new(value);
    let stem = value.split('.').next().unwrap_or("").to_ascii_uppercase();
    let lower = value.to_ascii_lowercase();
    let ext_ok = lower.ends_with(".mp3") || lower.ends_with(".mp4");
    path.components()
        .all(|part| matches!(part, Component::Normal(_)))
        && path.file_name().and_then(|name| name.to_str()) == Some(value)
        && value.len() <= 180
        && ext_ok
        && !value.chars().any(char::is_control)
        && !value.contains([':', '<', '>', '"', '|', '?', '*', '/', '\\'])
        && !value.ends_with(['.', ' '])
        && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn logical_filename(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".mp3.disabled") {
        name[..name.len() - ".disabled".len()].to_owned()
    } else if lower.ends_with(".mp4.disabled") {
        name[..name.len() - ".disabled".len()].to_owned()
    } else {
        name.to_owned()
    }
}

fn media_kind(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".mp4") || lower.ends_with(".mp4.disabled") {
        "mp4"
    } else {
        "mp3"
    }
}

fn default_fx() -> SoundFxSettings {
    SoundFxSettings {
        bass: 0.35,
        volume: 1.0,
        speed: 1.0,
        distortion: 0.0,
        pitch: 0.0,
        reverb: 0.15,
    }
}

#[tauri::command]
pub fn list_menu_sounds(game_path: String) -> Result<Vec<MenuSoundEntry>, String> {
    let game = validated_game(&game_path)?;
    let dir = sounds_dir(&game)?;
    let fx = load_fx_file(&game)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|_| "Could not read menu Sounds folder")? {
        let entry = entry.map_err(|_| "Could not inspect a menu sound")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_ascii_lowercase();
        if !lower.ends_with(".mp3")
            && !lower.ends_with(".mp4")
            && !lower.ends_with(".mp3.disabled")
            && !lower.ends_with(".mp4.disabled")
        {
            continue;
        }
        let path = entry.path();
        let byte_size = path.metadata().map(|meta| meta.len()).unwrap_or(0);
        let logical = logical_filename(&name);
        let enabled = !lower.ends_with(".disabled");
        let settings = fx.files.get(&logical).cloned().unwrap_or_else(default_fx);
        entries.push(MenuSoundEntry {
            filename: logical.clone(),
            byte_size,
            enabled,
            media: media_kind(&logical).into(),
            fx: settings,
        });
    }
    entries.sort_by(|a, b| {
        a.filename
            .to_ascii_lowercase()
            .cmp(&b.filename.to_ascii_lowercase())
    });
    Ok(entries)
}

#[tauri::command]
pub fn import_menu_sound(
    _app: AppHandle,
    game_path: String,
    filename: String,
    bytes: Vec<u8>,
) -> Result<MenuSoundEntry, String> {
    if health::running() {
        return Err("Close Gorilla Tag before changing menu sounds".into());
    }
    if !safe_sound_filename(&filename) || bytes.is_empty() || bytes.len() > MAX_SOUND_BYTES {
        return Err("That menu sound file is not allowed".into());
    }
    let game = validated_game(&game_path)?;
    let dir = sounds_dir(&game)?;
    let target = scoped_path(&dir, Path::new(&filename))
        .map_err(|_| "The menu sound destination is unsafe")?;
    let temporary = dir.join(format!(".ii-sound-{}.tmp", rand::thread_rng().gen::<u64>()));
    {
        let mut file = File::create(&temporary).map_err(|_| "Could not write menu sound")?;
        file.write_all(&bytes)
            .map_err(|_| "Could not write menu sound")?;
    }
    fs::rename(&temporary, &target).map_err(|_| "Could not install menu sound")?;
    let byte_size = target.metadata().map(|meta| meta.len()).unwrap_or(0);
    Ok(MenuSoundEntry {
        filename: filename.clone(),
        byte_size,
        enabled: true,
        media: media_kind(&filename).into(),
        fx: default_fx(),
    })
}

#[tauri::command]
pub fn set_menu_sound_enabled(
    game_path: String,
    filename: String,
    enabled: bool,
) -> Result<(), String> {
    if health::running() {
        return Err("Close Gorilla Tag before changing menu sounds".into());
    }
    if !safe_sound_filename(&filename) {
        return Err("That menu sound name is invalid".into());
    }
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".disabled") {
        return Err("Pass the active filename without .disabled".into());
    }
    let game = validated_game(&game_path)?;
    let dir = sounds_dir(&game)?;
    let active =
        scoped_path(&dir, Path::new(&filename)).map_err(|_| "The menu sound path is unsafe")?;
    let disabled_name = format!("{filename}.disabled");
    let disabled = scoped_path(&dir, Path::new(&disabled_name))
        .map_err(|_| "The disabled menu sound path is unsafe")?;
    if enabled {
        if active.is_file() {
            return Err("That sound is already enabled".into());
        }
        if !disabled.is_file() {
            return Err("That menu sound was not found".into());
        }
        fs::rename(&disabled, &active).map_err(|_| "Could not enable menu sound")?;
    } else {
        if !active.is_file() {
            return Err("That menu sound was not found".into());
        }
        if disabled.exists() {
            return Err("A disabled copy of that sound already exists".into());
        }
        fs::rename(&active, &disabled).map_err(|_| "Could not disable menu sound")?;
    }
    Ok(())
}

#[tauri::command]
pub fn update_menu_sound_fx(
    game_path: String,
    filename: String,
    fx: SoundFxSettings,
) -> Result<(), String> {
    if !safe_sound_filename(&filename) || filename.to_ascii_lowercase().ends_with(".disabled") {
        return Err("That menu sound name is invalid".into());
    }
    let game = validated_game(&game_path)?;
    let mut file = load_fx_file(&game)?;
    file.files.insert(filename, fx);
    save_fx_file(&game, &file)
}

#[tauri::command]
pub fn read_menu_sound_bytes(game_path: String, filename: String) -> Result<Vec<u8>, String> {
    if !safe_sound_filename(&filename) || filename.to_ascii_lowercase().ends_with(".disabled") {
        return Err("That menu sound name is invalid".into());
    }
    let game = validated_game(&game_path)?;
    let dir = sounds_dir(&game)?;
    let path =
        scoped_path(&dir, Path::new(&filename)).map_err(|_| "The menu sound path is unsafe")?;
    if !path.is_file() {
        return Err("That menu sound was not found".into());
    }
    let meta = path
        .metadata()
        .map_err(|_| "Could not read menu sound metadata")?;
    if meta.len() as usize > MAX_SOUND_BYTES {
        return Err("That menu sound is too large to preview".into());
    }
    fs::read(&path).map_err(|_| "Could not read menu sound".into())
}

#[cfg(not(target_os = "windows"))]
fn platform_hint() -> &'static str {
    "Menu sound folder writes are only supported on Windows in this build."
}

#[cfg(target_os = "windows")]
fn platform_hint() -> &'static str {
    ""
}

#[tauri::command]
pub fn menu_sounds_environment() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "platform": std::env::consts::OS,
        "soundsRelative": SOUNDS_REL,
        "fxSettingsRelative": FX_SETTINGS_REL,
        "disableSuffix": ".disabled",
        "hint": platform_hint(),
    }))
}

#[derive(Serialize)]
pub struct PlaylistTrackEntry {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub filename: String,
    pub byte_size: u64,
}

fn playlist_dir(game: &Path) -> Result<PathBuf, String> {
    let path = scoped_path(game, Path::new(PLAYLIST_REL))
        .map_err(|_| "The Engine playlist folder path is unsafe")?;
    fs::create_dir_all(&path).map_err(|_| "Could not create the Engine playlist folder")?;
    Ok(path)
}

fn safe_playlist_filename(value: &str) -> bool {
    let path = Path::new(value);
    let stem = value.split('.').next().unwrap_or("").to_ascii_uppercase();
    let lower = value.to_ascii_lowercase();
    let ext_ok = lower.ends_with(".mp3")
        || lower.ends_with(".m4a")
        || lower.ends_with(".mp4")
        || lower.ends_with(".wav")
        || lower.ends_with(".ogg");
    path.components()
        .all(|part| matches!(part, Component::Normal(_)))
        && path.file_name().and_then(|name| name.to_str()) == Some(value)
        && value.len() <= 180
        && ext_ok
        && !value.chars().any(char::is_control)
        && !value.contains([':', '<', '>', '"', '|', '?', '*', '/', '\\'])
        && !value.ends_with(['.', ' '])
        && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn playlist_title(filename: &str) -> String {
    Path::new(filename)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(filename)
        .to_owned()
}

#[tauri::command]
pub fn list_engine_playlist(game_path: String) -> Result<Vec<PlaylistTrackEntry>, String> {
    let game = validated_game(&game_path)?;
    let dir = playlist_dir(&game)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|_| "Could not read Engine playlist folder")? {
        let entry = entry.map_err(|_| "Could not inspect a playlist track")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !safe_playlist_filename(&name) {
            continue;
        }
        let path = entry.path();
        let byte_size = path.metadata().map(|meta| meta.len()).unwrap_or(0);
        entries.push(PlaylistTrackEntry {
            id: format!("disk:{name}"),
            title: playlist_title(&name),
            artist: "Imported".into(),
            filename: name,
            byte_size,
        });
    }
    entries.sort_by(|a, b| {
        a.filename
            .to_ascii_lowercase()
            .cmp(&b.filename.to_ascii_lowercase())
    });
    Ok(entries)
}

#[tauri::command]
pub fn import_engine_playlist_track(
    game_path: String,
    filename: String,
    bytes: Vec<u8>,
) -> Result<PlaylistTrackEntry, String> {
    if !safe_playlist_filename(&filename) || bytes.is_empty() || bytes.len() > MAX_SOUND_BYTES {
        return Err("That playlist file is not allowed".into());
    }
    let game = validated_game(&game_path)?;
    let dir = playlist_dir(&game)?;
    let existing = fs::read_dir(&dir)
        .map_err(|_| "Could not read Engine playlist folder")?
        .filter_map(|item| item.ok())
        .filter(|item| safe_playlist_filename(&item.file_name().to_string_lossy()))
        .count();
    if existing >= MAX_PLAYLIST_TRACKS {
        return Err("Engine playlist is full (40 tracks max)".into());
    }
    let target = scoped_path(&dir, Path::new(&filename))
        .map_err(|_| "The playlist destination is unsafe")?;
    let temporary = dir.join(format!(
        ".ii-playlist-{}.tmp",
        rand::thread_rng().gen::<u64>()
    ));
    {
        let mut file = File::create(&temporary).map_err(|_| "Could not write playlist track")?;
        file.write_all(&bytes)
            .map_err(|_| "Could not write playlist track")?;
    }
    fs::rename(&temporary, &target).map_err(|_| "Could not install playlist track")?;
    let byte_size = target.metadata().map(|meta| meta.len()).unwrap_or(0);
    Ok(PlaylistTrackEntry {
        id: format!("disk:{filename}"),
        title: playlist_title(&filename),
        artist: "Imported".into(),
        filename: filename.clone(),
        byte_size,
    })
}

#[tauri::command]
pub fn remove_engine_playlist_track(game_path: String, filename: String) -> Result<(), String> {
    if !safe_playlist_filename(&filename) {
        return Err("That playlist filename is invalid".into());
    }
    let game = validated_game(&game_path)?;
    let dir = playlist_dir(&game)?;
    let path =
        scoped_path(&dir, Path::new(&filename)).map_err(|_| "The playlist path is unsafe")?;
    if !path.is_file() {
        return Err("That playlist track was not found".into());
    }
    fs::remove_file(&path).map_err(|_| "Could not remove playlist track")?;
    Ok(())
}

#[tauri::command]
pub fn read_engine_playlist_bytes(game_path: String, filename: String) -> Result<Vec<u8>, String> {
    if !safe_playlist_filename(&filename) {
        return Err("That playlist filename is invalid".into());
    }
    let game = validated_game(&game_path)?;
    let dir = playlist_dir(&game)?;
    let path =
        scoped_path(&dir, Path::new(&filename)).map_err(|_| "The playlist path is unsafe")?;
    if !path.is_file() {
        return Err("That playlist track was not found".into());
    }
    let meta = path
        .metadata()
        .map_err(|_| "Could not read playlist track metadata")?;
    if meta.len() as usize > MAX_SOUND_BYTES {
        return Err("That playlist track is too large to play".into());
    }
    fs::read(&path).map_err(|_| "Could not read playlist track".into())
}

#[tauri::command]
pub fn engine_playlist_environment() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "platform": std::env::consts::OS,
        "playlistRelative": PLAYLIST_REL,
        "maxTracks": MAX_PLAYLIST_TRACKS,
        "hint": platform_hint(),
    }))
}
