use std::collections::HashMap;
use super::{
    run_git, parse_porcelain_v2, parse_unified_diff, sum_numstat, xy_to_kind,
    GitBranch, GitBranchInfo, GitCommit, GitCommitFile, GitFileDiff, GitRepoInfo,
    GitStashEntry, GitStatus, GitStatusKind, GitTreeNode,
};

/// Unit separator / record separator — safe field delimiters for parsing
/// git output that may contain spaces, colons, quotes, etc.
const FS: char = '\u{1f}';
const RS: char = '\u{1e}';

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

// ─── remote sync ─────────────────────────────────────────────────────────────

/// Push the current branch. When it has no upstream yet, publish it with
/// `-u origin HEAD` so the first push from a new branch just works.
#[tauri::command]
pub async fn git_push(cwd: String) -> Result<(), String> {
    let has_upstream = run_git(
        &cwd,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .await
    .is_ok();

    let args: &[&str] = if has_upstream {
        &["push"]
    } else {
        &["push", "-u", "origin", "HEAD"]
    };
    run_git(&cwd, args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_pull(cwd: String) -> Result<(), String> {
    run_git(&cwd, &["pull"]).await.map(|_| ())
}

#[tauri::command]
pub async fn git_fetch(cwd: String) -> Result<(), String> {
    run_git(&cwd, &["fetch", "--all", "--prune"]).await.map(|_| ())
}

// ─── history ─────────────────────────────────────────────────────────────────

/// Return `limit` commits starting `skip` entries back from HEAD.
/// An empty repo (no commits yet) returns an empty list, not an error.
#[tauri::command]
pub async fn git_log(cwd: String, limit: u32, skip: u32) -> Result<Vec<GitCommit>, String> {
    let format = format!("--format=%H{FS}%h{FS}%an{FS}%ar{FS}%s{FS}%D{RS}");
    let limit_s = limit.to_string();
    let skip_s = skip.to_string();
    let raw = match run_git(&cwd, &["log", &format, "-n", &limit_s, "--skip", &skip_s]).await {
        Ok(raw) => raw,
        Err(e) if e.to_lowercase().contains("does not have any commits") => return Ok(vec![]),
        Err(e) => return Err(e),
    };

    let commits = raw
        .split(RS)
        .filter_map(|rec| {
            let rec = rec.trim_matches(['\n', '\r']);
            let parts: Vec<&str> = rec.split(FS).collect();
            if parts.len() != 6 || parts[0].is_empty() { return None; }
            let refs = parts[5]
                .split(", ")
                .map(|r| r.trim().trim_start_matches("HEAD -> ").to_string())
                .filter(|r| !r.is_empty() && r != "HEAD")
                .collect();
            Some(GitCommit {
                hash: parts[0].to_string(),
                short_hash: parts[1].to_string(),
                author: parts[2].to_string(),
                date: parts[3].to_string(),
                subject: parts[4].to_string(),
                refs,
            })
        })
        .collect();
    Ok(commits)
}

/// List the files touched by a single commit.
#[tauri::command]
pub async fn git_commit_files(cwd: String, hash: String) -> Result<Vec<GitCommitFile>, String> {
    let raw = run_git(&cwd, &["show", "--name-status", "--format=", &hash]).await?;
    let files = raw
        .lines()
        .filter_map(|line| {
            let mut cols = line.split('\t');
            let status = cols.next()?.chars().next()?;
            // Renames/copies list "old\tnew" — show the new path
            let path = cols.next_back()?.trim();
            if path.is_empty() { return None; }
            Some(GitCommitFile {
                path: path.to_string(),
                status: xy_to_kind(status),
            })
        })
        .collect();
    Ok(files)
}

/// Return the parsed diff for one file within one commit.
/// `git show` (unlike `<hash>^..<hash>`) also works for the root commit.
#[tauri::command]
pub async fn git_show_file(cwd: String, hash: String, path: String) -> Result<GitFileDiff, String> {
    let raw = run_git(&cwd, &["show", "--no-color", "--format=", &hash, "--", &path])
        .await
        .unwrap_or_default();
    Ok(parse_unified_diff(&path, &raw))
}

// ─── branches ────────────────────────────────────────────────────────────────

/// List local and remote branches sorted by most recent commit.
#[tauri::command]
pub async fn git_branches(cwd: String) -> Result<Vec<GitBranch>, String> {
    let current = run_git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());

    // NB: for-each-ref hex escapes are "%1f", not the "%x1f" that log formats use
    let format =
        "--format=%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(committerdate:relative)%1f%(subject)";
    let raw = run_git(
        &cwd,
        &["for-each-ref", "--sort=-committerdate", format, "refs/heads", "refs/remotes"],
    )
    .await?;

    let branches = raw
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split(FS).collect();
            if parts.len() != 5 { return None; }
            let full = parts[0];
            let name = parts[1].to_string();
            let is_remote = full.starts_with("refs/remotes/");
            // Skip symbolic remote HEAD pointers (refs/remotes/origin/HEAD)
            if is_remote && full.ends_with("/HEAD") { return None; }
            Some(GitBranch {
                is_current: !is_remote && name == current,
                is_remote,
                upstream: if parts[2].is_empty() { None } else { Some(parts[2].to_string()) },
                last_date: parts[3].to_string(),
                last_subject: parts[4].to_string(),
                name,
            })
        })
        .collect();
    Ok(branches)
}

/// Create a new branch at HEAD and switch to it.
#[tauri::command]
pub async fn git_branch_create(cwd: String, name: String) -> Result<(), String> {
    run_git(&cwd, &["checkout", "-b", name.as_str()]).await.map(|_| ())
}

/// Delete a local branch (`-d`, or `-D` when `force`).
#[tauri::command]
pub async fn git_branch_delete(cwd: String, name: String, force: bool) -> Result<(), String> {
    let flag = if force { "-D" } else { "-d" };
    run_git(&cwd, &["branch", flag, name.as_str()]).await.map(|_| ())
}

// ─── stash ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_stash_list(cwd: String) -> Result<Vec<GitStashEntry>, String> {
    let format = format!("--format=%gd{FS}%gs");
    let raw = run_git(&cwd, &["stash", "list", &format]).await.unwrap_or_default();
    let stashes = raw
        .lines()
        .filter_map(|line| {
            let (gd, msg) = line.split_once(FS)?;
            // "stash@{N}" → N
            let index = gd
                .trim_start_matches("stash@{")
                .trim_end_matches('}')
                .parse()
                .ok()?;
            Some(GitStashEntry { index, message: msg.trim().to_string() })
        })
        .collect();
    Ok(stashes)
}

#[tauri::command]
pub async fn git_stash_push(
    cwd: String,
    message: Option<String>,
    include_untracked: bool,
) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["stash", "push"];
    if include_untracked { args.push("--include-untracked"); }
    let msg = message.unwrap_or_default();
    if !msg.trim().is_empty() {
        args.push("-m");
        args.push(msg.trim());
    }
    run_git(&cwd, &args).await.map(|_| ())
}

/// Apply a stash entry; `pop` also drops it on success.
#[tauri::command]
pub async fn git_stash_apply(cwd: String, index: u32, pop: bool) -> Result<(), String> {
    let stash_ref = format!("stash@{{{index}}}");
    let sub = if pop { "pop" } else { "apply" };
    run_git(&cwd, &["stash", sub, &stash_ref]).await.map(|_| ())
}

#[tauri::command]
pub async fn git_stash_drop(cwd: String, index: u32) -> Result<(), String> {
    let stash_ref = format!("stash@{{{index}}}");
    run_git(&cwd, &["stash", "drop", &stash_ref]).await.map(|_| ())
}
