"""Upload Harbor job results to LangSmith and attach feedback to traces.

Two modes of operation:

1. **Attach feedback** (primary) — stamps pass/fail, reward, and test
   scores on the detailed traces that were auto-captured during the
   benchmark run (via ``LANGCHAIN_TRACING_V2``).

2. **Upload experiment** (optional) — uploads structured experiment rows
   to the ``/datasets/upload-experiment`` endpoint for the side-by-side
   comparison table in LangSmith's "Datasets & Experiments" view.

Usage::

    # Attach pass/fail feedback to traces (primary workflow)
    python -m deepagents_js_harbor.upload_to_langsmith \\
        jobs/terminal-bench/2026-02-10__18-17-58 \\
        --attach-feedback --project-name my-experiment

    # Upload structured experiment table
    python -m deepagents_js_harbor.upload_to_langsmith \\
        jobs/terminal-bench/2026-02-10__18-17-58 \\
        --upload --dataset-name terminal-bench-v2

    # Both at once
    python -m deepagents_js_harbor.upload_to_langsmith \\
        jobs/terminal-bench/2026-02-10__18-17-58 \\
        --attach-feedback --upload

Environment variables:
    LANGSMITH_API_KEY    -- Required. Your LangSmith API key.
    LANGSMITH_ENDPOINT   -- Optional. Defaults to https://api.smith.langchain.com
    LANGSMITH_EXPERIMENT -- Used as default --project-name for feedback.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path

from dotenv import load_dotenv
import requests

load_dotenv()


# -----------------------------------------------------------------------
# Defaults
# -----------------------------------------------------------------------

_DEFAULT_ENDPOINT = "https://api.smith.langchain.com"
_UPLOAD_PATH = "/api/v1/datasets/upload-experiment"


# -----------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------


def _read_json(path: Path) -> dict | list | None:
    """Read a JSON file, returning None if it doesn't exist or is invalid."""
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _read_text(path: Path) -> str | None:
    """Read a text file, returning None if missing."""
    if not path.is_file():
        return None
    try:
        return path.read_text().strip()
    except OSError:
        return None


def _discover_trial_dirs(job_dir: Path) -> list[Path]:
    """Find all trial subdirectories within a job directory.

    Trial dirs are any subdirectory containing a ``result.json``.
    """
    trials = []
    for child in sorted(job_dir.iterdir()):
        if child.is_dir() and (child / "result.json").is_file():
            trials.append(child)
    return trials


def _parse_verifier(trial_dir: Path) -> dict:
    """Read verifier outputs for a trial.

    Returns a dict with ``reward``, ``passed``, ``tests_passed``,
    ``tests_failed``, ``tests_total``.
    """
    reward_text = _read_text(trial_dir / "verifier" / "reward.txt")
    reward = float(reward_text) if reward_text is not None else None

    ctrf = _read_json(trial_dir / "verifier" / "ctrf.json")
    ctrf_summary = ctrf.get("results", {}).get("summary", {}) if ctrf else {}
    tests_passed = ctrf_summary.get("passed", 0) if ctrf_summary else 0
    tests_failed = ctrf_summary.get("failed", 0) if ctrf_summary else 0
    tests_total = ctrf_summary.get("tests", 0) if ctrf_summary else 0

    return {
        "reward": reward,
        "passed": reward is not None and reward > 0,
        "tests_passed": tests_passed,
        "tests_failed": tests_failed,
        "tests_total": tests_total,
    }


# -----------------------------------------------------------------------
# Feedback attachment (primary workflow)
# -----------------------------------------------------------------------


def _find_run_by_session_id(
    client: "langsmith.Client",  # noqa: F821
    project_name: str,
    session_id: str,
) -> object | None:
    """Find the root LangSmith run whose metadata contains ``harbor_session_id``.

    Returns the first matching Run object, or None if not found.
    """
    filter_str = (
        f'and(eq(is_root, true), '
        f'eq(metadata_key, "harbor_session_id"), '
        f'eq(metadata_value, "{session_id}"))'
    )
    try:
        for run in client.list_runs(
            project_name=project_name,
            filter=filter_str,
            limit=1,
        ):
            return run
    except Exception as e:
        print(f"  Warning: Failed to query runs for {session_id}: {e}", file=sys.stderr)
    return None


def attach_feedback(
    job_dir: Path,
    *,
    project_name: str,
    api_key: str | None = None,
    dry_run: bool = False,
) -> int:
    """Attach pass/fail feedback to LangSmith traces for a Harbor job.

    For each trial in the job:
      1. Reads verifier results (``reward.txt``, ``ctrf.json``).
      2. Finds the matching root run in LangSmith via
         ``metadata.harbor_session_id``.
      3. Creates feedback (pass, reward, test_pass_rate) on that run.

    Returns the number of runs that received feedback.
    """
    import langsmith

    api_key = api_key or os.environ.get("LANGSMITH_API_KEY", "")
    if not api_key:
        print("Error: LANGSMITH_API_KEY is not set.", file=sys.stderr)
        return 0

    job_dir = Path(job_dir).resolve()
    if not job_dir.is_dir():
        print(f"Error: {job_dir} is not a directory.", file=sys.stderr)
        return 0

    trial_dirs = _discover_trial_dirs(job_dir)
    if not trial_dirs:
        print(f"Warning: no trial directories found in {job_dir}", file=sys.stderr)
        return 0

    client = langsmith.Client(api_key=api_key)
    attached = 0

    print(f"Attaching feedback to LangSmith traces in project '{project_name}'...")
    print(f"  Job: {job_dir.name}")
    print(f"  Trials: {len(trial_dirs)}")
    print()

    for trial_dir in trial_dirs:
        result = _read_json(trial_dir / "result.json")
        if not result:
            continue

        trial_name = result.get("trial_name", trial_dir.name)
        task_name = result.get("task_name", trial_dir.name)
        verifier = _parse_verifier(trial_dir)

        if dry_run:
            status = "PASS" if verifier["passed"] else "FAIL"
            print(f"  [{status}] {task_name} (session={trial_name}, reward={verifier['reward']})")
            continue

        run = _find_run_by_session_id(client, project_name, trial_name)
        if run is None:
            print(f"  SKIP {task_name}: no matching trace found for {trial_name}")
            continue

        run_id = run.id  # type: ignore[union-attr]

        try:
            client.create_feedback(
                run_id=run_id,
                key="pass",
                score=1.0 if verifier["passed"] else 0.0,
                comment=f"{'Passed' if verifier['passed'] else 'Failed'}: {task_name}",
            )
            if verifier["reward"] is not None:
                client.create_feedback(
                    run_id=run_id,
                    key="reward",
                    score=verifier["reward"],
                    comment=f"Verifier reward for {task_name}",
                )
            if verifier["tests_total"] > 0:
                client.create_feedback(
                    run_id=run_id,
                    key="test_pass_rate",
                    score=verifier["tests_passed"] / verifier["tests_total"],
                    comment=f"{verifier['tests_passed']}/{verifier['tests_total']} tests passed",
                )

            status = "PASS" if verifier["passed"] else "FAIL"
            print(f"  [{status}] {task_name} — feedback attached to run {run_id}")
            attached += 1

        except Exception as e:
            print(f"  ERROR {task_name}: failed to attach feedback: {e}", file=sys.stderr)

    print(f"\nDone. Attached feedback to {attached}/{len(trial_dirs)} trace(s).")
    return attached


# -----------------------------------------------------------------------
# Experiment upload (optional — structured comparison tables)
# -----------------------------------------------------------------------


def _parse_trial(trial_dir: Path) -> dict | None:
    """Parse a trial directory into a LangSmith upload-experiment row.

    Only reads ``result.json`` and verifier outputs — all execution
    detail (LLM calls, tool calls, tokens) is already captured in the
    auto-traced LangSmith runs.
    """
    result = _read_json(trial_dir / "result.json")
    if not result:
        return None

    task_name = result.get("task_name", trial_dir.name)
    trial_name = result.get("trial_name", trial_dir.name)
    started_at = result.get("started_at")
    finished_at = result.get("finished_at")
    agent_info = result.get("agent_info", {})

    verifier = _parse_verifier(trial_dir)

    # Exception info
    exception_info = result.get("exception_info")
    exception_text = _read_text(trial_dir / "exception.txt")
    error = str(exception_info) if exception_info else (exception_text or None)

    row: dict = {
        "row_id": str(uuid.uuid4()),
        "run_name": trial_name,
        "inputs": {"task_name": task_name},
        "expected_outputs": {"reward": 1.0},
        "actual_outputs": {
            "reward": verifier["reward"],
            "tests_passed": verifier["tests_passed"],
            "tests_failed": verifier["tests_failed"],
            "tests_total": verifier["tests_total"],
        },
        "start_time": started_at or "1970-01-01T00:00:00Z",
        "end_time": finished_at or "1970-01-01T00:00:00Z",
        "run_metadata": {
            "task_name": task_name,
            "trial_name": trial_name,
            "agent_name": agent_info.get("name", "unknown"),
        },
    }
    if error:
        row["error"] = error

    scores: list[dict] = []
    if verifier["reward"] is not None:
        scores.append({"key": "reward", "score": verifier["reward"]})
    scores.append({
        "key": "pass",
        "score": 1 if verifier["passed"] else 0,
    })
    if verifier["tests_total"] > 0:
        scores.append({
            "key": "test_pass_rate",
            "score": verifier["tests_passed"] / verifier["tests_total"],
        })
    if error:
        scores.append({"key": "error", "score": 0, "value": error[:500]})
    row["evaluation_scores"] = scores

    return row


def upload_job(
    job_dir: Path,
    *,
    dataset_name: str,
    experiment_name: str | None = None,
    experiment_description: str | None = None,
    api_key: str | None = None,
    endpoint: str | None = None,
    dry_run: bool = False,
) -> dict | None:
    """Upload all trials in a Harbor job directory to LangSmith.

    Creates a structured experiment in the "Datasets & Experiments" view.
    This is separate from (and complementary to) the auto-traced runs.
    """
    api_key = api_key or os.environ.get("LANGSMITH_API_KEY", "")
    if not api_key:
        print("Error: LANGSMITH_API_KEY is not set.", file=sys.stderr)
        return None

    endpoint = (
        endpoint
        or os.environ.get("LANGSMITH_ENDPOINT", "").rstrip("/")
        or _DEFAULT_ENDPOINT
    )

    job_dir = Path(job_dir).resolve()
    if not job_dir.is_dir():
        print(f"Error: {job_dir} is not a directory.", file=sys.stderr)
        return None

    trial_dirs = _discover_trial_dirs(job_dir)
    if not trial_dirs:
        print(f"Warning: no trial directories found in {job_dir}", file=sys.stderr)
        return None

    rows = [r for td in trial_dirs if (r := _parse_trial(td)) is not None]
    if not rows:
        print(f"Warning: no valid trial results in {job_dir}", file=sys.stderr)
        return None

    job_config = _read_json(job_dir / "config.json") or {}
    job_result = _read_json(job_dir / "result.json") or {}

    exp_name = experiment_name or job_dir.name
    exp_desc = experiment_description or (
        f"Harbor job {job_dir.name} | "
        f"{job_result.get('n_total_trials', len(rows))} trial(s) | "
        f"dataset: {job_config.get('datasets', [{}])[0].get('name', 'unknown')}"
    )

    all_starts = [r["start_time"] for r in rows if r.get("start_time")]
    all_ends = [r["end_time"] for r in rows if r.get("end_time")]

    payload = {
        "experiment_name": exp_name,
        "experiment_description": exp_desc,
        "dataset_name": dataset_name,
        "dataset_description": f"Harbor benchmark dataset: {dataset_name}",
        "experiment_start_time": min(all_starts) if all_starts else "1970-01-01T00:00:00Z",
        "experiment_end_time": max(all_ends) if all_ends else "1970-01-01T00:00:00Z",
        "results": rows,
    }

    n_trials = len(rows)

    if dry_run:
        print(f"\n{'='*60}")
        print(f"DRY RUN — would upload to {endpoint}{_UPLOAD_PATH}")
        print(f"  Experiment:  {exp_name}")
        print(f"  Dataset:     {dataset_name}")
        print(f"  Trials:      {n_trials}")
        print(f"{'='*60}")
        print(json.dumps(payload, indent=2))
        return None

    url = f"{endpoint}{_UPLOAD_PATH}"
    headers = {"x-api-key": api_key, "Content-Type": "application/json"}

    print(f"Uploading {n_trials} trial(s) to LangSmith...")
    print(f"  Experiment:  {exp_name}")
    print(f"  Dataset:     {dataset_name}")
    print(f"  Endpoint:    {url}")

    resp = requests.post(url, headers=headers, json=payload, timeout=60)

    if resp.status_code >= 400:
        print(f"\nError: LangSmith returned {resp.status_code}", file=sys.stderr)
        print(resp.text, file=sys.stderr)
        return None

    result = resp.json()
    experiment_info = result.get("experiment", {})
    dataset_info = result.get("dataset", {})
    print(f"\nSuccess!")
    print(f"  Experiment ID:  {experiment_info.get('id', 'n/a')}")
    print(f"  Dataset ID:     {dataset_info.get('id', 'n/a')}")

    langsmith_ui = endpoint.replace("api.smith", "smith")
    if experiment_info.get("id") and dataset_info.get("id"):
        print(
            f"  View at:        {langsmith_ui}/datasets/"
            f"{dataset_info['id']}/compare?"
            f"selectedSessions={experiment_info['id']}"
        )

    return result


# -----------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Upload Harbor job results to LangSmith.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "job_dir",
        type=Path,
        help=(
            "Path to a Harbor job directory (e.g. "
            "jobs/terminal-bench/2026-02-10__18-17-58). "
            "With --all, pass the parent dataset directory instead."
        ),
    )
    parser.add_argument(
        "--attach-feedback",
        action="store_true",
        help=(
            "Attach pass/fail feedback to existing LangSmith traces. "
            "Requires --project-name or LANGSMITH_EXPERIMENT."
        ),
    )
    parser.add_argument(
        "--project-name",
        default=None,
        help=(
            "LangSmith project to search for traces (for --attach-feedback). "
            "Defaults to LANGSMITH_EXPERIMENT env var."
        ),
    )
    parser.add_argument(
        "--upload",
        action="store_true",
        help=(
            "Upload structured experiment data to LangSmith's "
            "Datasets & Experiments view."
        ),
    )
    parser.add_argument(
        "--dataset-name",
        default=None,
        help="LangSmith dataset name for --upload (defaults to parent dir name).",
    )
    parser.add_argument(
        "--experiment-name",
        default=None,
        help="Override the experiment name for --upload (defaults to job dir name).",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        dest="upload_all",
        help="Process all job directories under the given path.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would happen without calling the API.",
    )

    args = parser.parse_args()
    job_dir: Path = args.job_dir.resolve()

    # Default: if neither --attach-feedback nor --upload specified,
    # assume --attach-feedback (the primary workflow).
    if not args.attach_feedback and not args.upload:
        args.attach_feedback = True

    # ---- Feedback attachment ----
    if args.attach_feedback:
        project = (
            args.project_name
            or os.environ.get("LANGSMITH_EXPERIMENT", "").strip()
        )
        if not project:
            print(
                "Error: --attach-feedback requires --project-name or "
                "LANGSMITH_EXPERIMENT env var.",
                file=sys.stderr,
            )
            sys.exit(1)

        if args.upload_all:
            job_dirs = sorted(
                d for d in job_dir.iterdir()
                if d.is_dir() and (d / "result.json").is_file()
            )
            if not job_dirs:
                print(f"No job directories found in {job_dir}", file=sys.stderr)
                sys.exit(1)
            for jd in job_dirs:
                print(f"\n--- Feedback: {jd.name} ---")
                attach_feedback(jd, project_name=project, dry_run=args.dry_run)
        else:
            attach_feedback(job_dir, project_name=project, dry_run=args.dry_run)

    # ---- Experiment upload ----
    if args.upload:
        if args.upload_all:
            dataset_name = args.dataset_name or job_dir.name
        else:
            dataset_name = args.dataset_name or job_dir.parent.name

        if args.upload_all:
            job_dirs = sorted(
                d for d in job_dir.iterdir()
                if d.is_dir() and (d / "result.json").is_file()
            )
            if not job_dirs:
                print(f"No job directories found in {job_dir}", file=sys.stderr)
                sys.exit(1)

            print(f"\nFound {len(job_dirs)} job(s) to upload.\n")
            for jd in job_dirs:
                print(f"\n--- Upload: {jd.name} ---")
                upload_job(
                    jd,
                    dataset_name=dataset_name,
                    experiment_name=args.experiment_name,
                    dry_run=args.dry_run,
                )
        else:
            result = upload_job(
                job_dir,
                dataset_name=dataset_name,
                experiment_name=args.experiment_name,
                dry_run=args.dry_run,
            )
            if result is None and not args.dry_run:
                sys.exit(1)


if __name__ == "__main__":
    main()
