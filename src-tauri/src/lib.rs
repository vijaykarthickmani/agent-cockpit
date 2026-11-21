use std::path::PathBuf;

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
            validate_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running Agent Cockpit application");
}
