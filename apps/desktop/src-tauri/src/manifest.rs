use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub channel: String,
    pub menu_version: String,
    pub published_at: String,
    pub expires_at: String,
    pub minimum_engine_version: String,
    pub download_url: String,
    pub release_url: String,
    pub canonical_filename: String,
    pub sha256: String,
    pub byte_size: u64,
    pub baseline_id: String,
    pub compatibility_catalog_version: String,
    pub signature: String,
}

impl Manifest {
    pub fn signing_bytes(&self) -> Result<Vec<u8>, String> {
        let mut value = serde_json::to_value(self).map_err(|_| "Manifest encoding failed")?;
        value
            .as_object_mut()
            .ok_or("Invalid manifest")?
            .remove("signature");
        serde_json::to_vec(&value).map_err(|_| "Manifest encoding failed".into())
    }

    pub fn verify(
        &self,
        public_key: &[u8; 32],
        channel: &str,
        now: DateTime<Utc>,
    ) -> Result<(), String> {
        let key = VerifyingKey::from_bytes(public_key).map_err(|_| "Invalid pinned public key")?;
        let bytes = STANDARD
            .decode(&self.signature)
            .map_err(|_| "Invalid signature encoding")?;
        let signature = Signature::from_slice(&bytes).map_err(|_| "Invalid signature size")?;
        key.verify_strict(&self.signing_bytes()?, &signature)
            .map_err(|_| "Manifest signature is invalid")?;
        if self.schema_version != 1
            || self.channel != channel
            || !["stable", "beta", "developer"].contains(&channel)
        {
            return Err("Manifest schema or channel mismatch".into());
        }
        let published = DateTime::parse_from_rfc3339(&self.published_at)
            .map_err(|_| "Invalid publication time")?;
        let expires =
            DateTime::parse_from_rfc3339(&self.expires_at).map_err(|_| "Invalid expiry time")?;
        if published > now || expires <= now || expires <= published {
            return Err("Manifest is expired or not yet valid".into());
        }
        Version::parse(&self.menu_version).map_err(|_| "Invalid menu version")?;
        if Version::parse(&self.minimum_engine_version).map_err(|_| "Invalid minimum version")?
            > Version::parse(env!("CARGO_PKG_VERSION")).unwrap()
        {
            return Err("This release requires a newer ii Engine".into());
        }
        let baseline_ok = matches!(
            self.baseline_id.as_str(),
            "bepinex-5.4.23.5-win-x64" | "bepinex-5.4.23.4-win-x64"
        );
        if !(self.canonical_filename == "ii.Reborn.dll"
            || self.canonical_filename == "ii.s.Stupid.Menu.dll")
            || !baseline_ok
            || !(1024..=100_000_000).contains(&self.byte_size)
            || self.sha256.len() != 64
            || !self.sha256.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err("Invalid artifact identity, size, or baseline".into());
        }
        validate_url(&self.download_url, true)?;
        validate_url(&self.release_url, false)?;
        Ok(())
    }

    pub fn verify_hash(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() as u64 != self.byte_size
            || hex::encode(Sha256::digest(bytes)) != self.sha256.to_lowercase()
        {
            return Err(
                "Downloaded file size or SHA-256 does not match the trusted manifest".into(),
            );
        }
        Ok(())
    }
}

pub fn validate_url(value: &str, download: bool) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid release URL")?;
    let path = url.path();
    let allowed = if download {
        [
            "/iireborn/menu/releases/latest/download/",
            "/iireborn/menu/releases/download/",
            "/iireborn/ii.stupid.menu/releases/download/",
            "/iireborn/iis.Stupid.Menu/releases/download/",
        ]
        .iter()
        .any(|prefix| path.starts_with(prefix))
    } else {
        [
            "/iireborn/menu/releases/",
            "/iireborn/ii.stupid.menu/releases/",
            "/iireborn/iis.Stupid.Menu/releases/",
        ]
        .iter()
        .any(|prefix| path.starts_with(prefix))
    };
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !allowed
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("Release URL is outside the official repository".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    fn signed() -> (Manifest, SigningKey) {
        let key = SigningKey::generate(&mut rand::rngs::OsRng);
        let mut m = Manifest {schema_version:1, channel:"stable".into(), menu_version:"1.0.3".into(),
            published_at:"2026-09-01T00:00:00Z".into(), expires_at:"2026-10-01T00:00:00Z".into(),
            minimum_engine_version:"0.1.0".into(), download_url:"https://github.com/iireborn/iis.Stupid.Menu/releases/download/v1.0.3/iis_Stupid_Menu.dll".into(),
            release_url:"https://github.com/iireborn/iis.Stupid.Menu/releases/tag/v1.0.3".into(), canonical_filename:"ii.s.Stupid.Menu.dll".into(),
            sha256:"a".repeat(64), byte_size:4096, baseline_id:"bepinex-5.4.23.5-win-x64".into(), compatibility_catalog_version:"1".into(), signature:String::new()};
        m.signature = STANDARD.encode(key.sign(&m.signing_bytes().unwrap()).to_bytes());
        (m, key)
    }
    #[test]
    fn accepts_valid_and_rejects_tampering_expiry_and_wrong_channel() {
        let (mut m, key) = signed();
        let now = "2026-09-14T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        assert!(m
            .verify(&key.verifying_key().to_bytes(), "stable", now)
            .is_ok());
        assert!(m
            .verify(&key.verifying_key().to_bytes(), "beta", now)
            .is_err());
        assert!(m
            .verify(
                &key.verifying_key().to_bytes(),
                "stable",
                "2026-11-01T00:00:00Z".parse().unwrap()
            )
            .is_err());
        m.byte_size += 1;
        assert!(m
            .verify(&key.verifying_key().to_bytes(), "stable", now)
            .is_err());
    }
    #[test]
    fn rejects_wrong_hash_and_untrusted_hosts() {
        let (m, _) = signed();
        assert!(m.verify_hash(b"bad").is_err());
        assert!(validate_url("https://evil.example/menu.dll", true).is_err());
        assert!(validate_url(
            "https://github.com@evil.example/iireborn/iis.Stupid.Menu/releases/x",
            false
        )
        .is_err());
    }
}
