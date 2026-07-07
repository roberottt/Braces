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

// sysinfo's used_memory() on macOS counts active + wired + compressed + speculative
// pages, which includes file cache and reads way higher than Activity Monitor.
// Activity Monitor's "Memory Used" is App Memory (internal - purgeable) + Wired +
// Compressed, so we query host_statistics64 ourselves to match it.
#[cfg(target_os = "macos")]
#[allow(deprecated)] // libc::mach_host_self is deprecated in favor of the mach2 crate
fn macos_used_memory_bytes() -> Option<u64> {
    use std::mem::MaybeUninit;

    unsafe {
        let mut stat = MaybeUninit::<libc::vm_statistics64>::uninit();
        let mut count = (std::mem::size_of::<libc::vm_statistics64>()
            / std::mem::size_of::<libc::integer_t>()) as libc::mach_msg_type_number_t;
        let ret = libc::host_statistics64(
            libc::mach_host_self(),
            libc::HOST_VM_INFO64,
            stat.as_mut_ptr() as *mut libc::integer_t,
            &mut count,
        );
        if ret != libc::KERN_SUCCESS {
            return None;
        }
        let stat = stat.assume_init();
        let page_size = libc::sysconf(libc::_SC_PAGESIZE);
        if page_size <= 0 {
            return None;
        }
        let used_pages = (stat.internal_page_count as u64)
            .saturating_sub(stat.purgeable_count as u64)
            .saturating_add(stat.wire_count as u64)
            .saturating_add(stat.compressor_page_count as u64);
        Some(used_pages.saturating_mul(page_size as u64))
    }
}

pub fn collect() -> SystemMetrics {
    let mut sys = system().lock().unwrap();
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    #[cfg(target_os = "macos")]
    let used = macos_used_memory_bytes().unwrap_or_else(|| sys.used_memory());
    #[cfg(not(target_os = "macos"))]
    let used = sys.used_memory();

    SystemMetrics {
        cpu_percent: sys.global_cpu_usage(),
        ram_used_mb: used / 1024 / 1024,
        ram_total_mb: sys.total_memory() / 1024 / 1024,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(target_os = "macos")]
    fn print_used_memory() {
        let used = super::macos_used_memory_bytes().unwrap();
        println!("macos_used_memory: {} MB", used / 1024 / 1024);
        let m = super::collect();
        println!("collect(): {:?}", m);
    }
}
