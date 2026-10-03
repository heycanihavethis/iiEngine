use crate::{backup, discovery, health, metadata, paths::scoped_path, transaction};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Output},
};
use tauri::{AppHandle, Manager};

const SOURCE_REPOSITORY: &str = "https://github.com/iireborn/menu.git";
const SOURCE_REF: &str = "1.1.1";
const SOURCE_REF_FALLBACKS: &[&str] = &[SOURCE_REF, "main"];
const TEMPLATE_REPOSITORY: &str = "https://github.com/iireborn/iiTemplate-Updated.git";
const TEMPLATE_REF: &str = "v2.0.0";

fn subprocess_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(unc_path) = text.strip_prefix("\\\\?\\UNC\\") {
            return PathBuf::from(format!("\\\\{unc_path}"));
        }
        return PathBuf::from(text.strip_prefix("\\\\?\\").unwrap_or(text.as_ref()));
    }
    #[cfg(not(windows))]
    path.to_path_buf()
}
const MAX_SOURCE_FILES: usize = 5_000;
const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_TEMPLATE_BYTES: usize = 50 * 1024 * 1024;
const MENU_TARGET: &str = "BepInEx/plugins/ii.Reborn.dll";

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StudioProject {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub source_repository: String,
}

#[derive(Serialize)]
pub struct StudioEnvironment {
    pub ready: bool,
    pub dotnet: Option<String>,
    pub git: Option<String>,
    pub projects_root: String,
}

#[derive(Serialize)]
pub struct StudioFile {
    pub path: String,
    pub name: String,
    pub depth: usize,
    pub kind: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectSource {
    IiTemplate,
    IiStupidMenu,
    OpenSource,
    ZipImport,
    Blank,
}

#[derive(Clone, Serialize)]
pub struct BuildDiagnostic {
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub severity: String,
    pub code: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct StudioBuild {
    pub success: bool,
    pub output: String,
    pub diagnostics: Vec<BuildDiagnostic>,
    pub dll_name: Option<String>,
    pub dll_sha256: Option<String>,
    pub dll_bytes: Option<u64>,
}

#[derive(Serialize)]
pub struct StudioInstall {
    pub operation_id: String,
    pub dll_sha256: String,
    pub plugin_version: String,
}

#[derive(Serialize)]
pub struct StudioLogChunk {
    pub offset: u64,
    pub text: String,
    pub reset: bool,
}

fn command(name: &str) -> Command {
    let mut command = Command::new(name);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn tool_version(name: &str, argument: &str) -> Option<String> {
    let output = command(name).arg(argument).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!value.is_empty()).then_some(value)
}

fn roots(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|_| "Cannot resolve the Documents folder")?;
    let studio = documents.join("ii Engine").join("Studio");
    let projects = studio.join("Projects");
    fs::create_dir_all(&projects).map_err(|_| "Cannot create the ii Studio projects folder")?;
    Ok((studio, projects))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn project_id(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 64 {
        return Err("Project names must contain 1 to 64 characters".into());
    }
    let mut id = String::new();
    let mut separator = false;
    for character in trimmed.chars() {
        if character.is_ascii_alphanumeric() {
            id.push(character.to_ascii_lowercase());
            separator = false;
        } else if matches!(character, ' ' | '-' | '_') && !id.is_empty() && !separator {
            id.push('-');
            separator = true;
        } else if !matches!(character, ' ' | '-' | '_') {
            return Err(
                "Use letters, numbers, spaces, dashes, or underscores in project names".into(),
            );
        }
    }
    while id.ends_with('-') {
        id.pop();
    }
    if !valid_id(&id) {
        return Err("Project name does not produce a safe folder name".into());
    }
    Ok(id)
}

fn project_directory(projects: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Invalid ii Studio project ID".into());
    }
    scoped_path(projects, Path::new(id)).map_err(|_| "Unsafe ii Studio project path".into())
}

fn load_project(projects: &Path, id: &str) -> Result<(StudioProject, PathBuf), String> {
    let directory = project_directory(projects, id)?;
    let metadata = scoped_path(&directory, Path::new("project.json"))
        .map_err(|_| "Unsafe project metadata path")?;
    if fs::metadata(&metadata)
        .map_err(|_| "ii Studio project does not exist")?
        .len()
        > 64 * 1024
    {
        return Err("Project metadata is too large".into());
    }
    let project: StudioProject =
        serde_json::from_slice(&fs::read(metadata).map_err(|_| "Cannot read project metadata")?)
            .map_err(|_| "Project metadata is invalid")?;
    if project.id != id {
        return Err("Project metadata does not match its folder".into());
    }
    Ok((project, directory))
}

fn source_directory(projects: &Path, id: &str) -> Result<PathBuf, String> {
    let (_, directory) = load_project(projects, id)?;
    let source =
        scoped_path(&directory, Path::new("source")).map_err(|_| "Unsafe project source path")?;
    if !source.is_dir() {
        return Err("Project source folder is missing".into());
    }
    Ok(source)
}

fn editable(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "cs" | "csproj"
                    | "sln"
                    | "props"
                    | "targets"
                    | "json"
                    | "xml"
                    | "config"
                    | "md"
                    | "txt"
            )
        })
}

fn walk_source(
    root: &Path,
    relative: &Path,
    files: &mut Vec<StudioFile>,
    depth: usize,
) -> Result<(), String> {
    if depth > 20 || files.len() >= MAX_SOURCE_FILES {
        return Err("Project contains too many source files".into());
    }
    let directory = if relative.as_os_str().is_empty() {
        root.to_path_buf()
    } else {
        scoped_path(root, relative).map_err(|_| "Project contains an unsafe path")?
    };
    let mut entries = fs::read_dir(directory)
        .map_err(|_| "Cannot read project source")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot read a project entry")?;
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if matches!(name.as_str(), ".git" | ".vs" | "bin" | "obj" | "References") {
            continue;
        }
        let next = relative.join(&name);
        let path = scoped_path(root, &next).map_err(|_| "Project contains an unsafe path")?;
        if path.is_dir() {
            files.push(StudioFile {
                path: next.to_string_lossy().replace('\\', "/"),
                name,
                depth,
                kind: "folder".into(),
            });
            walk_source(root, &next, files, depth + 1)?;
        } else if editable(&path) {
            files.push(StudioFile {
                path: next.to_string_lossy().replace('\\', "/"),
                name,
                depth,
                kind: "file".into(),
            });
        }
    }
    Ok(())
}

fn safe_repository(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value.trim())
        .map_err(|_| "Enter a valid open-source repository URL")?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("github.com") | Some("gitlab.com"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path().trim_matches('/').is_empty()
    {
        return Err("Use a public HTTPS GitHub or GitLab repository URL".into());
    }
    Ok(url.into())
}

fn clone_menu_source(destination: &Path) -> Result<String, String> {
    let mut last_detail = String::from("No clone refs were attempted");
    for git_ref in SOURCE_REF_FALLBACKS {
        if destination.exists() {
            let _ = fs::remove_dir_all(destination);
        }
        let result = command("git")
            .args([
                "clone",
                "--depth",
                "1",
                "--single-branch",
                "--branch",
                git_ref,
                SOURCE_REPOSITORY,
            ])
            .arg(subprocess_path(destination))
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|_| "Git is required to create a project from the ii source")?;
        if result.status.success() {
            return Ok(format!("{SOURCE_REPOSITORY}#{git_ref}"));
        }
        last_detail = bounded_output(result);
        let _ = fs::remove_dir_all(destination);
    }
    Err(format!("Could not copy the ii source. {last_detail}"))
}

fn unpack_template(bytes: &[u8], destination: &Path) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_TEMPLATE_BYTES {
        return Err("The project archive exceeds the Studio size limit".into());
    }
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "The project ZIP is invalid")?;
    if archive.len() > MAX_SOURCE_FILES {
        return Err("The project archive contains too many files".into());
    }
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "Cannot read the project ZIP")?;
        let relative = entry
            .enclosed_name()
            .ok_or("The project archive contains an unsafe path")?;
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("The project archive contains an unsafe path".into());
        }
        let target = scoped_path(destination, &relative)
            .map_err(|_| "The project archive contains an unsafe path")?;
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|_| "Cannot create a project archive folder")?;
            continue;
        }
        expanded = expanded.saturating_add(entry.size());
        if expanded > 150 * 1024 * 1024 {
            return Err("The project archive expands beyond the Studio size limit".into());
        }
        let parent = target
            .parent()
            .ok_or("Invalid project archive destination")?;
        fs::create_dir_all(parent).map_err(|_| "Cannot create a project archive folder")?;
        let mut output =
            File::create_new(&target).map_err(|_| "Cannot create a project archive file")?;
        std::io::copy(&mut entry, &mut output).map_err(|_| "Cannot unpack the project archive")?;
        output
            .sync_all()
            .map_err(|_| "Cannot save the project archive")?;
    }
    Ok(())
}

fn create_blank_source(source: &Path, project_name: &str) -> Result<(), String> {
    fs::create_dir_all(source).map_err(|_| "Cannot create the blank project source folder")?;
    let assembly_name = project_id(project_name)?.replace('-', "");
    let project = format!(
        "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n    <TargetFramework>netstandard2.1</TargetFramework>\n    <AssemblyName>{assembly_name}</AssemblyName>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include=\"BepInEx.Core\" Version=\"5.4.23\" />\n  </ItemGroup>\n</Project>\n"
    );
    let source_file = format!(
        "using BepInEx;\n\nnamespace IiStudio;\n\n[BepInPlugin(\"com.iiengine.{assembly_name}\", \"{project_name}\", \"0.1.0\")]\npublic sealed class Plugin : BaseUnityPlugin\n{{\n    private void Awake()\n    {{\n        Logger.LogInfo(\"{project_name} loaded.\");\n    }}\n}}\n"
    );
    fs::write(source.join("StudioMod.csproj"), project)
        .map_err(|_| "Cannot create the blank project file")?;
    fs::write(source.join("Plugin.cs"), source_file)
        .map_err(|_| "Cannot create the blank source file")?;
    Ok(())
}

fn project_file(source: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.len() > 500 {
        return Err("Source path is too long".into());
    }
    let relative = Path::new(relative);
    let path = scoped_path(source, relative).map_err(|_| "Unsafe project source path")?;
    if !editable(&path) {
        return Err("That file type cannot be edited in ii Studio".into());
    }
    Ok(path)
}

fn bounded_output(output: Output) -> String {
    let mut combined = output.stdout;
    combined.extend_from_slice(&output.stderr);
    if combined.len() > MAX_OUTPUT_BYTES {
        combined = combined.split_off(combined.len() - MAX_OUTPUT_BYTES);
        let mut prefix = b"[Earlier compiler output omitted]\n".to_vec();
        prefix.extend(combined);
        combined = prefix;
    }
    String::from_utf8_lossy(&combined).into_owned()
}

fn relative_diagnostic_file(source: &Path, value: &str) -> String {
    let path = Path::new(value.trim());
    if path.is_absolute() {
        if let Ok(relative) = path.strip_prefix(source) {
            return relative.to_string_lossy().replace('\\', "/");
        }
    }
    value.trim().replace('\\', "/")
}

fn parse_diagnostics(source: &Path, output: &str) -> Vec<BuildDiagnostic> {
    let mut diagnostics = Vec::new();
    for line in output.lines() {
        let Some(location_end) = line.find("): ") else {
            continue;
        };
        let before = &line[..location_end];
        let Some(location_start) = before.rfind('(') else {
            continue;
        };
        let positions = &before[location_start + 1..];
        let mut positions = positions.split(',');
        let (Ok(row), Ok(column)) = (
            positions.next().unwrap_or_default().parse::<u32>(),
            positions.next().unwrap_or("1").parse::<u32>(),
        ) else {
            continue;
        };
        let detail = &line[location_end + 3..];
        let (severity, rest) = if let Some(rest) = detail.strip_prefix("error ") {
            ("error", rest)
        } else if let Some(rest) = detail.strip_prefix("warning ") {
            ("warning", rest)
        } else {
            continue;
        };
        let Some(colon) = rest.find(": ") else {
            continue;
        };
        let message = rest[colon + 2..]
            .split(" [")
            .next()
            .unwrap_or_default()
            .trim()
            .to_owned();
        diagnostics.push(BuildDiagnostic {
            file: relative_diagnostic_file(source, &before[..location_start]),
            line: row,
            column,
            severity: severity.into(),
            code: rest[..colon].trim().into(),
            message,
        });
    }
    diagnostics.sort_by(|a, b| (&a.file, a.line, a.column).cmp(&(&b.file, b.line, b.column)));
    diagnostics.dedup_by(|a, b| {
        a.file == b.file
            && a.line == b.line
            && a.column == b.column
            && a.code == b.code
            && a.message == b.message
    });
    diagnostics
}

fn find_build_entry(source: &Path) -> Result<PathBuf, String> {
    let mut solutions = Vec::new();
    let mut projects = Vec::new();
    for entry in fs::read_dir(source).map_err(|_| "Cannot inspect project source")? {
        let entry = entry.map_err(|_| "Cannot inspect project source")?;
        let path = scoped_path(source, Path::new(&entry.file_name()))
            .map_err(|_| "Project build entry has an unsafe path")?;
        match path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("sln") => solutions.push(path),
            Some("csproj") => projects.push(path),
            _ => (),
        }
    }
    solutions.sort();
    projects.sort();
    solutions
        .into_iter()
        .next()
        .or_else(|| projects.into_iter().next())
        .ok_or_else(|| "The project has no .sln or .csproj build entry".into())
}

fn find_menu_dll(directory: &Path) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if directory.is_dir() {
        for entry in fs::read_dir(directory).map_err(|_| "Cannot inspect compiler output")? {
            let entry = entry.map_err(|_| "Cannot inspect compiler output")?;
            let path = scoped_path(directory, Path::new(&entry.file_name()))
                .map_err(|_| "Compiler output contains an unsafe path")?;
            if path.is_file()
                && path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("dll"))
            {
                candidates.push(path);
            }
        }
    }
    candidates.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    candidates.reverse();
    candidates
        .into_iter()
        .find(|path| {
            fs::metadata(path)
                .is_ok_and(|value| value.len() <= 100 * 1024 * 1024)
                .then(|| fs::read(path).ok())
                .flatten()
                .and_then(|bytes| metadata::inspect(&bytes).ok())
                .is_some_and(|assembly| {
                    assembly
                        .plugins
                        .iter()
                        .filter(|plugin| metadata::is_menu_guid(&plugin.guid))
                        .count()
                        == 1
                })
        })
        .ok_or_else(|| "Build succeeded but no valid ii menu DLL was produced".into())
}

fn rollback_install(
    app_root: &Path,
    game: &Path,
    backups: &Path,
    operation_id: &str,
    scopes: &[String],
) -> Result<(), String> {
    let safety = backup::preview(game, scopes, &[], "studio-install-rollback")?;
    transaction::restore(app_root, game, backups, operation_id, &safety, &[]).map(|_| ())
}

#[tauri::command]
pub fn studio_environment(app: AppHandle) -> Result<StudioEnvironment, String> {
    let (_, projects) = roots(&app)?;
    let dotnet = tool_version("dotnet", "--version");
    let git = tool_version("git", "--version");
    Ok(StudioEnvironment {
        ready: dotnet.is_some() && git.is_some(),
        dotnet,
        git,
        projects_root: projects.to_string_lossy().into_owned(),
    })
}

#[derive(Serialize)]
pub struct StudioDependencyInstall {
    pub started: Vec<String>,
    pub opened: Vec<String>,
    pub message: String,
}

#[tauri::command]
pub fn studio_install_dependencies() -> Result<StudioDependencyInstall, String> {
    let mut started = Vec::new();
    let mut opened = Vec::new();
    let need_dotnet = tool_version("dotnet", "--version").is_none();
    let need_git = tool_version("git", "--version").is_none();
    if !need_dotnet && !need_git {
        return Ok(StudioDependencyInstall {
            started,
            opened,
            message: "All Studio dependencies are already installed.".into(),
        });
    }

    #[cfg(windows)]
    {
        let winget = tool_version("winget", "--version");
        if winget.is_some() {
            if need_dotnet {
                let ok = Command::new("winget")
                    .args([
                        "install",
                        "--id",
                        "Microsoft.DotNet.SDK.8",
                        "-e",
                        "--accept-package-agreements",
                        "--accept-source-agreements",
                    ])
                    .spawn()
                    .is_ok();
                if ok {
                    started.push(".NET SDK 8".into());
                }
            }
            if need_git {
                let ok = Command::new("winget")
                    .args([
                        "install",
                        "--id",
                        "Git.Git",
                        "-e",
                        "--accept-package-agreements",
                        "--accept-source-agreements",
                    ])
                    .spawn()
                    .is_ok();
                if ok {
                    started.push("Git for Windows".into());
                }
            }
        }
    }

    if need_dotnet && !started.iter().any(|item| item.contains(".NET")) {
        let url = "https://dotnet.microsoft.com/download";
        open::that(url).map_err(|_| "Could not open the .NET download page")?;
        opened.push(url.into());
    }
    if need_git && !started.iter().any(|item| item.contains("Git")) {
        let url = "https://git-scm.com/downloads/win";
        open::that(url).map_err(|_| "Could not open the Git download page")?;
        opened.push(url.into());
    }

    let message = if !started.is_empty() {
        format!(
            "Started installing {}. Finish any installer prompts, then click Refresh.",
            started.join(" and ")
        )
    } else {
        "Opened the official download pages for missing tools. Install them, then click Refresh."
            .into()
    };
    Ok(StudioDependencyInstall {
        started,
        opened,
        message,
    })
}

#[tauri::command]
pub fn studio_open_projects_folder(app: AppHandle) -> Result<(), String> {
    let (_, projects) = roots(&app)?;
    open::that(projects).map_err(|_| "Could not open the ii Studio projects folder".into())
}

#[tauri::command]
pub fn studio_list_projects(app: AppHandle) -> Result<Vec<StudioProject>, String> {
    let (_, projects) = roots(&app)?;
    let mut result = Vec::new();
    for entry in fs::read_dir(&projects).map_err(|_| "Cannot list ii Studio projects")? {
        let entry = entry.map_err(|_| "Cannot inspect an ii Studio project")?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if entry.path().is_dir() && valid_id(&id) {
            if let Ok((project, _)) = load_project(&projects, &id) {
                result.push(project);
            }
        }
    }
    result.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    Ok(result)
}

#[tauri::command]
pub async fn studio_create_project(
    app: AppHandle,
    name: String,
    source: ProjectSource,
    repository_url: Option<String>,
    template_download_url: Option<String>,
    zip_bytes: Option<Vec<u8>>,
) -> Result<StudioProject, String> {
    let (_, projects) = roots(&app)?;
    let _ = template_download_url;
    let template = match &source {
        ProjectSource::ZipImport => {
            let bytes = zip_bytes.ok_or("Choose a ZIP file to import")?;
            if bytes.is_empty() || bytes.len() > MAX_TEMPLATE_BYTES {
                return Err("Choose a ZIP under 50 MB".into());
            }
            Some(bytes)
        }
        _ => None,
    };
    let repository = match &source {
        ProjectSource::OpenSource => Some(safe_repository(
            repository_url
                .as_deref()
                .ok_or("Enter an open-source repository URL")?,
        )?),
        _ => None,
    };
    let project_source = source.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let id = project_id(&name)?;
        let directory = project_directory(&projects, &id)?;
        if directory.exists() {
            return Err("A project with that name already exists".into());
        }
        fs::create_dir(&directory).map_err(|_| "Cannot create the project folder")?;
        let source = directory.join("source");
        let builds = directory.join("builds");
        fs::create_dir(&builds).map_err(|_| "Cannot create the project builds folder")?;
        let source_repository = match project_source {
            ProjectSource::IiStupidMenu => match clone_menu_source(&source) {
                Ok(label) => label,
                Err(error) => {
                    let _ = fs::remove_dir_all(&directory);
                    return Err(error);
                }
            },
            ProjectSource::OpenSource => {
                let repository = repository
                    .as_deref()
                    .ok_or("Open-source repository is missing")?;
                let result = command("git")
                    .args(["clone", "--depth", "1", repository])
                    .arg(subprocess_path(&source))
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .output()
                    .map_err(|_| "Git is required to import an open-source project")?;
                if !result.status.success() {
                    let detail = bounded_output(result);
                    let _ = fs::remove_dir_all(&directory);
                    return Err(format!(
                        "Could not import the open-source project. {detail}"
                    ));
                }
                repository.to_owned()
            }
            ProjectSource::IiTemplate => {
                let result = command("git")
                    .args([
                        "clone",
                        "--depth",
                        "1",
                        "--single-branch",
                        "--branch",
                        TEMPLATE_REF,
                        TEMPLATE_REPOSITORY,
                    ])
                    .arg(subprocess_path(&source))
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .output()
                    .map_err(|_| "Git is required to create a project from the ii template")?;
                if !result.status.success() {
                    let detail = bounded_output(result);
                    let _ = fs::remove_dir_all(&directory);
                    return Err(format!("Could not download the ii template. {detail}"));
                }
                format!("{TEMPLATE_REPOSITORY}#{TEMPLATE_REF}")
            }
            ProjectSource::ZipImport => {
                let archive = template.as_deref().ok_or("ZIP import bytes are missing")?;
                if let Err(error) = unpack_template(archive, &source) {
                    let _ = fs::remove_dir_all(&directory);
                    return Err(error);
                }
                "Imported ZIP project".into()
            }
            ProjectSource::Blank => {
                if let Err(error) = create_blank_source(&source, name.trim()) {
                    let _ = fs::remove_dir_all(&directory);
                    return Err(error);
                }
                "Blank BepInEx project".into()
            }
        };
        let project = StudioProject {
            id,
            name: name.trim().to_owned(),
            created_at: Utc::now().to_rfc3339(),
            source_repository,
        };
        let mut metadata = File::create_new(directory.join("project.json"))
            .map_err(|_| "Cannot create project metadata")?;
        metadata
            .write_all(
                &serde_json::to_vec_pretty(&project)
                    .map_err(|_| "Cannot encode project metadata")?,
            )
            .and_then(|_| metadata.sync_all())
            .map_err(|_| "Cannot save project metadata")?;
        Ok(project)
    })
    .await
    .map_err(|_| "Project creation stopped unexpectedly".to_string())?
}

#[tauri::command]
pub fn studio_create_folder(
    app: AppHandle,
    project_id: String,
    path: String,
) -> Result<(), String> {
    if path.len() > 500 || Path::new(&path).components().count() > 20 {
        return Err("Folder path is too long".into());
    }
    let (_, projects) = roots(&app)?;
    let source = source_directory(&projects, &project_id)?;
    let relative = Path::new(&path);
    if relative.as_os_str().is_empty()
        || !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("Folder path is unsafe".into());
    }
    let target = scoped_path(&source, relative).map_err(|_| "Folder path is unsafe")?;
    if target.exists() {
        return Err("That folder already exists".into());
    }
    fs::create_dir_all(target).map_err(|_| "Cannot create the source folder".into())
}

#[tauri::command]
pub fn studio_create_file(app: AppHandle, project_id: String, path: String) -> Result<(), String> {
    let (_, projects) = roots(&app)?;
    let source = source_directory(&projects, &project_id)?;
    let target = project_file(&source, &path)?;
    if target.exists() {
        return Err("That file already exists".into());
    }
    let parent = target.parent().ok_or("Invalid source file path")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot create the source folder")?;
    File::create_new(target)
        .and_then(|file| file.sync_all())
        .map_err(|_| "Cannot create the source file".into())
}

#[tauri::command]
pub fn studio_list_files(app: AppHandle, project_id: String) -> Result<Vec<StudioFile>, String> {
    let (_, projects) = roots(&app)?;
    let source = source_directory(&projects, &project_id)?;
    let mut files = Vec::new();
    walk_source(&source, Path::new(""), &mut files, 0)?;
    Ok(files)
}

#[tauri::command]
pub fn studio_read_file(
    app: AppHandle,
    project_id: String,
    path: String,
) -> Result<String, String> {
    let (_, projects) = roots(&app)?;
    let source = source_directory(&projects, &project_id)?;
    let path = project_file(&source, &path)?;
    let metadata = fs::metadata(&path).map_err(|_| "Source file does not exist")?;
    if !metadata.is_file() || metadata.len() > MAX_TEXT_BYTES {
        return Err("Source file is not a bounded text file".into());
    }
    fs::read_to_string(path).map_err(|_| "Source file is not valid UTF-8 text".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioSearchHit {
    pub path: String,
    pub line: usize,
    pub snippet: String,
}

#[tauri::command]
pub fn studio_find_mod_source(
    app: AppHandle,
    project_id: String,
    mod_name: String,
) -> Result<Option<StudioSearchHit>, String> {
    let needle = mod_name.trim();
    if needle.is_empty() || needle.len() > 180 {
        return Err("Mod name is invalid".into());
    }
    let (_, projects) = roots(&app)?;
    let source = source_directory(&projects, &project_id)?;
    let mut files = Vec::new();
    walk_source(&source, Path::new(""), &mut files, 0)?;
    let mut ranked: Vec<(i32, &StudioFile)> = files
        .iter()
        .filter(|file| {
            file.kind != "folder"
                && file
                    .path
                    .rsplit_once('.')
                    .map(|(_, ext)| ext.eq_ignore_ascii_case("cs"))
                    .unwrap_or(false)
        })
        .map(|file| {
            let lower = file.path.to_ascii_lowercase();
            let mut score = 0;
            if lower.ends_with("buttons.cs") {
                score += 100;
            }
            if lower.contains("/menu/") || lower.starts_with("menu/") {
                score += 40;
            }
            if lower.contains("/mods/") || lower.starts_with("mods/") {
                score += 30;
            }
            (score, file)
        })
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.path.cmp(&b.1.path)));

    let button_exact = format!("buttonText=\"{needle}\"");
    let button_exact_spaced = format!("buttonText = \"{needle}\"");
    let quoted = format!("\"{needle}\"");

    for (_, file) in ranked {
        let absolute = project_file(&source, &file.path)?;
        let metadata = match fs::metadata(&absolute) {
            Ok(meta) if meta.is_file() && meta.len() <= MAX_TEXT_BYTES => meta,
            _ => continue,
        };
        let _ = metadata;
        let Ok(content) = fs::read_to_string(&absolute) else {
            continue;
        };
        let mut best: Option<(i32, usize, String)> = None;
        for (index, line) in content.lines().enumerate() {
            let score = if line.contains(&button_exact) || line.contains(&button_exact_spaced) {
                300
            } else if line.contains(&quoted) {
                120
            } else if line
                .to_ascii_lowercase()
                .contains(&needle.to_ascii_lowercase())
            {
                40
            } else {
                0
            };
            if score == 0 {
                continue;
            }
            let candidate = (score, index + 1, line.trim().chars().take(220).collect());
            if best.as_ref().map(|item| item.0).unwrap_or(0) < candidate.0 {
                best = Some(candidate);
            }
            if score >= 300 {
                break;
            }
        }
        if let Some((_, line, snippet)) = best {
            return Ok(Some(StudioSearchHit {
                path: file.path.clone(),
                line,
                snippet,
            }));
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn studio_save_file(
    app: AppHandle,
    project_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    if content.len() as u64 > MAX_TEXT_BYTES {
        return Err("Source file exceeds the ii Studio size limit".into());
    }
    let (_, projects) = roots(&app)?;
    let source = source_directory(&projects, &project_id)?;
    let path = project_file(&source, &path)?;
    if !path.is_file() {
        return Err("ii Studio only saves existing project files".into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|_| "Cannot open the source file for saving")?;
    file.write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot save the source file".into())
}

#[tauri::command]
pub async fn studio_build_project(
    app: AppHandle,
    project_id: String,
) -> Result<StudioBuild, String> {
    let (_, projects) = roots(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (_, directory) = load_project(&projects, &project_id)?;
        let source = source_directory(&projects, &project_id)?;
        let entry = find_build_entry(&source)?;
        let builds = scoped_path(&directory, Path::new("builds"))
            .map_err(|_| "Unsafe project builds path")?;
        fs::create_dir_all(&builds).map_err(|_| "Cannot create the builds folder")?;
        let compiler_output = builds.join(".compiler-output");
        if compiler_output.exists() {
            fs::remove_dir_all(&compiler_output)
                .map_err(|_| "Cannot clear the previous compiler output")?;
        }
        fs::create_dir(&compiler_output).map_err(|_| "Cannot create compiler output")?;
        let result = command("dotnet")
            .arg("build")
            .arg(subprocess_path(&entry))
            .args([
                "--configuration",
                "Release",
                "--nologo",
                "--verbosity:minimal",
            ])
            .arg(format!(
                "-p:PluginsPath={}",
                subprocess_path(&compiler_output).display()
            ))
            .current_dir(subprocess_path(&source))
            .env("DOTNET_CLI_TELEMETRY_OPTOUT", "1")
            .env("DOTNET_NOLOGO", "1")
            .output()
            .map_err(|_| "The .NET SDK is required to build ii projects")?;
        let success = result.status.success();
        let output = bounded_output(result);
        let diagnostics = parse_diagnostics(&source, &output);
        if !success {
            return Ok(StudioBuild {
                success: false,
                output,
                diagnostics,
                dll_name: None,
                dll_sha256: None,
                dll_bytes: None,
            });
        }
        let compiled = find_menu_dll(&compiler_output)?;
        let bytes = fs::read(&compiled).map_err(|_| "Cannot read the compiled menu DLL")?;
        let assembly = metadata::inspect(&bytes)?;
        if assembly
            .plugins
            .iter()
            .filter(|plugin| metadata::is_menu_guid(&plugin.guid))
            .count()
            != 1
        {
            return Err("Compiled DLL does not contain exactly one ii menu plugin".into());
        }
        let timestamp = Utc::now().format("%Y%m%d-%H%M%S-%3f");
        let dll_name = format!("ii-menu-{timestamp}.dll");
        let destination =
            scoped_path(&builds, Path::new(&dll_name)).map_err(|_| "Unsafe build destination")?;
        fs::copy(&compiled, &destination).map_err(|_| "Cannot save the compiled menu DLL")?;
        let (size, sha256) = backup::hash_file(&destination)?;
        Ok(StudioBuild {
            success: true,
            output,
            diagnostics,
            dll_name: Some(dll_name),
            dll_sha256: Some(sha256),
            dll_bytes: Some(size),
        })
    })
    .await
    .map_err(|_| "Build worker stopped unexpectedly".to_string())?
}

#[tauri::command]
pub async fn studio_install_build(
    app: AppHandle,
    project_id: String,
    dll_name: String,
    game_path: String,
) -> Result<StudioInstall, String> {
    let (_, projects) = roots(&app)?;
    let app_root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot resolve ii Engine local data directory")?;
    tauri::async_runtime::spawn_blocking(move || {
        if health::running() {
            return Err("Close Gorilla Tag before installing a Studio build".into());
        }
        let game = fs::canonicalize(game_path)
            .map_err(|_| "Cannot resolve the selected Gorilla Tag folder")?;
        if !discovery::validate_game(&game).valid {
            return Err("Select a valid Gorilla Tag installation".into());
        }
        let (_, directory) = load_project(&projects, &project_id)?;
        if Path::new(&dll_name).file_name().and_then(|value| value.to_str())
            != Some(dll_name.as_str())
            || !dll_name.to_ascii_lowercase().ends_with(".dll")
        {
            return Err("Invalid Studio build name".into());
        }
        let builds = scoped_path(&directory, Path::new("builds"))
            .map_err(|_| "Unsafe project builds path")?;
        let build = scoped_path(&builds, Path::new(&dll_name))
            .map_err(|_| "Unsafe Studio build path")?;
        let bytes = fs::read(&build).map_err(|_| "Studio build does not exist")?;
        let assembly = metadata::inspect(&bytes)?;
        let plugins: Vec<_> = assembly
            .plugins
            .into_iter()
            .filter(|plugin| metadata::is_menu_guid(&plugin.guid))
            .collect();
        if plugins.len() != 1 {
            return Err("Studio build does not contain exactly one ii menu plugin".into());
        }
        let plugin_version = plugins[0].version.clone();
        let digest = hex::encode(Sha256::digest(&bytes));
        let backups = app_root.join("Backups");
        let staging_root = app_root.join("StudioStaging");
        fs::create_dir_all(&backups).map_err(|_| "Cannot create the backup folder")?;
        fs::create_dir_all(&staging_root).map_err(|_| "Cannot create Studio staging")?;
        let token = hex::encode(rand::random::<[u8; 16]>());
        let source = scoped_path(&staging_root, Path::new(&token))
            .map_err(|_| "Unsafe Studio staging path")?;
        let staged = source.join(MENU_TARGET);
        fs::create_dir_all(staged.parent().ok_or("Invalid Studio staging path")?)
            .map_err(|_| "Cannot create Studio staging folders")?;
        let mut output = File::create_new(&staged).map_err(|_| "Cannot stage the Studio DLL")?;
        output
            .write_all(&bytes)
            .and_then(|_| output.sync_all())
            .map_err(|_| "Cannot stage the Studio DLL")?;
        if backup::hash_file(&staged)?.1 != digest {
            return Err("Studio DLL changed while it was being staged".into());
        }
        let mut scopes = vec![MENU_TARGET.to_owned()];
        for file in health::inspect(&game)?.files.into_iter().filter(|file| file.menu) {
            let relative = file.name.replace('\\', "/");
            if !scopes.iter().any(|scope| scope.eq_ignore_ascii_case(&relative)) {
                scopes.push(relative);
            }
        }
        scopes.sort_by_key(|scope| scope.to_ascii_lowercase());
        let preview = backup::preview(&game, &scopes, &[], "install-studio-build")?;
        let operation_id = preview.operation_id.clone();
        let installation = transaction::execute(
            &app_root,
            &game,
            &backups,
            &preview,
            &source,
            &[],
        );
        let _ = fs::remove_dir_all(&source);
        if let Err(install_error) = installation {
            if !backups.join(&operation_id).is_dir() {
                return Err(format!(
                    "Studio installation stopped before game files changed: {install_error}"
                ));
            }
            return match rollback_install(&app_root, &game, &backups, &operation_id, &scopes) {
                Ok(_) => Err(format!(
                    "Studio installation failed and the previous menu was restored: {install_error}"
                )),
                Err(restore_error) => Err(format!(
                    "Studio installation failed. Recovery is preserved in Backups: {install_error}. Automatic restore also failed: {restore_error}"
                )),
            };
        }
        let verified = backup::hash_file(&game.join(MENU_TARGET))
            .is_ok_and(|(_, installed_hash)| installed_hash == digest);
        if !verified {
            return match rollback_install(&app_root, &game, &backups, &operation_id, &scopes) {
                Ok(_) => Err(
                    "Installed Studio DLL failed final verification and the previous menu was restored"
                        .into(),
                ),
                Err(restore_error) => Err(format!(
                    "Installed Studio DLL failed final verification. Recovery is preserved in Backups, but automatic restore also failed: {restore_error}"
                )),
            };
        }
        backup::prune_successful(&backups)?;
        Ok(StudioInstall {
            operation_id,
            dll_sha256: digest,
            plugin_version,
        })
    })
    .await
    .map_err(|_| "Studio installation worker stopped unexpectedly".to_string())?
}

#[tauri::command]
pub fn studio_read_log(game_path: String, offset: u64) -> Result<StudioLogChunk, String> {
    let game = fs::canonicalize(game_path)
        .map_err(|_| "Cannot resolve the selected Gorilla Tag folder")?;
    if !discovery::validate_game(&game).valid {
        return Err("Select a valid Gorilla Tag installation".into());
    }
    let path = scoped_path(&game, Path::new("BepInEx/LogOutput.log"))
        .map_err(|_| "Unsafe BepInEx log path")?;
    if !path.is_file() {
        return Ok(StudioLogChunk {
            offset: 0,
            text: String::new(),
            reset: offset > 0,
        });
    }
    let length = fs::metadata(&path)
        .map_err(|_| "Cannot inspect the BepInEx log")?
        .len();
    let (start, reset) = if offset > length {
        (0, true)
    } else {
        (offset, false)
    };
    let mut file = File::open(path).map_err(|_| "Cannot open the BepInEx log")?;
    file.seek(SeekFrom::Start(start))
        .map_err(|_| "Cannot seek in the BepInEx log")?;
    let mut bytes = Vec::new();
    file.take(256 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read the BepInEx log")?;
    Ok(StudioLogChunk {
        offset: start + bytes.len() as u64,
        text: String::from_utf8_lossy(&bytes).into_owned(),
        reset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_names_are_scoped_folder_ids() {
        assert_eq!(project_id("My First_Menu").unwrap(), "my-first-menu");
        for invalid in ["", "../escape", "name!", "   "] {
            assert!(project_id(invalid).is_err());
        }
    }

    #[test]
    fn compiler_errors_link_to_source_lines() {
        let source = Path::new(r"C:\Projects\Demo\source");
        let output = r"C:\Projects\Demo\source\Mods\Test.cs(42,9): error CS1002: ; expected [C:\Projects\Demo\source\iiMenu.csproj]";
        let diagnostics = parse_diagnostics(source, output);
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].file, "Mods/Test.cs");
        assert_eq!(diagnostics[0].line, 42);
        assert_eq!(diagnostics[0].code, "CS1002");
    }

    #[cfg(windows)]
    #[test]
    fn subprocess_paths_are_compatible_with_windows_build_tools() {
        assert_eq!(
            subprocess_path(Path::new(
                r"\\?\C:\Users\Name\OneDrive\source\iiMenu.csproj"
            )),
            PathBuf::from(r"C:\Users\Name\OneDrive\source\iiMenu.csproj")
        );
        assert_eq!(
            subprocess_path(Path::new(r"\\?\UNC\server\share\source")),
            PathBuf::from(r"\\server\share\source")
        );
    }
}
