---
"deepagents": minor
---

feat(deepagents): adopt more minimal prompting

We're shortening the default. We've observed that current models don't need as verbose of prompting guidance, so we're reducing the amount of perscriptive guidance that deepagents has. This is reflected in the generic system prompt (which is now blank), and in the tool descriptions (which have been simplified).
