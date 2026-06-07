---
name: file-organizer
description: >
  Scan directories, find duplicate files by hash, categorize by type/date/purpose,
  and reorganize with a confirmation-gated plan. Use when the user says "organize
  my files", "clean up Downloads", "find duplicates", "declutter folders",
  "file management", or "sort files".
---

# File Organizer

**SAFETY: Always confirm with the user before moving or deleting any files. Log all operations so they can be undone.**

## Workflow

1. **Scope** — ask which directory, what problem (duplicates, messy, no structure), and any folders to skip
2. **Analyze** — survey target directory:
   ```bash
   find ~/Downloads -maxdepth 1 -type f | wc -l          # file count
   find ~/Downloads -maxdepth 1 -type f -name "*.pdf" | wc -l  # by type
   du -sh ~/Downloads                                      # total size
   ```
3. **Find duplicates** (if requested):
   ```bash
   find . -type f -exec shasum {} + | sort | uniq -D -w 40
   ```
   For each duplicate set: show paths, sizes, dates. Recommend keeping the newest in the best-named location. **Always ask before deleting.**
4. **Propose plan** — present before making any changes:
   ```
   ## Proposed Structure
   Downloads/
   ├── Work/
   ├── Personal/
   ├── Installers/
   └── Archive/

   ## Changes
   1. Create 4 folders
   2. Move 120 PDFs → Work/
   3. Move 45 images → Personal/
   4. Move 30 DMG/PKG → Installers/
   5. Delete 12 duplicate files (saving 89 MB)

   Ready to proceed? (yes/no/modify)
   ```
5. **Execute** — move files, log every operation, report results

## Grouping Strategies

| Strategy | Use when | Example categories |
|----------|----------|--------------------|
| By type | mixed file dump (Downloads) | Documents, Images, Videos, Archives, Code |
| By purpose | project-heavy directory | Work, Personal, Reference, Archive |
| By date | long-accumulated folder | Current year, Previous years, Archive |

