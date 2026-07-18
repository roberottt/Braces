pub mod ai;
pub mod config;
pub mod context;
pub mod db;
pub mod git;
pub mod metrics;
pub mod pty;
pub mod vault;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Replace the default macOS menu: it includes File > Close Window
            // bound to Cmd+W, which swallows the shortcut before it reaches the
            // webview and closes the whole window. Rebuild the standard menus
            // without that item so the frontend can use Cmd+W to close tabs.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};

                let handle = app.handle();
                let pkg = handle.package_info();
                let about = AboutMetadataBuilder::new()
                    .name(Some(pkg.name.clone()))
                    .version(Some(pkg.version.to_string()))
                    .build();
                let app_menu = SubmenuBuilder::new(handle, pkg.name.clone())
                    .about(Some(about))
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;
                let edit_menu = SubmenuBuilder::new(handle, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let window_menu = SubmenuBuilder::new(handle, "Window")
                    .minimize()
                    .maximize()
                    .separator()
                    .fullscreen()
                    .build()?;
                let menu = MenuBuilder::new(handle)
                    .items(&[&app_menu, &edit_menu, &window_menu])
                    .build()?;
                app.set_menu(menu)?;
            }

            let cfg = config::Config::load().unwrap_or_default();
            app.manage(cfg);

            app.manage(pty::commands::PtyState::new());

            // Set the window icon explicitly so the taskbar shows the correct icon
            // in both dev mode and production (bundle.icon only applies to the installer).
            if let Some(window) = app.get_webview_window("main") {
                let png_bytes = include_bytes!("../icons/128x128.png");
                if let Ok(decoded) = image::load_from_memory(png_bytes) {
                    let rgba = decoded.into_rgba8();
                    let (w, h) = rgba.dimensions();
                    let icon = tauri::image::Image::new_owned(rgba.into_raw(), w, h);
                    let _ = window.set_icon(icon);
                }
            }

            let store_path = dirs_next::config_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("braces")
                .join("context.json");
            app.manage(context::ContextStore::load(store_path));

            let db_path = dirs_next::config_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("braces")
                .join("braces.db");
            app.manage(db::Db::open(db_path));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // PTY
            pty::commands::pty_spawn,
            pty::commands::pty_write,
            pty::commands::pty_resize,
            pty::commands::pty_kill,
            pty::commands::pty_get_output,
            pty::commands::pty_shell_type,
            pty::commands::pty_home_dir,
            // Vault
            commands::vault_set_key,
            commands::vault_has_key,
            commands::save_temp_image,
            // Config
            commands::get_config,
            // AI
            ai::agent::ai_agent,
            ai::commands::ai_chat,
            ai::commands::ai_nl_to_shell,
            ai::commands::ai_autocomplete,
            ai::commands::ai_suggest_next,
            ai::commands::ai_analyze_error,
            ai::commands::ai_query_processes,
            // RAG + History
            ai::commands::rag_index,
            ai::commands::rag_query,
            ai::commands::history_add,
            ai::commands::history_search,
            // Metrics
            ai::commands::get_metrics,
            // Shell completion
            commands::shell_complete,
            // Filesystem (editor)
            commands::fs_read_file,
            commands::fs_write_file,
            // DB persistence
            db::db_load_tabs,
            db::db_save_tabs,
            db::db_delete_tab,
            db::db_load_blocks,
            db::db_save_blocks,
            db::db_list_chats,
            db::db_load_chat,
            db::db_save_chat,
            db::db_create_chat,
            db::db_delete_chat,
            db::db_get_active_chat,
            db::db_set_active_chat,
            // Git
            git::commands::git_is_repo,
            git::commands::git_status,
            git::commands::git_branch_info,
            git::commands::git_diff_file,
            git::commands::git_stage,
            git::commands::git_unstage,
            git::commands::git_discard,
            git::commands::git_stage_all,
            git::commands::git_commit,
            git::commands::git_dir_children,
            git::commands::git_diff_all,
            git::commands::git_checkout,
            git::commands::git_push,
            git::commands::git_pull,
            git::commands::git_fetch,
            git::commands::git_log,
            git::commands::git_commit_files,
            git::commands::git_show_file,
            git::commands::git_branches,
            git::commands::git_branch_create,
            git::commands::git_branch_delete,
            git::commands::git_stash_list,
            git::commands::git_stash_push,
            git::commands::git_stash_apply,
            git::commands::git_stash_drop,
        ])
        .run(tauri::generate_context!())
        .expect("braces failed to start");
}

mod commands {
    use crate::{config::Config, vault::Vault};
    use tauri::State;

    #[tauri::command]
    pub fn vault_set_key(provider: String, key: String) -> Result<(), String> {
        Vault::set(&provider, &key).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn vault_has_key(provider: String) -> bool {
        Vault::has(&provider)
    }

    #[tauri::command]
    pub fn get_config(state: State<'_, Config>) -> Config {
        state.inner().clone()
    }

    /// Filesystem + PATH completion for the shell input bar.
    /// Returns up to 50 possible completions for the given input line.
    #[tauri::command]
    pub fn shell_complete(input: String, cwd: String) -> Vec<String> {
        use std::path::{Path, PathBuf};

        // Split into the fixed prefix (everything up to and including the last space)
        // and the token being completed.
        let (cmd_prefix, path_token) = match input.rfind(' ') {
            Some(i) => (&input[..=i], &input[i + 1..]),
            None => ("", input.as_str()),
        };

        let cwd_path = PathBuf::from(&cwd);

        // Expand leading ~ to home directory.
        let expanded: String = if path_token.starts_with('~') {
            match dirs_next::home_dir() {
                Some(h) => format!("{}{}", h.to_string_lossy(), &path_token[1..]),
                None => path_token.to_string(),
            }
        } else {
            path_token.to_string()
        };

        // Determine which directory to scan and the filename prefix to match.
        let path = Path::new(&expanded);
        let (scan_dir, file_prefix): (PathBuf, String) =
            if expanded.ends_with('/') || expanded.ends_with('\\') {
                let dir = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    cwd_path.join(path)
                };
                (dir, String::new())
            } else {
                let parent = path.parent().unwrap_or(Path::new(""));
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let dir = if parent.as_os_str().is_empty() {
                    cwd_path.clone()
                } else if parent.is_absolute() {
                    parent.to_path_buf()
                } else {
                    cwd_path.join(parent)
                };
                (dir, name)
            };

        let prefix_lower = file_prefix.to_lowercase();

        // The base part of path_token up to and including the last separator.
        let last_sep = path_token.rfind(|c| c == '/' || c == '\\');
        let token_base: &str = match last_sep {
            Some(i) => &path_token[..=i],
            None => "",
        };
        let sep = if path_token.contains('\\') { "\\" } else { "/" };

        let mut dirs: Vec<String> = Vec::new();
        let mut files: Vec<String> = Vec::new();

        if let Ok(entries) = std::fs::read_dir(&scan_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') && !file_prefix.starts_with('.') {
                    continue;
                }
                if !name.to_lowercase().starts_with(&prefix_lower) {
                    continue;
                }
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                let completed_token = format!(
                    "{}{}{}",
                    token_base,
                    name,
                    if is_dir { sep } else { "" }
                );
                let full = format!("{}{}", cmd_prefix, completed_token);
                if is_dir {
                    dirs.push(full);
                } else {
                    files.push(full);
                }
            }
        }

        dirs.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        files.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        dirs.extend(files);

        // Command-name completion: only when completing the first token
        // (no cmd_prefix) and the token has no path separators.
        let is_plain_token = !path_token.contains('/')
            && !path_token.contains('\\')
            && !path_token.starts_with('~');

        if cmd_prefix.is_empty() && is_plain_token && !path_token.is_empty() {
            let mut seen: std::collections::HashSet<String> =
                dirs.iter().map(|s| s.to_lowercase()).collect();

            if let Ok(path_var) = std::env::var("PATH") {
                let mut cmds: Vec<String> = Vec::new();
                for dir in std::env::split_paths(&path_var) {
                    if let Ok(path_entries) = std::fs::read_dir(&dir) {
                        for entry in path_entries.flatten() {
                            let raw_name =
                                entry.file_name().to_string_lossy().into_owned();
                            let lower = raw_name.to_lowercase();
                            let stem: String = if lower.ends_with(".exe")
                                || lower.ends_with(".cmd")
                                || lower.ends_with(".bat")
                            {
                                Path::new(&raw_name)
                                    .file_stem()
                                    .map(|s| s.to_string_lossy().into_owned())
                                    .unwrap_or(raw_name)
                            } else {
                                raw_name
                            };
                            let key = stem.to_lowercase();
                            if key.starts_with(&prefix_lower) && !seen.contains(&key) {
                                seen.insert(key);
                                cmds.push(stem);
                            }
                        }
                    }
                }
                cmds.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
                dirs.extend(cmds);
            }
        }

        dirs.truncate(50);
        dirs
    }

    /// Read a UTF-8 text file's full contents. `path` may be relative (joined
    /// to `cwd`) or absolute.
    #[tauri::command]
    pub fn fs_read_file(cwd: String, path: String) -> Result<String, String> {
        let p = std::path::Path::new(&path);
        let full = if p.is_absolute() { p.to_path_buf() } else { std::path::Path::new(&cwd).join(p) };
        std::fs::read_to_string(&full).map_err(|e| e.to_string())
    }

    /// Write UTF-8 text contents to a file, overwriting it. `path` may be
    /// relative (joined to `cwd`) or absolute.
    #[tauri::command]
    pub fn fs_write_file(cwd: String, path: String, contents: String) -> Result<(), String> {
        let p = std::path::Path::new(&path);
        let full = if p.is_absolute() { p.to_path_buf() } else { std::path::Path::new(&cwd).join(p) };
        std::fs::write(&full, contents).map_err(|e| e.to_string())
    }

    /// Save raw image bytes (from clipboard) to a temp file and return the absolute path.
    #[tauri::command]
    pub fn save_temp_image(data: Vec<u8>, ext: String) -> Result<String, String> {
        use std::io::Write;
        let dir = std::env::temp_dir().join("braces_images");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let safe_ext = match ext.to_lowercase().as_str() {
            "jpeg" | "jpg" => "jpg",
            "gif" => "gif",
            "webp" => "webp",
            _ => "png",
        };
        let path = dir.join(format!("{}.{}", ts, safe_ext));
        let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        f.write_all(&data).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    }
}
