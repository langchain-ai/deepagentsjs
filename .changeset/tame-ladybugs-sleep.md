---
"deepagents": patch
---

fix(deepagents): align prompt templates with runtime behavior

- Align `read_file` long-line guidance with runtime behavior by rendering `MAX_LINE_LENGTH` in the prompt.
- Normalize middleware prompt/template text for filesystem, memory, subagents, and summarization to match current behavior and improve consistency.
- Remove Python-specific phrasing from skills guidance to keep descriptions language-agnostic.
