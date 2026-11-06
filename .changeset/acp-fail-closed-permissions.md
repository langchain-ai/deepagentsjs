---
"deepagents-acp": patch
---

Enforce ACP permissions before tools execute, including declarative and default general-purpose subagents. Permission errors, unknown choices, cancellation, and changed arguments no longer authorize execution. Shell “Always allow” remembers only the exact command and arguments in the same session context, rather than allowing every `execute` call; prompts show the full command. Grants remain in memory and do not survive restarts. Configurations with opaque compiled/remote subagents or model profiles excluding the permission middleware are now rejected because their internal tool calls cannot be gated by the adapter.
