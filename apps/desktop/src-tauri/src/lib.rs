mod auth;
mod autoloader;
mod backup;
mod baseline;
mod diagnostics;
mod discovery;
mod engine_update;
mod health;
mod installer;
mod manifest;
mod menu_bridge;
mod metadata;
mod paths;
mod protocol;
mod recovery;
mod soundlab;
mod studio;
mod tracker;
mod transaction;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Serialize)]
struct EnvironmentStatus {
    platform: &'static str,
    version: &'static str,
    game_mutations_enabled: bool,
}

struct WindowPreferences {
    close_to_tray: AtomicBool,
}

#[tauri::command]
fn set_window_preferences(close_to_tray: bool, preferences: tauri::State<WindowPreferences>) {
    preferences
        .close_to_tray
        .store(close_to_tray, Ordering::Relaxed);
}

#[tauri::command]
fn environment_status() -> EnvironmentStatus {
    EnvironmentStatus {
        platform: std::env::consts::OS,
        version: env!("CARGO_PKG_VERSION"),
        game_mutations_enabled: cfg!(target_os = "windows"),
    }
}

#[tauri::command]
fn minimize_window(window: WebviewWindow) -> Result<(), String> {
    window
        .minimize()
        .map_err(|_| "Could not minimize window".into())
}

#[tauri::command]
fn start_dragging_window(window: WebviewWindow) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|_| "Could not move window".into())
}

#[tauri::command]
fn toggle_maximize_window(window: WebviewWindow) -> Result<(), String> {
    let maximized = window
        .is_maximized()
        .map_err(|_| "Could not read window state".to_string())?;
    if maximized {
        window
            .unmaximize()
            .map_err(|_| "Could not restore window".into())
    } else {
        window
            .maximize()
            .map_err(|_| "Could not maximize window".into())
    }
}

#[tauri::command]
fn close_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|_| "Could not close window".into())
}

#[tauri::command]
fn confirm_app_exit(app: tauri::AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn open_engine_uninstaller() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for name in ["uninstall.exe", "Uninstall.exe", "unins000.exe"] {
                    let candidate = dir.join(name);
                    if candidate.is_file() {
                        open::that(&candidate).map_err(|_| {
                            "Could not open the ii Engine uninstaller. Try Apps & features in Windows Settings.".to_string()
                        })?;
                        return Ok(
                            "Opened the ii Engine uninstaller. Confirm the prompts to finish removing the app."
                                .into(),
                        );
                    }
                }
            }
        }
        open::that("ms-settings:appsfeatures").map_err(|_| {
            "Could not open Windows Apps settings. Uninstall ii Engine from Settings → Apps."
                .to_string()
        })?;
        Ok("Opened Windows Apps settings. Find ii Engine and choose Uninstall.".into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Uninstall ii Engine from the Windows desktop app.".into())
    }
}

#[tauri::command]
fn open_windows_security_threat_settings() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        if open::that("windowsdefender://threat").is_err()
            && open::that("ms-settings:windowsdefender").is_err()
        {
            return Err(
                "Could not open Windows Security. Search Start for Virus & threat protection, then Manage settings."
                    .into(),
            );
        }
        Ok("Opened Virus & threat protection. Click Manage settings, then turn Real-time protection Off.".into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Windows Security is only available in the Windows desktop app.".into())
    }
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid external link")?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("This external link is not approved".into());
    }
    open::that(parsed.as_str()).map_err(|_| "Could not open the default browser".into())
}

#[tauri::command]
async fn open_studio_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("studio") {
        window.show().map_err(|_| "Could not show ii Studio")?;
        window
            .set_focus()
            .map_err(|_| "Could not focus ii Studio")?;
        return window
            .maximize()
            .map_err(|_| "Could not maximize ii Studio".into());
    }
    let window = WebviewWindowBuilder::new(
        &app,
        "studio",
        WebviewUrl::App("index.html?studio=1".into()),
    )
    .title("ii Studio Pro")
    .decorations(false)
    .inner_size(1440.0, 900.0)
    .min_inner_size(1100.0, 700.0)
    .build()
    .map_err(|_| "Could not open ii Studio in a new window")?;
    window
        .maximize()
        .map_err(|_| "Could not maximize ii Studio".into())
}

#[tauri::command]
async fn open_cone_pet_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("cone-pet") {
        window.show().map_err(|_| "Could not show Cone Pet")?;
        return window
            .set_focus()
            .map_err(|_| "Could not focus Cone Pet".into());
    }
    let window = WebviewWindowBuilder::new(
        &app,
        "cone-pet",
        WebviewUrl::App("index.html?cone-pet=1".into()),
    )
    .title("Cone Pet")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .inner_size(180.0, 220.0)
    .min_inner_size(140.0, 180.0)
    .build()
    .map_err(|_| "Could not open Cone Pet")?;
    let _ = window.set_always_on_top(true);
    let _ = window.set_ignore_cursor_events(false);
    Ok(())
}

#[tauri::command]
fn set_brand_icon(
    app: tauri::AppHandle,
    rgba_b64: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<(), String> {
    let (rgba, w, h) = if let Some(encoded) = rgba_b64.filter(|value| !value.is_empty()) {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.as_bytes())
            .map_err(|_| "Could not decode custom icon")?;
        let width = width.unwrap_or(32).clamp(16, 256);
        let height = height.unwrap_or(32).clamp(16, 256);
        if bytes.len() != (width as usize) * (height as usize) * 4 {
            return Err("Custom icon size does not match RGBA payload".into());
        }
        (bytes, width, height)
    } else {
        (
            include_bytes!("../icons/brand-icon-32.rgba").to_vec(),
            32,
            32,
        )
    };
    let image = tauri::image::Image::new_owned(rgba, w, h);
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_icon(image)
            .map_err(|_| "Could not update the window icon")?;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(WindowPreferences {
            close_to_tray: AtomicBool::new(false),
        })
        .manage(auth::AuthState::default())
        .manage(diagnostics::DiagnosticState::default())
        .manage(installer::InstallState::default())
        .manage(recovery::RecoveryState::default())
        .invoke_handler(tauri::generate_handler![
            environment_status,
            set_window_preferences,
            minimize_window,
            start_dragging_window,
            toggle_maximize_window,
            close_window,
            confirm_app_exit,
            open_engine_uninstaller,
            open_windows_security_threat_settings,
            open_external,
            open_studio_window,
            open_cone_pet_window,
            set_brand_icon,
            auth::auth_start,
            auth::auth_poll,
            auth::auth_resume,
            auth::auth_clear,
            auth::membership_snapshot_save,
            auth::membership_snapshot_load,
            autoloader::list_installed_mods,
            autoloader::install_trusted_mod,
            autoloader::import_local_mod,
            autoloader::set_installed_mod_enabled,
            autoloader::remove_installed_mod,
            autoloader::backup_plugins_snapshot,
            soundlab::list_menu_sounds,
            soundlab::import_menu_sound,
            soundlab::set_menu_sound_enabled,
            soundlab::update_menu_sound_fx,
            soundlab::read_menu_sound_bytes,
            soundlab::menu_sounds_environment,
            soundlab::list_engine_playlist,
            soundlab::import_engine_playlist_track,
            soundlab::remove_engine_playlist_track,
            soundlab::read_engine_playlist_bytes,
            soundlab::engine_playlist_environment,
            discovery::discover_game,
            health::health_check,
            health::is_game_running,
            health::list_game_directory,
            engine_update::check_engine_update,
            engine_update::download_engine_installer,
            engine_update::open_local_path,
            installer::prepare_install,
            installer::prepare_github_menu_install,
            installer::prepare_managed_install,
            installer::download_github_menu_release,
            installer::warm_github_menu_cache,
            installer::download_managed_release,
            installer::fetch_github_menu_metadata,
            installer::prepare_reset_settings,
            installer::execute_install,
            installer::launch_game,
            installer::launch_without_ii,
            installer::open_game_folder,
            installer::open_ii_folder,
            installer::start_clean_game_reinstall,
            installer::continue_clean_game_reinstall,
            menu_bridge::write_menu_bridge,
            menu_bridge::clear_menu_bridge,
            tracker::get_self_tracker,
            tracker::set_self_tracker,
            tracker::read_local_presence,
            recovery::list_backups,
            recovery::prepare_restore,
            recovery::execute_restore,
            recovery::resume_operation,
            diagnostics::diagnostics_preview,
            diagnostics::diagnostics_export,
            studio::studio_environment,
            studio::studio_install_dependencies,
            studio::studio_open_projects_folder,
            studio::studio_list_projects,
            studio::studio_create_project,
            studio::studio_create_folder,
            studio::studio_create_file,
            studio::studio_list_files,
            studio::studio_read_file,
            studio::studio_find_mod_source,
            studio::studio_save_file,
            studio::studio_build_project,
            studio::studio_install_build,
            studio::studio_read_log
        ])
        .setup(|app| {
            protocol::register_auth_protocol();
            let open = MenuItem::with_id(app, "open", "Open ii Engine", true, None::<&str>)?;
            let launch =
                MenuItem::with_id(app, "launch", "Launch Gorilla Tag", true, None::<&str>)?;
            let health = MenuItem::with_id(app, "health", "Run Health Check", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &launch, &health, &quit])?;
            TrayIconBuilder::new()
                .tooltip("ii Engine")
                .icon(app.default_window_icon().expect("bundled app icon").clone())
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.emit("app-quit-requested", ());
                        } else {
                            app.exit(0);
                        }
                        return;
                    }
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                        let _ = window.emit("tray-action", event.id.as_ref());
                    }
                })
                .build(app)?;
            if protocol::launched_from_auth_complete() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                if window
                    .state::<WindowPreferences>()
                    .close_to_tray
                    .load(Ordering::Relaxed)
                {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    api.prevent_close();
                    let _ = window.emit("app-quit-requested", ());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("ii Engine failed to start");
}
