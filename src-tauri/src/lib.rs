use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedCommand {
    program: String,
    args: Vec<String>,
    resolved_path: String,
}

fn candidate_search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default();

    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let base = PathBuf::from(&user_profile);
        dirs.push(base.join(".local").join("bin"));
        dirs.push(base.join(".cargo").join("bin"));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
        let base = PathBuf::from(local_appdata).join("Programs");
        dirs.push(base.join("antigravity").join("bin"));
        dirs.push(base.join("antigravity"));
        dirs.push(base.join("Antigravity IDE").join("bin"));
    }
    dirs
}

fn find_executable(command: &str) -> Option<PathBuf> {
    let direct = Path::new(command);
    if direct.is_absolute() || command.contains('\\') || command.contains('/') {
        if direct.is_file() {
            return Some(direct.to_path_buf());
        }
    }

    let has_ext = direct.extension().is_some();
    let exts = if has_ext {
        vec![""]
    } else {
        vec![".exe", ".cmd", ".bat", ".com", ""]
    };

    for dir in candidate_search_dirs() {
        for ext in &exts {
            let candidate = dir.join(format!("{}{}", command, ext));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn install_hint_for(command: &str) -> &'static str {
    let lower = command.to_ascii_lowercase();
    if lower == "gemini" || lower == "gemini.cmd" {
        "Install Gemini CLI globally with: npm install -g @google/gemini-cli"
    } else if lower == "codex" || lower == "codex.cmd" {
        "Install Codex CLI globally with: npm install -g @openai/codex"
    } else if lower == "claude" || lower == "claude.exe" || lower == "claude.cmd" {
        "Install Claude Code with: npm install -g @anthropic-ai/claude-code"
    } else {
        "Verify the binary is installed and available on your system PATH."
    }
}

#[tauri::command]
fn resolve_cli_command(command: String, args: Vec<String>) -> Result<ResolvedCommand, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("Command cannot be empty.".to_string());
    }

    let found = find_executable(trimmed).ok_or_else(|| {
        format!(
            "Executable \"{}\" was not found on PATH. {}",
            trimmed,
            install_hint_for(trimmed)
        )
    })?;

    let resolved_str = found.to_string_lossy().to_string();
    let ext = found
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    // Windows ConPTY / CreateProcessW cannot directly spawn .cmd/.bat wrappers without cmd.exe /c
    if ext == "cmd" || ext == "bat" {
        let mut wrapped_args = vec!["/C".to_string(), resolved_str.clone()];
        wrapped_args.extend(args);
        Ok(ResolvedCommand {
            program: "cmd.exe".to_string(),
            args: wrapped_args,
            resolved_path: resolved_str,
        })
    } else {
        Ok(ResolvedCommand {
            program: resolved_str.clone(),
            args,
            resolved_path: resolved_str,
        })
    }
}

#[tauri::command]
fn get_default_cwd() -> String {
    std::env::current_dir()
        .ok()
        .and_then(|dir| {
            // If launched from src-tauri during dev, step up to the repo root
            if dir.file_name().and_then(|n| n.to_str()) == Some("src-tauri") {
                dir.parent().map(|p| p.to_path_buf())
            } else {
                Some(dir)
            }
        })
        .unwrap_or_else(|| PathBuf::from("D:\\Thulir Inc"))
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
fn validate_directory(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Working directory path cannot be empty.".to_string());
    }
    let candidate = PathBuf::from(trimmed);
    if !candidate.exists() {
        return Err(format!("Directory does not exist: {}", trimmed));
    }
    if !candidate.is_dir() {
        return Err(format!("Path is not a directory: {}", trimmed));
    }
    Ok(candidate.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_default_cwd,
            validate_directory,
            resolve_cli_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running Agent Cockpit application");
}
