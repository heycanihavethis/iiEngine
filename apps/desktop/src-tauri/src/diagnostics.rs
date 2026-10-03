use crate::{health, paths::scoped_path};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::Write,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Section {
    App,
    Os,
    Health,
    Components,
}
struct Pending {
    token: String,
    text: String,
    expires: Instant,
}
#[derive(Default)]
pub struct DiagnosticState(Mutex<Option<Pending>>);
#[derive(Serialize)]
pub struct Preview {
    token: String,
    text: String,
}

fn report(sections: &[Section], game_path: Option<&str>) -> Result<String, String> {
    let mut result = serde_json::Map::new();
    result.insert("schema_version".into(), serde_json::json!(1));
    for section in sections {
        match section {
            Section::App => {
                result.insert(
                    "app".into(),
                    serde_json::json!({"name":"ii Engine","version":env!("CARGO_PKG_VERSION")}),
                );
            }
            Section::Os => {
                result.insert("os".into(),serde_json::json!({"platform":std::env::consts::OS,"version":sysinfo::System::os_version()}));
            }
            _ => (),
        }
    }
    if sections
        .iter()
        .any(|s| matches!(s, Section::Health | Section::Components))
    {
        if let Some(path) = game_path.filter(|s| !s.trim().is_empty()) {
            let report = health::inspect(Path::new(path))?;
            if sections.iter().any(|s| matches!(s, Section::Health)) {
                result.insert(
                    "health".into(),
                    serde_json::json!({"game_path":"validated","status":report.status,
                    "errors":report.checks.iter().filter(|c|c.status=="Error").count(),
                    "warnings":report.checks.iter().filter(|c|c.status=="Warning").count(),
                    "unknown_checks":report.checks.iter().filter(|c|c.status=="Unknown").count()}),
                );
            }
            if sections.iter().any(|s| matches!(s, Section::Components)) {
                let components:Vec<_>=report.files.iter().filter(|f|f.menu).map(|f|serde_json::json!({"component":"menu-guid-match","sha256":f.sha256,"byte_size":f.size})).collect();
                result.insert("components".into(), serde_json::json!(components));
            }
        } else {
            result.insert(
                "game_path".into(),
                serde_json::json!("not selected; no game files inspected"),
            );
        }
    }
    serde_json::to_string_pretty(&result).map_err(|_| "Cannot encode diagnostic preview".into())
}

#[tauri::command]
pub fn diagnostics_preview(
    sections: Vec<Section>,
    game_path: Option<String>,
    state: tauri::State<DiagnosticState>,
) -> Result<Preview, String> {
    let text = report(&sections, game_path.as_deref())?;
    let token = hex::encode(rand::random::<[u8; 16]>());
    *state.0.lock().map_err(|_| "Diagnostic preview is busy")? = Some(Pending {
        token: token.clone(),
        text: text.clone(),
        expires: Instant::now() + Duration::from_secs(300),
    });
    Ok(Preview { token, text })
}

#[tauri::command]
pub fn diagnostics_export(
    token: String,
    state: tauri::State<DiagnosticState>,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|_| "Diagnostic preview is busy")?;
    let pending = guard.as_ref().ok_or("Review a diagnostic preview first")?;
    if pending.token != token || pending.expires < Instant::now() {
        return Err("Diagnostic preview expired; create a fresh preview".into());
    }
    let local = std::env::var_os("LOCALAPPDATA")
        .ok_or("Windows local app-data directory is unavailable")?;
    let base = Path::new(&local);
    let root = scoped_path(base, Path::new("ii Engine/Diagnostics"))
        .map_err(|_| "Unsafe diagnostics directory")?;
    fs::create_dir_all(&root).map_err(|_| "Cannot create local diagnostics directory")?;
    let destination = scoped_path(&root, Path::new(&format!("report-{}.json", pending.token)))
        .map_err(|_| "Unsafe report destination")?;
    let mut file = File::create_new(&destination).map_err(|_| "Cannot create diagnostic report")?;
    file.write_all(pending.text.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| "Diagnostic export failed")?;
    *guard = None;
    Ok(destination.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excluded_sections_do_not_trigger_path_access_or_include_user_input() {
        let value = report(&[Section::App], Some(r"C:\Users\PrivateFixture\unrelated")).unwrap();
        assert!(!value.contains("PrivateFixture"));
        assert!(!value.contains("os"));
        assert!(value.contains("ii Engine"));
    }
    #[test]
    fn no_game_selection_has_an_explicit_coarse_state() {
        let value = report(&[Section::Health, Section::Components], None).unwrap();
        assert!(value.contains("no game files inspected"));
        assert!(!value.contains("Users"));
    }
}
