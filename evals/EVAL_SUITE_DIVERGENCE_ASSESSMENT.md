# Eval Suite Divergence Assessment (JS vs Python)

Date: 2026-04-13 (America/Los_Angeles)  
Scope compared:
- JS repo: `evals/` in this workspace (`/Users/hunter/.codex/worktrees/dce9/deepagentsjs`)
- Python repo: `langchain-ai/deepagents` at commit `6e57731fc6d908ac1ebe131e782696a4776147e9`, path `libs/evals/tests/evals`

## Executive summary

- Strong parity exists for `hitl`, `skills`, `subagents`, and `tool-usage-relational` (same scenario counts and near 1:1 intent).
- `files` is close but not complete: Python has 2 additional edge-case tests not present in JS.
- `memory` diverges more materially: JS covers baseline single-turn memory behavior, but Python adds richer persistence/non-persistence and backend-routing checks, plus a separate multi-turn memory suite.
- Python has several full suites with no JS counterpart (`summarization`, `tool_selection`, `todos`, `followup_quality`, `external_benchmarks`, `memory_agent_bench`, `tau2_airline`).
- JS has one major suite Python does not: `oolong` (10 dataset slices of long-context aggregation benchmark tasks).

## Progress update (2026-04-13)

Implemented in JS since this assessment draft:
- Added missing file edge cases in `evals/files/`:
  - pagination tail recovery
  - empty-file handling
- Added missing single-turn memory cases in `evals/memory/`:
  - transient info not persisted
  - formatting preference persistence
  - missing-memory graceful behavior without invented context
  - memory routing coverage for `/memories/AGENTS.md`
- Added new parity suites:
  - `evals/todos/`
  - `evals/tool-selection/`
  - `evals/followup-quality/`
  - `evals/memory-multiturn/`

Remaining highest-impact divergence:
- `summarization` now implemented in JS with backend offload + continued-task tests (compact-tool behavior is adapted to current JS middleware surface)
- `external_benchmarks` now implemented in JS with the curated 15-case FRAMES/Nexus/BFCL hard-set
- `memory_agent_bench` now implemented in JS as MemoryAgentBench-style long-context/conflict/file-seeded evals
- `tau2_airline` now implemented in JS as a 15-task policy-grounded airline tool-use suite

## Coverage matrix

| Capability area | JS status | Python status | Divergence |
| --- | --- | --- | --- |
| System prompt passthrough | Included in `basic` | Dedicated `test_system_prompt.py` | Equivalent coverage, organized differently |
| Unnecessary tool-call avoidance | `basic` | In `test_file_operations.py` | Equivalent behavior, different suite placement |
| File operations | 15 tests | 18 tests | JS missing 2 file-edge cases (see below); one Python test moved to JS `basic` |
| HITL | 3 tests | 3 tests | Near 1:1 parity |
| Memory (single-turn + static memory files) | 6 tests | 10 tests | JS missing 4 single-turn memory behaviors |
| Memory (multi-turn conversational persistence) | None | 3 parametrized tests | Missing in JS |
| Skills | 6 tests | 6 tests | Near 1:1 parity |
| Subagents | 2 tests | 2 tests | Near 1:1 parity |
| Tool-usage relational chaining | 18 tests | 18 tests | Near 1:1 parity |
| Summarization middleware / compact tool behavior | None | 5 tests | Missing in JS |
| Stateful TODO tool sequencing | None | 2 tests | Missing in JS |
| Tool selection / tool discovery | None | 8 tests | Missing in JS |
| Followup question quality (LLM judge) | None | 1 parametrized test (6 cases) | Missing in JS |
| External benchmark hard-set (FRAMES/Nexus/BFCL) | None | 3 parametrized tests (15 cases) | Missing in JS |
| MemoryAgentBench | None | Benchmark suite present | Missing in JS |
| tau2 airline benchmark | None | Benchmark suite present | Missing in JS |
| Oolong long-context benchmark | 10 dataset files | None in compared Python path | JS-only |

## High-confidence parity areas

- `hitl`: same 3 scenarios (`test_hitl_agent`, subagent HITL, subagent custom interrupt-on).
- `skills`: same 6 scenario intents (read full skill, read by name, combine skills, typo fix/no-read, typo fix/with-read, path disambiguation).
- `subagents`: same 2 scenarios (named subagent and general-purpose subagent).
- `tool-usage-relational`: same 18-step progression from single-tool to multi-hop relational lookups.

## Material gaps where JS lags Python

### 1) File ops edge behavior

Present in Python but missing in JS:
- `test_read_file_truncation_recovery_with_pagination`: verifies iterative paging to recover tail content from long files.
- `test_read_file_empty_file_reports_empty`: verifies explicit empty-file handling without hallucinated contents.

### 2) Memory durability semantics

Present in Python but missing in JS single-turn memory suite:
- `test_memory_does_not_persist_transient_info`
- `test_memory_updates_user_formatting_preference`
- `test_memory_missing_file_graceful_without_claiming_context`
- `test_memory_middleware_composite_backend`

Also missing entirely in JS:
- `test_memory_multiturn.py` (implicit preference capture, explicit remembered instruction, transient info not persisted across multi-turn exchanges).

### 3) Entire capability suites absent in JS

- `test_summarization.py` (context overflow, summarization event checks, conversation offload to filesystem, compact tool trigger/sensitivity tests).
- `test_tool_selection.py` (direct/indirect tool choice and chained tool calls over a mock tool pool).
- `test_todos.py` (stateful sequential `write_todos` updates with strict per-step expectations).
- `test_followup_quality.py` (LLM-judge scoring of clarification quality on underspecified requests).
- `test_external_benchmarks.py` + `external_benchmarks.py` (curated FRAMES/Nexus/BFCL hard-set runner + scoring).
- `memory_agent_bench/` benchmark runner.
- `tau2_airline/` benchmark domain + evaluator.

## Area where JS leads Python

- `evals/oolong/`: JS includes a dedicated Oolong benchmark implementation (10 dataset slices) for long-context aggregation scoring. This does not appear in the compared Python eval path.

## Harness-level divergence (affects comparability)

- Python leans heavily on strict `TrajectoryScorer` assertions (agent steps, tool-call request counts, step-specific tool calls), eval tier/category marks, and some LLM-judge usage.
- JS uses Vitest + LangSmith reporter with custom matchers and logs step counts as feedback, but generally has fewer strict step-count/tool-count assertions.
- Net effect: JS and Python are aligned on many scenario intentions, but not always on assertion strictness or diagnostic granularity.

## Suggested parity backlog (priority order)

1. Add JS equivalents for the 2 missing file edge-case tests (pagination tail recovery, empty-file handling).
2. Add JS memory durability tests mirroring Python’s 4 missing single-turn memory cases.
3. Add a JS multi-turn memory suite (implicit/explicit/transient triad).
4. Decide whether to port `tool_selection` and `todos` first (low setup cost, strong behavioral signal).
5. Decide whether benchmark parity is desired (`external_benchmarks`, `memory_agent_bench`, `tau2_airline`) or intentionally Python-only.
