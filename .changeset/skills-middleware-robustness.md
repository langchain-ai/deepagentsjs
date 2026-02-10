---
"deepagents": patch
---

fix(skills): improve skills middleware input validation and add annotations

Port of Python PR #1189. Hardens `parseSkillMetadataFromContent` with stricter
coercion/trimming for all YAML fields, adds Unicode lowercase support in
`validateSkillName`, validates and truncates compatibility length, handles
`allowed-tools` as YAML list or space-delimited string, and shows
license/compatibility annotations in the system prompt skill listing.
