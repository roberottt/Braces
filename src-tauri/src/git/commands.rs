use std::collections::HashMap;
use super::{
    run_git, parse_porcelain_v2, parse_unified_diff, sum_numstat,
    GitBranchInfo, GitFileDiff, GitRepoInfo, GitStatus, GitStatusKind, GitTreeNode,
};

// ─── file-tree constants ──────────────────────────────────────────────────────

const IGNORE_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", ".cache",
    "__pycache__", ".next", "build", "out", "coverage",
];

const MAX_NODES: usize = 5_000;

/// List a single directory level (no recursion), annotating files with git
/// status. Subdirectories are *not* expanded — the frontend fetches their
/// children lazily on demand. This keeps one huge subtree (e.g. a `.cargo`
/// registry with tens of thousands of entries) from starving its siblings
/// out of a shared node budget, which is what an eager recursive walk did.
fn list_dir_level(
    root:       &std::path::Path,
    dir:        &std::path::Path,
    status_map: &HashMap<String, GitStatusKind>,
) -> Vec<GitTreeNode> {
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
        if nodes.len() >= MAX_NODES { break; }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let rel  = path.strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());

        if path.is_dir() {
            if IGNORE_DIRS.contains(&name.as_str()) { continue; }
            nodes.push(GitTreeNode { name, rel_path: rel, is_dir: true, status: None, children: vec![] });
        } else {
            let status = status_map.get(&rel).cloned();
            nodes.push(GitTreeNode { name, rel_path: rel, is_dir: false, status, children: vec![] });
        }
    }
    nodes
}

fn build_status_map(porcelain: &str) -> HashMap<String, GitStatusKind> {
    let mut status_map: HashMap<String, GitStatusKind> = HashMap::new();

    for line in porcelain.lines() {
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

    status_map
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
    // `--untracked-files=all` lists every new file individually. Without it git
    // collapses an untracked directory into a single entry, so a freshly-added
    // folder of N files showed up as "1" change. .gitignore is still respected,
    // so ignored trees (node_modules, target, …) are not counted.
    match run_git(&cwd, &["status", "--porcelain=v2", "--branch", "--untracked-files=all"]).await {
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
                    insertions: 0,
                    deletions: 0,
                    files: vec![],
                })
            } else {
                Err(e)
            }
        }
        Ok(raw) => {
            let mut status = parse_porcelain_v2(&raw);
            // Line-level diff stat = unstaged + staged tracked changes. Two calls so
            // it also works in a repo with no commits yet (where `git diff HEAD` fails).
            let unstaged = run_git(&cwd, &["diff", "--numstat"]).await.unwrap_or_default();
            let staged   = run_git(&cwd, &["diff", "--cached", "--numstat"]).await.unwrap_or_default();
            let (a1, d1) = sum_numstat(&unstaged);
            let (a2, d2) = sum_numstat(&staged);
            status.insertions = a1 + a2;
            status.deletions  = d1 + d2;
            Ok(status)
        }
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

/// List the children of `rel_path` (relative to `cwd`; empty string = `cwd`
/// itself) one level deep, with per-file git status badges. Called both for
/// the initial root listing and, lazily, whenever the frontend expands a
/// directory node — so no subtree is ever walked before the user asks for it.
#[tauri::command]
pub async fn git_dir_children(cwd: String, rel_path: String) -> Result<Vec<GitTreeNode>, String> {
    // Build a path→status map from `git status --porcelain`. `-uall` so files
    // inside a new untracked directory each get a status badge (git otherwise
    // collapses them into a single directory entry).
    let raw = run_git(&cwd, &["status", "--porcelain", "--untracked-files=all"]).await.unwrap_or_default();
    let status_map = build_status_map(&raw);

    let cwd2 = cwd.clone();
    let rel2 = rel_path.clone();
    let children = tokio::task::spawn_blocking(move || {
        let root = std::path::Path::new(&cwd2);
        let dir  = if rel2.is_empty() { root.to_path_buf() } else { root.join(&rel2) };
        list_dir_level(root, &dir, &status_map)
    }).await.map_err(|e| e.to_string())?;

    Ok(children)
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
