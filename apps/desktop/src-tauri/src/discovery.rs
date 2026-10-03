use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, PartialEq)]
enum Value {
    Text(String),
    Object(BTreeMap<String, Value>),
}

fn tokens(input: &str) -> Result<Vec<String>, String> {
    if input.len() > 4 * 1024 * 1024 {
        return Err("Steam library file is too large".into());
    }
    let mut chars = input.chars().peekable();
    let mut output = Vec::new();
    while let Some(c) = chars.next() {
        if c.is_whitespace() || c == '\u{feff}' {
            continue;
        }
        if c == '/' && chars.peek() == Some(&'/') {
            for next in chars.by_ref() {
                if next == '\n' {
                    break;
                }
            }
            continue;
        }
        if c == '{' || c == '}' {
            output.push(c.to_string());
            continue;
        }
        let mut text = String::new();
        if c == '"' {
            let mut closed = false;
            while let Some(next) = chars.next() {
                if next == '"' {
                    closed = true;
                    break;
                }
                if next == '\\' {
                    match chars.next() {
                        Some('\\') => text.push('\\'),
                        Some('"') => text.push('"'),
                        Some(other) => {
                            text.push('\\');
                            text.push(other);
                        }
                        None => return Err("Incomplete Steam VDF escape".into()),
                    }
                } else {
                    text.push(next);
                }
            }
            if !closed {
                return Err("Unterminated Steam VDF string".into());
            }
        } else {
            text.push(c);
            while chars
                .peek()
                .is_some_and(|next| !next.is_whitespace() && *next != '{' && *next != '}')
            {
                text.push(chars.next().unwrap());
            }
        }
        output.push(text);
    }
    Ok(output)
}

fn object(
    tokens: &[String],
    index: &mut usize,
    depth: usize,
) -> Result<BTreeMap<String, Value>, String> {
    if depth > 32 {
        return Err("Steam VDF nesting is too deep".into());
    }
    let mut result = BTreeMap::new();
    while *index < tokens.len() {
        let key = tokens[*index].clone();
        *index += 1;
        if key == "}" {
            return if depth > 0 {
                Ok(result)
            } else {
                Err("Unexpected VDF close brace".into())
            };
        }
        if key == "{" || *index >= tokens.len() {
            return Err("Incomplete Steam VDF entry".into());
        }
        let value = &tokens[*index];
        *index += 1;
        let value = match value.as_str() {
            "{" => Value::Object(object(tokens, index, depth + 1)?),
            "}" => return Err("Missing Steam VDF value".into()),
            _ => Value::Text(value.clone()),
        };
        if result.insert(key.to_lowercase(), value).is_some() {
            return Err("Ambiguous duplicate Steam VDF key".into());
        }
    }
    if depth > 0 {
        return Err("Unclosed Steam VDF object".into());
    }
    Ok(result)
}

pub fn library_paths(input: &str) -> Result<Vec<PathBuf>, String> {
    let tree = object(&tokens(input)?, &mut 0, 0)?;
    let Some(Value::Object(libraries)) = tree.get("libraryfolders") else {
        return Err("Steam libraryfolders object missing".into());
    };
    let mut paths = Vec::new();
    for (number, entry) in libraries {
        if !number.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let path = match entry {
            Value::Text(path) => Some(path),
            Value::Object(fields) => match fields.get("path") {
                Some(Value::Text(path)) => Some(path),
                _ => None,
            },
        };
        if let Some(path) = path {
            if !path.is_empty() {
                paths.push(PathBuf::from(path));
            }
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

#[derive(Serialize)]
pub struct GameCandidate {
    pub path: String,
    pub valid: bool,
    pub missing: Vec<String>,
    pub manifest_present: bool,
}

pub fn validate_game(root: &Path) -> GameCandidate {
    let mut missing = Vec::new();
    for file in ["Gorilla Tag.exe", "UnityPlayer.dll"] {
        if !root.join(file).is_file() {
            missing.push(file.into());
        }
    }
    if !root.join("Gorilla Tag_Data").is_dir() {
        missing.push("Gorilla Tag_Data".into());
    }
    let manifest = root
        .parent()
        .and_then(Path::parent)
        .map(|apps| apps.join("appmanifest_1533390.acf"));
    GameCandidate {
        path: root.to_string_lossy().into_owned(),
        valid: missing.is_empty(),
        missing,
        manifest_present: manifest.is_some_and(|path| path.is_file()),
    }
}

pub fn discover_at(steam_roots: &[PathBuf]) -> Result<Vec<GameCandidate>, String> {
    let mut libraries = steam_roots.to_vec();
    for root in steam_roots {
        let vdf = root.join("steamapps/libraryfolders.vdf");
        if vdf.is_file() {
            libraries.extend(library_paths(
                &fs::read_to_string(vdf).map_err(|_| "Cannot read Steam libraries")?,
            )?);
        }
    }
    libraries.sort();
    libraries.dedup();
    Ok(libraries
        .into_iter()
        .map(|root| root.join("steamapps/common/Gorilla Tag"))
        .filter(|path| path.is_dir())
        .map(|path| validate_game(&path))
        .collect())
}

#[tauri::command]
pub fn discover_game() -> Result<Vec<GameCandidate>, String> {
    let mut roots = Vec::new();
    #[cfg(windows)]
    {
        use winreg::{
            enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
            RegKey,
        };
        for (hive, key, value) in [
            (HKEY_CURRENT_USER, "Software\\Valve\\Steam", "SteamPath"),
            (
                HKEY_LOCAL_MACHINE,
                "SOFTWARE\\WOW6432Node\\Valve\\Steam",
                "InstallPath",
            ),
            (HKEY_LOCAL_MACHINE, "SOFTWARE\\Valve\\Steam", "InstallPath"),
        ] {
            if let Ok(key) = RegKey::predef(hive).open_subkey(key) {
                if let Ok(path) = key.get_value::<String, _>(value) {
                    roots.push(PathBuf::from(path));
                }
            }
        }
    }
    discover_at(&roots)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_old_and_modern_libraries_and_comments() {
        let input = r#""libraryfolders" { "0" { "path" "C:\\Steam" "apps" { "1533390" "1" } } // comment
            "1" "D:\\Games\\Steam Library" }"#;
        let paths = library_paths(input).unwrap();
        assert_eq!(
            paths,
            vec![
                PathBuf::from("C:\\Steam"),
                PathBuf::from("D:\\Games\\Steam Library")
            ]
        );
    }
    #[test]
    fn rejects_malformed_or_ambiguous_vdf() {
        for input in [
            r#""libraryfolders" {"0" "C:""#,
            r#""libraryfolders" {"0" "A" "0" "B"}"#,
        ] {
            assert!(library_paths(input).is_err());
        }
    }
    #[test]
    fn detects_nondefault_library_and_missing_components() {
        let temp = tempfile::tempdir().unwrap();
        let game = temp.path().join("steamapps/common/Gorilla Tag");
        fs::create_dir_all(game.join("Gorilla Tag_Data")).unwrap();
        fs::write(game.join("Gorilla Tag.exe"), b"INERT").unwrap();
        let candidates = discover_at(&[temp.path().to_path_buf()]).unwrap();
        assert_eq!(candidates.len(), 1);
        assert!(!candidates[0].valid);
        assert_eq!(candidates[0].missing, vec!["UnityPlayer.dll"]);
    }
}
