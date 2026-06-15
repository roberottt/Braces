use std::collections::HashMap;
use super::{
    run_git, parse_porcelain_v2, parse_unified_diff,
    GitBranchInfo, GitFileDiff, GitRepoInfo, GitStatus, GitStatusKind, GitTreeNode,
};

// ─── file-tree constants ──────────────────────────────────────────────────────

const IGNORE_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", ".cache",
    "__pycache__", ".next", "build", "out", "coverage",
];

const MAX_NODES: usize = 2_000;

/// Recursively build a `GitTreeNode` tree, annotating files with git status.
fn build_tree(
    root:       &std::path::Path,
    dir:        &std::path::Path,
    status_map: &HashMap<String, GitStatusKind>,
    depth:      u32,
    count:      &mut usize,
) -> Vec<GitTreeNode> {
    if depth > 6 || *count >= MAX_NODES { return vec![]; }

    let Ok(entries) = std::fs::read_dir(dir) else { return vec![]; };
    let mut list: Vec<_> = entries.flatten().collect();

    // dirs first, then files — each group alphabetical (case-insensitive)
    list.sort_by(|a, b| {
        let ad = a.path().is_dir();
        let bd = b.path().is_dir();
        match (ad, bd) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => {
                let an = a.file_name().to_string_lossy().to_lowercase();
                let bn = b.file_name().to_string_lossy().to_lowercase();
                an.cmp(&bn)
            }
        }
    });

    let mut nodes = Vec::new();
    for entry in list {
        if *count >= MAX_NODES { break; }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let rel  = path.strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());

        if path.is_dir() {
            if IGNORE_DIRS.contains(&name.as_str()) { continue; }
            let children = build_tree(root, &path, status_map, depth + 1, count);
            nodes.push(GitTreeNode { name, rel_path: rel, is_dir: true, status: None, children });
        } else {
            let status = status_map.get(&rel).cloned();
            nodes.push(GitTreeNode { name, rel_path: rel, is_dir: false, status, children: vec![] });
            *count += 1;
        }
    }
    nodes
}

/// Check whether `cwd` is inside a git repository.
/// Always returns Ok — callers should check the `isRepo` field.
#[tauri::command]
pub async fn git_is_repo(cwd: String) -> Result<GitRepoInfo, String> {
    match run_git(&cwd, &["rev-parse", "--show-toplevel"]).await {
        Ok(root) => Ok(GitRepoInfo {
            is_repo: true,
            root: root.trim().to_string(),
        }),
        Err(_) => Ok(GitRepoInfo {
            is_repo: false,
            root: String::new(),
        }),
    }
}

/// Return the full status of the repo rooted at (or containing) `cwd`.
/// If `cwd` is not inside a repo, returns a `GitStatus` with `isRepo: false`.
#[tauri::command]
pub async fn git_status(cwd: String) -> Result<GitStatus, String> {
    match run_git(&cwd, &["status", "--porcelain=v2", "--branch"]).await {
        Err(e) => {
            // git writes "not a git repository" to stderr when outside a repo
            if e.to_lowercase().contains("not a git repo")
                || e.to_lowercase().contains("not a git repository")
            {
                Ok(GitStatus {
                    is_repo: false,
                    branch: String::new(),
                    upstream: None,
                    ahead: 0,
                    behind: 0,
                    detached: false,
                    files: vec![],
                })
            } else {
                Err(e)
            }
        }
        Ok(raw) => Ok(parse_porcelain_v2(&raw)),
    }
}

/// Return the parsed diff for a single file (staged or worktree).
#[tauri::command]
pub async fn git_diff_file(cwd: String, path: String, staged: bool) -> Result<GitFileDiff, String> {
    let mut args: Vec<&str> = vec!["diff", "--no-color"];
    if staged { args.push("--cached"); }
    args.extend_from_slice(&["--", path.as_str()]);
    // Empty output = no diff (clean file); never an error for the caller
    let raw = run_git(&cwd, &args).await.unwrap_or_default();
    Ok(parse_unified_diff(&path, &raw))
}

/// Stage the given paths.
#[tauri::command]
pub async fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() { return Ok(()); }
    let mut args: Vec<&str> = vec!["add", "--"];
    let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    args.extend_from_slice(&refs);
    run_git(&cwd, &args).await.map(|_| ())
}

/// Unstage (restore --staged) the given paths.
#[tauri::command]
pub async fn git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() { return Ok(()); }
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    args.extend_from_slice(&refs);
    run_git(&cwd, &args).await.map(|_| ())
}

/// Discard worktree changes (tracked) and/or delete untracked files.
/// `paths`     → `git restore -- <paths>` (tracked modified/deleted)
/// `untracked` → `git clean -f -- <paths>` (new untracked files)
#[tauri::command]
pub async fn git_discard(
    cwd: String,
    paths: Vec<String>,
    untracked: Vec<String>,
) -> Result<(), String> {
    if !paths.is_empty() {
        let mut args: Vec<&str> = vec!["restore", "--"];
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        args.extend_from_slice(&refs);
        run_git(&cwd, &args).await?;
    }
    if !untracked.is_empty() {
        let mut args: Vec<&str> = vec!["clean", "-f", "--"];
        let refs: Vec<&str> = untracked.iter().map(String::as_str).collect();
        args.extend_from_slice(&refs);
        run_git(&cwd, &args).await?;
    }
    Ok(())
}

/// Stage all changes (`git add -A`).
#[tauri::command]
pub async fn git_stage_all(cwd: String) -> Result<(), String> {
    run_git(&cwd, &["add", "-A"]).await.map(|_| ())
}

/// Create a commit.
#[tauri::command]
pub async fn git_commit(cwd: String, message: String, amend: bool) -> Result<(), String> {
    let mut args = vec!["commit", "-m", message.as_str()];
    if amend { args.push("--amend"); }
    run_git(&cwd, &args).await.map(|_| ())
}

/// Return the current branch name plus the list of all local + remote branches.
#[tauri::command]
pub async fn git_branch_info(cwd: String) -> Result<GitBranchInfo, String> {
    let current = run_git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());

    let all = run_git(&cwd, &["branch", "-a"])
        .await
        .map(|s| {
            s.lines()
                .map(|l| l.trim_start_matches(['*', ' ']).trim().to_string())
                .filter(|s| !s.is_empty() && !s.contains(" -> "))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(GitBranchInfo { current, all })
}

/// Return the full project file tree with per-file git status badges.
#[tauri::command]
pub async fn git_file_tree(cwd: String) -> Result<GitTreeNode, String> {
    // Build a path→status map from `git status --porcelain`
    let raw = run_git(&cwd, &["status", "--porcelain"]).await.unwrap_or_default();
    let mut status_map: HashMap<String, GitStatusKind> = HashMap::new();

    for line in raw.lines() {
        if line.len() < 4 { continue; }
        let xy   = &line[..2];
        let rest = line[3..].trim();
        // Renames: "old -> new" — take new path
        let path = if let Some(arrow) = rest.find(" -> ") {
            rest[arrow + 4..].replace('\\', "/")
        } else {
            rest.replace('\\', "/")
        };
        // Paths with spaces come back quoted: "a b.txt"
        let path = path.trim_matches('"').to_string();

        let kind = if xy.contains('?') {
            GitStatusKind::Untracked
        } else if xy.contains('U') || xy == "AA" || xy == "DD" {
            GitStatusKind::Conflicted
        } else if xy.contains('R') {
            GitStatusKind::Renamed
        } else if xy.contains('A') {
            GitStatusKind::Added
        } else if xy.contains('D') {
            GitStatusKind::Deleted
        } else {
            GitStatusKind::Modified
        };

        status_map.insert(path, kind);
    }

    let cwd2 = cwd.clone();
    let (root_name, children) = tokio::task::spawn_blocking(move || {
        let root = std::path::Path::new(&cwd2);
        let root_name = root.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&cwd2)
            .to_string();
        let mut count = 0usize;
        let children = build_tree(root, root, &status_map, 0, &mut count);
        (root_name, children)
    }).await.map_err(|e| e.to_string())?;

    Ok(GitTreeNode { name: root_name, rel_path: String::new(), is_dir: true, status: None, children })
}

/// Switch to an existing branch.
#[tauri::command]
pub async fn git_checkout(cwd: String, branch: String) -> Result<(), String> {
    run_git(&cwd, &["checkout", branch.as_str()])
        .await
        .map(|_| ())
}

/// Return the full unified diff for all modified files (staged or worktree).
/// Used by the code review panel.
#[tauri::command]
pub async fn git_diff_all(cwd: String, staged: bool) -> Result<String, String> {
    let mut args = vec!["diff", "--no-color"];
    if staged { args.push("--cached"); }
    run_git(&cwd, &args).await
}
