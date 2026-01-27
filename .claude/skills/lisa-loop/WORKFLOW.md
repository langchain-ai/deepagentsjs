# The LISA Loop - Intelligent Development Workflow

## Philosophy

The **LISA Loop** (named for Lisa Simpson, in contrast to the "Ralph Wiggum Loop" of random, issue-driven development) is a smarter, team-mirroring workflow that ensures:

- **Changes are made deliberately** - researched, planned, and implemented with intent
- **Everything is tested and reviewed** - for reliability and to prevent regressions
- **Version control and documentation stay in sync** - so we don't break production
- **Changes are manageable in size** - allowing speedy QA/review and easier integration
- **Stakeholders stay informed** - documentation and project management tools reflect reality

The flow isn't a rigid nine steps. If QA passes on the first try, the workflow is two steps shorter. But the **QA step is critical** - ALL changes must be QA'd, even one-liners. A single-line insert into a complex file is how improper escapes and breaking changes slip through.

---

## The Core LISA Loop

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      THE LISA LOOP - CORE FLOW                          │
│                    (rigidly enforced, flexible execution)               │
└─────────────────────────────────────────────────────────────────────────┘

1. PLAN        ───────────────────────────────────────────────────────┐
   ├─ 1a. RESEARCH    → project-research agent                         │
   └─ 1b. ARCHITECT   → architect agent                               │
                                                                       │
2. CODE         → general-purpose agent (parallel for independent)    │
                                                                       │
3. QA           → qa-specialist agent (parallel for independent)      │
     │                                                                 │
     ├─── ✅ PASSED? ─────────────────────────────────────────────────┤
     │              ↓                                                  │
     └─── ❌ FAILED? ↓ (only if needed)                                │
                    │                                                  │
4. DEBUG        → debug-specialist agent (parallel for independent)   │
     │              ↓                                                  │
     └──────────────┴──────────────────────────────────────────────────┤
                    ↓                                                  │
5. QA (RE-TEST) → qa-specialist agent (MUST PASS to continue)        │
                    ↓                                                  │
6. DOCUMENT     → documentation-writer agent                          │
                    ↓                                                  │
7. COMMIT       → git-manager agent (QA runs BEFORE every commit)     │
                    ↓                                                  │
8. TRACK        → project-manager agent                               │
                    ↓                                                  │
9. OPTIMIZE     → orchestrator (when out of tasks)                    │
                                                                       │
└───────────────────────────────────────────────────────────────────────┘

🔴 CRITICAL RULE: No commit passes without QA approval. We do NOT push broken code.
```

---

## Flow Logic

### Conditional Paths

**If QA passes (first try):**
```
1. PLAN → 2. CODE → 3. QA ✅ → 6. DOCUMENT → 7. COMMIT → 8. TRACK
```

**If QA fails (requires debug):**
```
1. PLAN → 2. CODE → 3. QA ❌ → 4. DEBUG → 5. QA ✅ → 6. DOCUMENT → 7. COMMIT → 8. TRACK
```

**If QA reveals major architectural issues:**
```
... → 3. QA ❌ → return to 1. PLAN (research/architect redesign)
```

### Dynamic Agent Creation

The orchestrator has authority to:
- Create new agents for specialized needs
- Create or invoke skills for specific capabilities
- Spawn new task workflows as needed
- Use best judgment on when to use specialists vs generalists

### When Out of Tasks

When the project task queue is empty, the orchestrator enters **OPTIMIZE mode**:
- Analyze codebase for improvement opportunities
- Identify technical debt to address
- Suggest new features based on project goals
- Run optimization and refactoring agents

---

## Agent Responsibilities

| Stage | Agent | Responsibility | Handoff To |
|-------|-------|----------------|------------|
| 1a | [project-research](.claude/agents/project-research.json) | Investigate codebase, gather context | Architect (1b) |
| 1b | [architect](.claude/agents/architect.json) | Design system, create implementation plan | Code (2) |
| 2 | general-purpose | Implement feature | QA (3) |
| 3 | [qa-specialist](.claude/agents/qa-specialist.json) | Test implementation | Debug (4) or Document (6) |
| 4 | [debug-specialist](.claude/agents/debug-specialist.json) | Fix bugs | QA (5) |
| 5 | [qa-specialist](.claude/agents/qa-specialist.json) | Re-test fixes | Document (6) |
| 6 | [documentation-writer](.claude/agents/documentation-writer.json) | Update docs | Commit (7) |
| 7 | [git-manager](.claude/agents/git-manager.json) | Commit changes | Track (8) |
| 8 | [project-manager](.claude/agents/project-manager.json) | Update tracking | Optimize (9) or Complete |
| 9 | [orchestrator](.claude/agents/orchestrator.json) | Optimize, suggest new features | Plan (1) or Complete |

---

## Orchestrator's Role

The **orchestrator** is the LISA Loop conductor. It:

1. **Receives high-level tasks** from users or project managers
2. **Breaks down into subtasks** using TodoWrite
3. **Delegates to specialist agents** at each stage
4. **Makes flow decisions**:
   - QA pass? Skip to Document
   - QA fail? Route to Debug
   - Major issues? Return to Plan
   - Out of tasks? Enter Optimize mode
5. **Tracks progress** through all stages
6. **Only completes** when the full loop is done

### Key Orchestrator Powers

- **Dynamic routing** - Adjust workflow based on results
- **Agent creation** - Spawn new agents for unmet needs
- **Parallel execution** - Run independent tasks simultaneously
- **Loop control** - Return to earlier stages if needed
- **Autonomous operation** - Work through long tasks without constant oversight

---

## The Golden Rule

### 🔴 NO COMMIT WITHOUT QA

**Every single commit must pass QA first.** No exceptions.

- Even one-line changes
- Even documentation fixes in code files
- Even "obviously correct" tweaks
- Even emergency fixes

A one-line insert into a complex file is exactly how improper escapes and breaking changes happen. QA catches what humans miss.

---

## Exceptions (Very Limited)

Only these may bypass the full LISA Loop:

| Exception | Allowed Flow |
|-----------|--------------|
| Pure documentation (non-code files) | Document → Commit → Track |
| README changes | Document → Commit → Track |
| True emergencies | Hotfix → Full LISA Loop (for permanent fix) |

**Everything else goes through the loop.**

---

## Quick Agent Reference

### Workflow Agents

| Agent | Purpose | Stage |
|-------|---------|-------|
| [orchestrator](.claude/agents/orchestrator.json) | Loop conductor, task delegation | All |
| [architect](.claude/agents/architect.json) | Design and planning | 1b |
| [project-research](.claude/agents/project-research.json) | Codebase investigation | 1a |
| [qa-specialist](.claude/agents/qa-specialist.json) | Test and validate | 3, 5 |
| [debug-specialist](.claude/agents/debug-specialist.json) | Fix bugs | 4 |
| [documentation-writer](.claude/agents/documentation-writer.json) | Write documentation | 6 |
| [git-manager](.claude/agents/git-manager.json) | Handle git operations | 7 |
| [project-manager](.claude/agents/project-manager.json) | Track progress | 8 |

### Optional Specialists

| Agent | When to Use | Purpose |
|-------|-------------|---------|
| [code-reviewer](.claude/agents/code-reviewer.json) | After Code, before QA | Catch issues early |
| [performance-analyst](.claude/agents/performance-analyst.json) | Performance concerns | Optimize bottlenecks |
| [api-specialist](.claude/agents/api-specialist.json) | API work | Design and review APIs |
| [security-reviewer](.claude/agents/security-reviewer.json) | Security audits | Find vulnerabilities |
| [frontend-designer](.claude/agents/frontend-designer.json) | UI/UX work | React/TypeScript interfaces |
| [devops](.claude/agents/devops.json) | Infrastructure | Deploy and manage systems |

---

## Git Workflow Rules

**CRITICAL: All code changes must follow this git workflow:**

1. **NEVER commit directly to `main`**
   - `main` is protected and should only receive changes via merge
   - Always create a feature branch for any work

2. **ALWAYS create a Pull Request**
   - All changes must be reviewed via PR before merging
   - Use the gh CLI: `gh pr create`
   - Include QA results in PR description

3. **Branch naming convention:**
   - Features: `feature/description`
   - Bug fixes: `fix/description`
   - Docs: `docs/description`
   - Refactors: `refactor/description`

4. **Commit requirements:**
   - Clear commit messages following conventional commits
   - Include `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>` for AI-assisted commits
   - Reference issue numbers if applicable

---

## Success Criteria

A task is **COMPLETE** only when:

- [x] Research documented with file paths and line numbers
- [x] Implementation plan approved
- [x] Code implemented and working
- [x] **QA passed** (non-negotiable)
- [x] Documentation updated
- [x] Committed with clear message
- [x] Project tracking updated

---

## Usage

### For Any Development Task

Invoke the orchestrator with your task:

```
User: "orchestrator: Add user authentication with login, registration, and password reset"
```

The orchestrator will:
1. Break down the task into subtasks
2. Run the full LISA Loop autonomously
3. Provide progress updates
4. Only pause for critical decisions
5. Complete when all stages pass

---

## Remember

> **"Quality requires discipline."**

The LISA Loop exists to prevent bugs, maintain code quality, and ensure nothing is forgotten. It may feel like extra steps, but it saves time by:
- Catching issues before they reach production
- Reducing back-and-forth churn
- Keeping documentation in sync
- Making collaboration easier

**When in doubt: Run the loop.**
