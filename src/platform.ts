// Shared platform detection for keyboard shortcuts and UI hints.
export const isMac = navigator.userAgent.includes("Mac");
export const isLinux =
  navigator.userAgent.includes("Linux") && !navigator.userAgent.includes("Android");
export const isWindows = navigator.userAgent.includes("Windows");
