---
"deepagents": patch
---

Check filesystem permissions against the path an operation actually touches: rule matching drops `.` segments, and with `FilesystemBackend` (directly or behind a `CompositeBackend` route) rules are also checked on the symlink-resolved target. A deny on either path blocks the call, so allow rules must cover a symlink's target (including OS-level links like macOS `/tmp` → `/private/tmp` in non-virtual mode).
