---
"deepagents-acp": patch
"deepagents": patch
---

fix(acp): run the filesystem backend in virtual mode so tool searches stay within the workspace instead of scanning (and crashing on) the host filesystem
