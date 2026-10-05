---
"deepagents": patch
---

fix(deepagents): replace `micromatch` and `fast-glob` with `picomatch` and `fdir` to drop the unmaintained `braces` dependency (GHSA-vfj7-8cjw-p6xm). Filesystem globbing still never follows symlinks, and now also does not traverse a symlink named as a literal segment of a glob pattern (e.g. `link/*`), which previously could list files outside the backend root.
