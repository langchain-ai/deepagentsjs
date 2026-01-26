# Global Rules for Claude Code

## The LISA Loop - Primary Workflow

**ALL development tasks must use the LISA Loop workflow.**

Before starting any non-trivial work, invoke the Orchestrator agent:

```
User: "orchestrator: [describe task]"
```

### LISA Loop Philosophy

The **LISA Loop** (named for Lisa Simpson, in contrast to the "Ralph Wiggum Loop" of random, issue-driven development) ensures:

- **Changes are made deliberately** - researched, planned, and implemented with intent
- **Everything is tested and reviewed** - for reliability and to prevent regressions
- **Version control and documentation stay in sync** - so we don't break production
- **Changes are manageable in size** - allowing speedy QA/review and easier integration
- **Stakeholders stay informed** - documentation and project management tools reflect reality

See [`.claude/WORKFLOW.md`](.claude/WORKFLOW.md) for complete documentation.

### The Core Loop

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

## What Triggers Orchestrator Use?

Use the **orchestrator** agent for:
- Complex tasks requiring multiple specialist agents
- Multi-step projects with clear subtasks
- Tasks that need coordination and delegation
- **Any feature development or enhancement**

**Direct execution only for:**
- Simple, single-file edits (typos, small tweaks)
- Pure research/questions without implementation
- Single-function changes with clear requirements

**Everything else goes through the LISA Loop.**

---

## Exceptions (Very Limited)

Only these may bypass the full LISA Loop:

| Exception | Allowed Flow |
|-----------|--------------|
| Pure documentation (non-code files) | Document → Commit → Track |
| README changes | Document → Commit → Track |
| True emergencies | Hotfix → Full LISA Loop (for permanent fix) |

---

## Flow Decision Logic

The orchestrator makes intelligent routing decisions:

| After Stage | Condition | Next Stage |
|-------------|-----------|------------|
| QA (3) | Passed ✅ | DOCUMENT (6) |
| QA (3) | Failed (minor bugs) | DEBUG (4) → QA (5) |
| QA (3) | Failed (major issues) | Return to PLAN (1) |
| DEBUG (4) | Complete | QA (5) for re-test |
| QA (5) | Passed ✅ | DOCUMENT (6) |
| TRACK (8) | More tasks | Next task |
| TRACK (8) | No tasks | OPTIMIZE (9) |

---

## Git Workflow Requirements

**CRITICAL:**

1. **NEVER commit directly to `main`** - always use feature branches
2. **ALWAYS create a Pull Request** for review
3. **Branch naming:**
   - Features: `feature/description`
   - Bug fixes: `fix/description`
   - Docs: `docs/description`
4. **Conventional commits** with clear messages
5. **QA must pass before any commit**

---

## Quick Agent Reference

| Agent | Purpose | Stage |
|-------|---------|-------|
| [orchestrator](.claude/agents/orchestrator.json) | LISA Loop conductor | All |
| [project-research](.claude/agents/project-research.json) | Codebase investigation | 1a |
| [architect](.claude/agents/architect.json) | Design and planning | 1b |
| general-purpose | Most coding tasks | 2 |
| [qa-specialist](.claude/agents/qa-specialist.json) | Test and validate | 3, 5 |
| [debug-specialist](.claude/agents/debug-specialist.json) | Fix bugs | 4 |
| [documentation-writer](.claude/agents/documentation-writer.json) | Write documentation | 6 |
| [git-manager](.claude/agents/git-manager.json) | Handle git operations | 7 |
| [project-manager](.claude/agents/project-manager.json) | Track progress | 8 |

### Optional Specialists

| Agent | When to Use |
|-------|-------------|
| [code-reviewer](.claude/agents/code-reviewer.json) | After Code, before QA |
| [performance-analyst](.claude/agents/performance-analyst.json) | Performance concerns |
| [api-specialist](.claude/agents/api-specialist.json) | API work |
| [security-reviewer](.claude/agents/security-reviewer.json) | Security audits |
| [frontend-designer](.claude/agents/frontend-designer.json) | UI/UX work |
| [devops](.claude/agents/devops.json) | Infrastructure |

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

## Autonomous Execution

When working through the LISA Loop:
- **Work autonomously** through stages
- **Provide progress updates** regularly
- **Only pause** for critical decisions or blockers
- **Handle minor issues** independently

The orchestrator can:
- Create new agents for specialized needs
- Invoke skills for specific capabilities
- Use best judgment on specialist vs generalist

---

**Remember**: Quality requires discipline. The LISA Loop prevents bugs, maintains code quality, and ensures nothing is forgotten.

**When in doubt: Use the orchestrator.**
