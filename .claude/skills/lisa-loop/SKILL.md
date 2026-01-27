# LISA Loop - Intelligent Development Workflow

A smarter, team-mirroring workflow that ensures code quality through deliberate planning, testing, and documentation.

## What is the LISA Loop?

The **LISA Loop** (named for Lisa Simpson, in contrast to the "Ralph Wiggum Loop" of random, issue-driven development) is a comprehensive development workflow that:

- **Changes are made deliberately** - researched, planned, and implemented with intent
- **Everything is tested and reviewed** - for reliability and to prevent regressions
- **Version control and documentation stay in sync** - so we don't break production
- **Changes are manageable in size** - allowing speedy QA/review and easier integration
- **Stakeholders stay informed** - documentation and project management tools reflect reality

## The Core Loop

```
1. PLAN        → Research + Architect
2. CODE         → Implement feature
3. QA           → Test implementation
   ├─── ✅ PASSED? → Skip to DOCUMENT
   └─── ❌ FAILED? → DEBUG
4. DEBUG        → Fix bugs (only if QA failed)
5. QA (RE-TEST) → MUST PASS to continue
6. DOCUMENT     → Update docs
7. COMMIT       → Commit changes
8. TRACK        → Update project tracking
9. OPTIMIZE     → When out of tasks, improve codebase
```

## Installation

To add the LISA Loop to a new project:

1. **Copy the entire `lisa-loop` folder** to your project's `.claude/skills/` directory:
   ```
   your-project/
   └── .claude/
       └── skills/
           └── lisa-loop/        ← Copy this folder
               ├── SKILL.md
               ├── WORKFLOW.md
               ├── rules.md
               └── agents/
                   ├── orchestrator.json
                   ├── project-research.json
                   ├── architect.json
                   ├── qa-specialist.json
                   ├── debug-specialist.json
                   ├── documentation-writer.json
                   ├── git-manager.json
                   └── project-manager.json
   ```

2. **Copy the agents** to your `.claude/agents/` directory:
   ```
   cp lisa-loop/agents/*.json ../../agents/
   ```

3. **Copy the workflow files** to your `.claude/` directory:
   ```
   cp lisa-loop/WORKFLOW.md ../../
   cp lisa-loop/rules.md ../../
   ```

Or on Linux/macOS:
```bash
# From your project root
cp -r .claude/skills/lisa-loop/agents/* .claude/agents/
cp .claude/skills/lisa-loop/WORKFLOW.md .claude/
cp .claude/skills/lisa-loop/rules.md .claude/
```

On Windows (PowerShell):
```powershell
# From your project root
Copy-Item .claude\skills\lisa-loop\agents\* .claude\agents\
Copy-Item .claude\skills\lisa-loop\WORKFLOW.md .claude\
Copy-Item .claude\skills\lisa-loop\rules.md .claude\
```

## Usage

Invoke the orchestrator with any development task:

```
User: "orchestrator: Add user authentication with login and registration"
```

The orchestrator will:
1. Break down the task into subtasks
2. Run the full LISA Loop autonomously
3. Provide progress updates
4. Only pause for critical decisions
5. Complete when all stages pass

## The Golden Rule

### 🔴 NO COMMIT WITHOUT QA

**Every single commit must pass QA first.** No exceptions.

- Even one-line changes
- Even documentation fixes in code files
- Even "obviously correct" tweaks
- Even emergency fixes

A one-line insert into a complex file is exactly how improper escapes and breaking changes happen. QA catches what humans miss.

## Agents

| Agent | Purpose | Stage |
|-------|---------|-------|
| orchestrator | LISA Loop conductor | All |
| project-research | Codebase investigation | 1a |
| architect | Design and planning | 1b |
| general-purpose | Most coding tasks | 2 |
| qa-specialist | Test and validate | 3, 5 |
| debug-specialist | Fix bugs | 4 |
| documentation-writer | Write documentation | 6 |
| git-manager | Handle git operations | 7 |
| project-manager | Track progress | 8 |

## Flow Decision Logic

| After Stage | Condition | Next Stage |
|-------------|-----------|------------|
| QA (3) | Passed ✅ | DOCUMENT (6) |
| QA (3) | Failed (minor bugs) | DEBUG (4) → QA (5) |
| QA (3) | Failed (major issues) | Return to PLAN (1) |
| DEBUG (4) | Complete | QA (5) for re-test |
| QA (5) | Passed ✅ | DOCUMENT (6) |

## Exceptions (Very Limited)

Only these may bypass the full LISA Loop:

| Exception | Allowed Flow |
|-----------|--------------|
| Pure documentation (non-code files) | Document → Commit → Track |
| README changes | Document → Commit → Track |
| True emergencies | Hotfix → Full LISA Loop (for permanent fix) |

## Success Criteria

A task is **COMPLETE** only when:

- [x] Research documented with file paths and line numbers
- [x] Implementation plan approved
- [x] Code implemented and working
- [x] **QA passed** (non-negotiable)
- [x] Documentation updated
- [x] Committed with clear message
- [x] Project tracking updated

## Documentation

- **[WORKFLOW.md](WORKFLOW.md)** - Complete workflow documentation
- **[rules.md](rules.md)** - Global rules for Claude Code

## Philosophy

The LISA Loop exists to:
- Prevent bugs from reaching production
- Reduce back-and-forth churn
- Keep documentation in sync
- Make collaboration easier
- Ensure changes are deliberate and tested

**When in doubt: Run the loop.**
