---
"deepagents": patch
---

fix(sandbox): return raw file content from BaseSandbox.read()

The sandbox awk command was numbering lines, then read_file numbered them again, so the model saw a doubled gutter. Other backends already return raw content and leave formatting to the middleware — same as Python.
