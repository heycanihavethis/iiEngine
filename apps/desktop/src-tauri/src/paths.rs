use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

pub fn scoped_path(root: &Path, relative: &Path) -> io::Result<PathBuf> {
    if !root.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Game root must be absolute",
        ));
    }
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Invalid relative path",
        ));
    }
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy();
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        if name.contains([':', '<', '>', '"', '|', '?', '*'])
            || name.ends_with(['.', ' '])
            || name.chars().any(|c| c.is_control())
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Unsafe Windows filename",
            ));
        }
    }
    for ancestor in root.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)?;
        #[cfg(windows)]
        let reparse = {
            use std::os::windows::fs::MetadataExt;
            metadata.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let reparse = false;
        if metadata.file_type().is_symlink() || reparse {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Game root contains a link or junction",
            ));
        }
    }
    let root = fs::canonicalize(root)?;
    let mut current = root.clone();
    for component in relative.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                #[cfg(windows)]
                let reparse = {
                    use std::os::windows::fs::MetadataExt;
                    metadata.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let reparse = false;
                if metadata.file_type().is_symlink() || reparse {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "Links and junctions are not allowed",
                    ));
                }
                if !fs::canonicalize(&current)?.starts_with(&root) {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "Path escapes game directory",
                    ));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
    }
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal_and_absolute_paths() {
        let root = tempfile::tempdir().unwrap();
        for path in [
            "../outside",
            "/outside",
            "",
            "file:stream",
            "NUL.txt",
            "trailing.",
            "COM1",
            "a?",
        ] {
            assert!(scoped_path(root.path(), Path::new(path)).is_err());
        }
        assert!(scoped_path(root.path(), Path::new("BepInEx/plugins/menu.dll")).is_ok());
    }
}
