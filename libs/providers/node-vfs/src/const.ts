// Host filesystem roots that should stay absolute unless shadowed by a VFS root.
export const HOST_ABSOLUTE_ROOT_ALLOWLIST = new Set([
  "bin",
  "dev",
  "lib",
  "lib64",
  "private",
  "proc",
  "sbin",
  "sys",
  "usr",
]);
