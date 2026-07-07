use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

pub struct OutputBuffer {
    lines: Mutex<VecDeque<String>>,
    /// Text received after the last '\n' — the line still being drawn (shell
    /// prompt, line-editor echo, a progress bar). Kept out of `lines` so a
    /// PTY chunk boundary mid-line never fabricates a bogus "line".
    pending: Mutex<String>,
    /// Total raw bytes ever received. Monotonic even while `lines` is static
    /// (e.g. a prompt being typed on), so it's the right quiescence signal.
    bytes: AtomicUsize,
    cap: usize,
}

impl OutputBuffer {
    pub fn new(cap: usize) -> Self {
        Self {
            lines: Mutex::new(VecDeque::new()),
            pending: Mutex::new(String::new()),
            bytes: AtomicUsize::new(0),
            cap,
        }
    }

    /// Push raw PTY bytes, strip ANSI, split into lines. Only text terminated
    /// by '\n' becomes a line; the rest accumulates in `pending` until its
    /// newline arrives.
    pub fn push_raw(&self, bytes: &[u8]) {
        self.bytes.fetch_add(bytes.len(), Ordering::Relaxed);
        let text = strip_ansi(bytes);
        let mut pending = self.pending.lock().unwrap();
        pending.push_str(&text);
        if !pending.contains('\n') {
            return;
        }
        let mut rest = std::mem::take(&mut *pending);
        let mut lines = self.lines.lock().unwrap();
        while let Some(idx) = rest.find('\n') {
            let line: String = rest.drain(..=idx).collect();
            let resolved = resolve_cr(&line);
            if !resolved.is_empty() {
                if lines.len() >= self.cap {
                    lines.pop_front();
                }
                lines.push_back(resolved);
            }
        }
        *pending = rest;
    }

    /// Most recent `n` lines (oldest → newest).
    pub fn recent(&self, n: usize) -> Vec<String> {
        let lines = self.lines.lock().unwrap();
        let skip = lines.len().saturating_sub(n);
        lines.iter().skip(skip).cloned().collect()
    }

    /// Total lines currently in the buffer.
    pub fn len(&self) -> usize {
        self.lines.lock().unwrap().len()
    }

    /// Total raw bytes received over the session's lifetime.
    pub fn bytes_seen(&self) -> usize {
        self.bytes.load(Ordering::Relaxed)
    }

    /// Lines added after position `from` (best-effort; may be empty if buffer wrapped).
    pub fn after(&self, from: usize) -> Vec<String> {
        self.lines.lock().unwrap().iter().skip(from).cloned().collect()
    }
}

/// Collapse in-place redraws: '\r' returns the cursor to column 0, so only the
/// text after the last '\r' is what the line ended up showing (progress bars,
/// zsh line-editor repaints).
fn resolve_cr(line: &str) -> String {
    line.trim_end_matches(['\n', '\r'])
        .rsplit('\r')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_string()
}

fn strip_ansi(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.next() {
                Some('[') => {
                    for c2 in chars.by_ref() {
                        if c2.is_ascii_alphabetic() { break; }
                    }
                }
                Some(']') => {
                    let mut prev = '\0';
                    for c2 in chars.by_ref() {
                        if c2 == '\x07' { break; }
                        if prev == '\x1b' && c2 == '\\' { break; }
                        prev = c2;
                    }
                }
                _ => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_boundaries_do_not_fabricate_lines() {
        // zsh's line editor echoes the injected command in several chunks with
        // no newline — none of them may surface as lines.
        let buf = OutputBuffer::new(100);
        for chunk in [b"g".as_ref(), b"it", b" s", b"tatus"] {
            buf.push_raw(chunk);
        }
        assert_eq!(buf.len(), 0);
        buf.push_raw(b"\r\nOn branch main\n");
        assert_eq!(buf.after(0), vec!["git status", "On branch main"]);
    }

    #[test]
    fn carriage_return_keeps_final_repaint() {
        let buf = OutputBuffer::new(100);
        buf.push_raw(b"progress 10%\rprogress 50%\rprogress 100%\n");
        assert_eq!(buf.after(0), vec!["progress 100%"]);
    }

    #[test]
    fn prompt_stays_pending_until_newline() {
        let buf = OutputBuffer::new(100);
        buf.push_raw(b"user@host dir % ");
        assert_eq!(buf.len(), 0);
        assert!(buf.bytes_seen() > 0);
    }
}
