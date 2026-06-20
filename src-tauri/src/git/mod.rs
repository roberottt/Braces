pub mod commands;

use serde::{Deserialize, Serialize};

// ─── shared data types ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum GitStatusKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    /// Original path before rename (type-2 entries only)
    pub orig_path: Option<String>,
    /// Index (staged) status; None = unmodified
    pub index_status: Option<GitStatusKind>,
    /// Worktree (unstaged) status; None = unmodified or untracked-not-applicable
    pub worktree_status: Option<GitStatusKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub detached: bool,
    /// Total lines added across staged + unstaged tracked changes (diff numstat).
    pub insertions: u32,
    /// Total lines removed across staged + unstaged tracked changes.
    pub deletions: u32,
    pub files: Vec<GitFileStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub current: String,
    pub all: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub is_repo: bool,
    pub root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTreeNode {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub status: Option<GitStatusKind>,
    pub children: Vec<GitTreeNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffLine {
    pub origin: char,        // ' ', '+', '-'
    pub content: String,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffHunk {
    pub header: String,
    pub lines: Vec<GitDiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub path: String,
    pub hunks: Vec<GitDiffHunk>,
    pub is_binary: bool,
    pub raw_unified: String,
}

// ─── git runner ──────────────────────────────────────────────────────────────

/// Run a git sub-command in `cwd`, returning trimmed stdout.
/// Non-zero exit → `Err(stderr trimmed)`.
pub async fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.current_dir(cwd).args(args);

    // Suppress console flash on Windows
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.as_std_mut().creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("failed to spawn git: {e}"))?;

    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git exited with code {}", out.status)
        } else {
            stderr
        })
    }
}

// ─── porcelain-v2 parser ─────────────────────────────────────────────────────

fn xy_to_kind(c: char) -> Option<GitStatusKind> {
    match c {
        'M' => Some(GitStatusKind::Modified),
        'A' => Some(GitStatusKind::Added),
        'D' => Some(GitStatusKind::Deleted),
        'R' => Some(GitStatusKind::Renamed),
        'C' => Some(GitStatusKind::Copied),
        'U' => Some(GitStatusKind::Conflicted),
        _ => None,
    }
}

/// Parse `git status --porcelain=v2 --branch` output into a `GitStatus`.
pub fn parse_porcelain_v2(raw: &str) -> GitStatus {
    let mut branch = "HEAD".to_string();
    let mut upstream: Option<String> = None;
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;
    let mut detached = false;
    let mut files: Vec<GitFileStatus> = Vec::new();

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.trim().to_string();
            detached = rest.trim() == "(detached)";

        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            upstream = Some(rest.trim().to_string());

        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // "+N -N"
            let mut parts = rest.split_whitespace();
            ahead  = parts.next().and_then(|s| s.trim_start_matches('+').parse().ok()).unwrap_or(0);
            behind = parts.next().and_then(|s| s.trim_start_matches('-').parse().ok()).unwrap_or(0);

        } else if let Some(rest) = line.strip_prefix("1 ") {
            // Ordinary changed entry:
            // XY sub mH mI mW hH hI path   (8 fields; path may contain spaces → splitn(8))
            let parts: Vec<&str> = rest.splitn(8, ' ').collect();
            if parts.len() == 8 {
                let xy   = parts[0];
                let path = parts[7].trim().to_string();
                let x    = xy.chars().next().unwrap_or('.');
                let y    = xy.chars().nth(1).unwrap_or('.');
                files.push(GitFileStatus {
                    path,
                    orig_path: None,
                    index_status: xy_to_kind(x),
                    worktree_status: xy_to_kind(y),
                });
            }

        } else if let Some(rest) = line.strip_prefix("2 ") {
            // Renamed / copied:
            // XY sub mH mI mW hH hI Xscore new_path\torig_path   (9 fields)
            let parts: Vec<&str> = rest.splitn(9, ' ').collect();
            if parts.len() == 9 {
                let xy    = parts[0];
                let paths = parts[8];
                let (new_path, orig_path) = if let Some(tab) = paths.find('\t') {
                    (paths[..tab].trim().to_string(), Some(paths[tab + 1..].trim().to_string()))
                } else {
                    (paths.trim().to_string(), None)
                };
                let x = xy.chars().next().unwrap_or('.');
                let y = xy.chars().nth(1).unwrap_or('.');
                files.push(GitFileStatus {
                    path: new_path,
                    orig_path,
                    index_status: xy_to_kind(x),
                    worktree_status: xy_to_kind(y),
                });
            }

        } else if let Some(rest) = line.strip_prefix("? ") {
            files.push(GitFileStatus {
                path: rest.trim().to_string(),
                orig_path: None,
                index_status: None,
                worktree_status: Some(GitStatusKind::Untracked),
            });
        }
    }

    GitStatus { is_repo: true, branch, upstream, ahead, behind, detached, insertions: 0, deletions: 0, files }
}

/// Sum added/removed line counts from `git diff --numstat` output.
/// Binary files report "-\t-" and are skipped.
pub fn sum_numstat(raw: &str) -> (u32, u32) {
    let mut added = 0u32;
    let mut removed = 0u32;
    for line in raw.lines() {
        let mut cols = line.split('\t');
        let a = cols.next().unwrap_or("");
        let d = cols.next().unwrap_or("");
        added   += a.parse::<u32>().unwrap_or(0);
        removed += d.parse::<u32>().unwrap_or(0);
    }
    (added, removed)
}

// ─── unified diff parser ─────────────────────────────────────────────────────

/// Parse the output of `git diff [--cached] --no-color -- <path>` into `GitFileDiff`.
pub fn parse_unified_diff(path: &str, raw: &str) -> GitFileDiff {
    if raw.lines().any(|l| l.starts_with("Binary files")) {
        return GitFileDiff {
            path: path.to_string(),
            hunks: vec![],
            is_binary: true,
            raw_unified: raw.to_string(),
        };
    }

    let mut hunks: Vec<GitDiffHunk> = Vec::new();
    let mut current: Option<GitDiffHunk> = None;
    let mut old_line: u32 = 1;
    let mut new_line: u32 = 1;

    for line in raw.lines() {
        if line.starts_with("@@") {
            if let Some(h) = current.take() { hunks.push(h); }

            // @@ -old_start[,count] +new_start[,count] @@ ...
            let mut parts = line.splitn(4, ' ');
            let _at       = parts.next();
            let old_part  = parts.next().unwrap_or("-1");
            let new_part  = parts.next().unwrap_or("+1");

            old_line = old_part.trim_start_matches('-').split(',').next()
                .and_then(|s| s.parse().ok()).unwrap_or(1);
            new_line = new_part.trim_start_matches('+').split(',').next()
                .and_then(|s| s.parse().ok()).unwrap_or(1);

            current = Some(GitDiffHunk { header: line.to_string(), lines: Vec::new() });

        } else if let Some(hunk) = current.as_mut() {
            match line.chars().next() {
                Some('+') if !line.starts_with("+++") => {
                    hunk.lines.push(GitDiffLine {
                        origin: '+', content: line[1..].to_string(),
                        old_no: None, new_no: Some(new_line),
                    });
                    new_line += 1;
                }
                Some('-') if !line.starts_with("---") => {
                    hunk.lines.push(GitDiffLine {
                        origin: '-', content: line[1..].to_string(),
                        old_no: Some(old_line), new_no: None,
                    });
                    old_line += 1;
                }
                Some(' ') => {
                    hunk.lines.push(GitDiffLine {
                        origin: ' ', content: line[1..].to_string(),
                        old_no: Some(old_line), new_no: Some(new_line),
                    });
                    old_line += 1;
                    new_line += 1;
                }
                Some('\\') => { /* "\ No newline at end of file" — skip */ }
                _ => { /* diff header lines inside the hunk block — skip */ }
            }
        }
    }

    if let Some(h) = current.take() { hunks.push(h); }

    GitFileDiff { path: path.to_string(), hunks, is_binary: false, raw_unified: raw.to_string() }
}
