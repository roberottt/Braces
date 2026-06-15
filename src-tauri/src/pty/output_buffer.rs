use std::collections::VecDeque;
use std::sync::Mutex;

pub struct OutputBuffer {
    lines: Mutex<VecDeque<String>>,
    cap: usize,
}

impl OutputBuffer {
    pub fn new(cap: usize) -> Self {
        Self { lines: Mutex::new(VecDeque::new()), cap }
    }

    /// Push raw PTY bytes, strip ANSI, split into lines.
    pub fn push_raw(&self, bytes: &[u8]) {
        let text = strip_ansi(bytes);
        let mut lines = self.lines.lock().unwrap();
        for line in text.split('\n') {
            let l = line.trim_end_matches('\r').to_string();
            if !l.is_empty() {
                if lines.len() >= self.cap {
                    lines.pop_front();
                }
                lines.push_back(l);
            }
        }
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

    /// Lines added after position `from` (best-effort; may be empty if buffer wrapped).
    pub fn after(&self, from: usize) -> Vec<String> {
        self.lines.lock().unwrap().iter().skip(from).cloned().collect()
    }
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
