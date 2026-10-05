---
"deepagents": patch
---

fix(deepagents): replace `micromatch` and `fast-glob` with `picomatch` and `fdir` to drop the unmaintained `braces` dependency (GHSA-vfj7-8cjw-p6xm), and cap glob patterns at 1,024 characters and 32 levels of `{}`/`()` nesting. Deeply nested patterns otherwise abort the process with an uncatchable V8 out-of-memory error inside picomatch; the `glob` and `grep` tools now return an error instead, and permission rules exceeding the limits throw at setup. Filesystem globbing still never follows symlinks, and now also does not traverse a symlink named as a literal segment of a glob pattern (e.g. `link/*`), which previously could list files outside the backend root.
