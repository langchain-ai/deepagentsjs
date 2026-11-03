---
"deepagents": patch
---

fix(deepagents): clip long `grep` lines to a window around the match

`grep` shows at most 500 characters of each matching line, centered on the match, so a hit on a huge single line (such as an offloaded minified JSON tool result) no longer returns the whole line.
