---
"deepagents": patch
---

Widen the `langsmith` peer range to `>=0.11.0 <1.0.0`, the range `langchain` 1.6 requires. The old range, `>=0.7.1 <0.10.0`, failed strict peer installs next to `langchain` 1.6 and let an install hold two `langsmith` copies.
