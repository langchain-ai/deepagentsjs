---
"deepagents": patch
---

fix(deepagents): stop `FilesystemBackend.downloadFiles` hanging on a FIFO

`downloadFiles` opens files without blocking and reports `file_not_found` for anything that is not a regular file or directory, so a FIFO no longer hangs the call and a device such as `/dev/zero` is no longer read without limit.
