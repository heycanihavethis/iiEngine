use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
pub struct AuthState {
    pending: Mutex<Option<(String, String)>>,
    serial: tokio::sync::Mutex<()>,
}

pub(crate) fn backend() -> Result<String, String> {
    let fallback = if cfg!(debug_assertions) {
        "http://127.0.0.1:8000"
    } else {
        "https://ii-engine-api-production.up.railway.app"
    };
    let raw = option_env!("ENGINE_BACKEND_URL").unwrap_or(fallback);
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid backend origin")?;
    let local =
        cfg!(debug_assertions) && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"));
    if (!local && url.scheme() != "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(
            "Configure ENGINE_BACKEND_URL to the reviewed HTTPS API origin before packaging".into(),
        );
    }
    Ok(raw.trim_end_matches('/').to_string())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Network client unavailable".into())
}

fn vault() -> Result<keyring::Entry, String> {
    keyring::Entry::new("ii Engine", &format!("refresh:{}", backend()?))
        .map_err(|_| "Windows Credential Manager is unavailable".into())
}

fn membership_vault() -> Result<keyring::Entry, String> {
    keyring::Entry::new("ii Engine", &format!("membership:{}", backend()?))
        .map_err(|_| "Windows Credential Manager is unavailable".into())
}

const OAUTH_SCOPE_EPOCH: &str = "guilds.members.read-v1";

fn oauth_epoch_vault() -> Result<keyring::Entry, String> {
    keyring::Entry::new("ii Engine", &format!("oauth-epoch:{}", backend()?))
        .map_err(|_| "Windows Credential Manager is unavailable".into())
}

fn clear_local_session_secrets() {
    match vault() {
        Ok(entry) => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => {}
        },
        Err(_) => {}
    }
    match membership_vault() {
        Ok(entry) => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => {}
        },
        Err(_) => {}
    }
}

fn migrate_oauth_scope_epoch() -> Result<bool, String> {
    let entry = oauth_epoch_vault()?;
    match entry.get_password() {
        Ok(value) if value == OAUTH_SCOPE_EPOCH => Ok(false),
        _ => {
            clear_local_session_secrets();
            let _ = entry.set_password(OAUTH_SCOPE_EPOCH);
            Ok(true)
        }
    }
}

#[derive(Deserialize)]
struct StartResponse {
    request_id: String,
    authorize_url: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    status: Option<String>,
    expires_in: Option<u64>,
}

#[derive(Serialize)]
pub struct AccessSession {
    pub access_token: Option<String>,
    pub status: String,
    pub expires_in: Option<u64>,
}

fn accept_tokens(tokens: TokenResponse) -> Result<AccessSession, String> {
    if let (Some(access), Some(refresh)) = (tokens.access_token, tokens.refresh_token) {
        vault()?
            .set_password(&refresh)
            .map_err(|_| "Could not save session to Windows Credential Manager")?;
        Ok(AccessSession {
            access_token: Some(access),
            status: "complete".into(),
            expires_in: Some(tokens.expires_in.unwrap_or(900)),
        })
    } else {
        Ok(AccessSession {
            access_token: None,
            status: tokens.status.unwrap_or("failed".into()),
            expires_in: None,
        })
    }
}

#[tauri::command]
pub async fn auth_start(state: State<'_, AuthState>) -> Result<(), String> {
    let _operation = state.serial.lock().await;
    let mut random = [0u8; 48];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let verifier = URL_SAFE_NO_PAD.encode(random);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let response = client()?
        .post(format!("{}/v1/auth/requests", backend()?))
        .json(&serde_json::json!({"challenge": challenge}))
        .send()
        .await
        .map_err(|_| "Could not reach the sign-in service")?;
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("a few minutes");
        return Err(format!(
            "Too many sign-in attempts. Try again in {retry} seconds."
        ));
    }
    if !response.status().is_success() {
        return Err("Discord sign-in is not configured or is unavailable".into());
    }
    let data: StartResponse = response
        .json()
        .await
        .map_err(|_| "Invalid sign-in response")?;
    let url = reqwest::Url::parse(&data.authorize_url).map_err(|_| "Invalid authorization URL")?;
    if url.scheme() != "https"
        || url.host_str() != Some("discord.com")
        || url.path() != "/oauth2/authorize"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("Unexpected authorization destination".into());
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    for (key, expected) in [
        ("client_id", "1541246974404198470"),
        ("response_type", "code"),
    ] {
        let values: Vec<_> = pairs
            .iter()
            .filter(|(name, _)| name == key)
            .map(|(_, value)| value.as_ref())
            .collect();
        if values != [expected] {
            return Err("Unexpected Discord sign-in scope or application".into());
        }
    }
    let scopes: Vec<_> = pairs
        .iter()
        .filter(|(name, _)| name == "scope")
        .map(|(_, value)| value.as_ref())
        .collect();
    if scopes.len() != 1 || !discord_oauth_scopes_allowed(scopes[0]) {
        return Err("Unexpected Discord sign-in scope or application".into());
    }
    if data.request_id.len() < 32
        || data.request_id.len() > 128
        || !data
            .request_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err("Invalid sign-in request identity".into());
    }
    *state
        .pending
        .lock()
        .map_err(|_| "Session state unavailable")? = Some((data.request_id, verifier));
    open::that(data.authorize_url).map_err(|_| "Could not open the default browser")?;
    Ok(())
}

#[tauri::command]
pub async fn auth_poll(state: State<'_, AuthState>) -> Result<AccessSession, String> {
    let _operation = state.serial.lock().await;
    let pending = state
        .pending
        .lock()
        .map_err(|_| "Session state unavailable")?
        .clone()
        .ok_or("No sign-in is pending")?;
    let response = client()?
        .post(format!(
            "{}/v1/auth/requests/{}/poll",
            backend()?,
            pending.0
        ))
        .json(&serde_json::json!({"verifier": pending.1}))
        .send()
        .await
        .map_err(|_| "Sign-in polling failed")?;
    if !response.status().is_success() {
        return Err("Sign-in expired; please start again".into());
    }
    let result = accept_tokens(
        response
            .json()
            .await
            .map_err(|_| "Invalid session response")?,
    )?;
    if result.status != "pending" {
        *state
            .pending
            .lock()
            .map_err(|_| "Session state unavailable")? = None;
    }
    Ok(result)
}

#[tauri::command]
pub async fn auth_resume(state: State<'_, AuthState>) -> Result<AccessSession, String> {
    let _operation = state.serial.lock().await;
    if migrate_oauth_scope_epoch()? {
        return Ok(AccessSession {
            access_token: None,
            status: "expired".into(),
            expires_in: None,
        });
    }
    let credential = vault()?;
    let refresh = match credential.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => {
            return Ok(AccessSession {
                access_token: None,
                status: "signed_out".into(),
                expires_in: None,
            })
        }
        Err(_) => return Err("Windows Credential Manager is unavailable".into()),
    };
    let response = client()?
        .post(format!("{}/v1/auth/refresh", backend()?))
        .json(&serde_json::json!({"refresh_token": refresh}))
        .send()
        .await
        .map_err(|_| "Session service unavailable")?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        clear_local_session_secrets();
        return Ok(AccessSession {
            access_token: None,
            status: "expired".into(),
            expires_in: None,
        });
    }
    if !response.status().is_success() {
        return Err("Session service unavailable".into());
    }
    accept_tokens(
        response
            .json()
            .await
            .map_err(|_| "Invalid session response")?,
    )
}

#[tauri::command]
pub async fn auth_clear(state: State<'_, AuthState>) -> Result<(), String> {
    let _operation = state.serial.lock().await;
    *state
        .pending
        .lock()
        .map_err(|_| "Session state unavailable")? = None;
    match vault()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err("Could not clear Windows Credential Manager session".into()),
    }
    match membership_vault()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Ok(()),
    }
}

#[tauri::command]
pub async fn membership_snapshot_save(snapshot_json: String) -> Result<(), String> {
    if snapshot_json.len() > 64_000 || snapshot_json.is_empty() {
        return Err("Membership snapshot is invalid".into());
    }
    serde_json::from_str::<serde_json::Value>(&snapshot_json)
        .map_err(|_| "Membership snapshot is not valid JSON")?;
    membership_vault()?
        .set_password(&snapshot_json)
        .map_err(|_| "Could not save membership snapshot")?;
    Ok(())
}

#[tauri::command]
pub async fn membership_snapshot_load() -> Result<Option<String>, String> {
    match membership_vault()?.get_password() {
        Ok(value) if !value.is_empty() => Ok(Some(value)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read membership snapshot".into()),
    }
}

fn discord_oauth_scopes_allowed(scope: &str) -> bool {
    const ALLOWED: &[&str] = &["identify", "guilds.members.read"];
    let parts: std::collections::HashSet<_> = scope.split_whitespace().collect();
    !parts.is_empty()
        && parts.contains("identify")
        && parts.iter().all(|part| ALLOWED.contains(part))
}

#[cfg(test)]
mod tests {
    use super::discord_oauth_scopes_allowed;

    #[test]
    fn accepts_identify_only_and_expanded_scopes() {
        assert!(discord_oauth_scopes_allowed("identify"));
        assert!(discord_oauth_scopes_allowed("identify guilds.members.read"));
        assert!(discord_oauth_scopes_allowed("guilds.members.read identify"));
    }

    #[test]
    fn rejects_missing_identify_or_unknown_scopes() {
        assert!(!discord_oauth_scopes_allowed(""));
        assert!(!discord_oauth_scopes_allowed("guilds.members.read"));
        assert!(!discord_oauth_scopes_allowed("identify bot"));
        assert!(!discord_oauth_scopes_allowed("identify guilds.join"));
    }
}
