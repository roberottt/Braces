// Phase 4: OS Intelligence Panel
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use sysinfo::System;

#[derive(Debug, Serialize)]
pub struct SystemMetrics {
    pub cpu_percent: f32,
    pub ram_used_mb: u64,
    pub ram_total_mb: u64,
}

// sysinfo computes CPU% as a delta between two refreshes of the SAME System.
// A freshly-created System always reports 0.0%, so we keep one alive between calls.
fn system() -> &'static Mutex<System> {
    static SYS: OnceLock<Mutex<System>> = OnceLock::new();
    SYS.get_or_init(|| Mutex::new(System::new_all()))
}

pub fn collect() -> SystemMetrics {
    let mut sys = system().lock().unwrap();
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    SystemMetrics {
        cpu_percent: sys.global_cpu_usage(),
        ram_used_mb: sys.used_memory() / 1024 / 1024,
        ram_total_mb: sys.total_memory() / 1024 / 1024,
    }
}
