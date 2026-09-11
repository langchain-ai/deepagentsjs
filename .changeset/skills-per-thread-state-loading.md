---
"deepagents": patch
---

fix(deepagents): pin skills metadata on per-thread basis

`createSkillsMiddleware` stored loaded skills in a `loadedSkills` closure, created once per middleware instance and reused for every invocation that instance serves. A single agent commonly serves many threads, so the first thread to load won for all of them: later threads were given the first thread's skills metadata and never saw their own. Skills are now loaded per invocation from graph state.
