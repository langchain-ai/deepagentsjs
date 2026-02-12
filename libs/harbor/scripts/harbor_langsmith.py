#!/usr/bin/env python3
"""
CLI for LangSmith integration with Harbor.

Provides commands for:
- Creating LangSmith datasets from Harbor tasks
- Creating experiment sessions

For attaching feedback to traces after a benchmark run, use
``upload_to_langsmith.py`` instead::

    cd python
    uv run python -m deepagents_js_harbor.upload_to_langsmith \\
        ../jobs/terminal-bench/<job-dir> --attach-feedback --project-name <experiment>
"""

import argparse
import asyncio
import datetime
import os
import tempfile
from pathlib import Path

import aiohttp
import toml
from dotenv import load_dotenv
from harbor.models.dataset_item import DownloadedDatasetItem
from harbor.registry.client import RegistryClientFactory
from langsmith import Client

load_dotenv()

LANGSMITH_API_URL = os.getenv("LANGSMITH_ENDPOINT", "https://api.smith.langchain.com")
HEADERS = {
    "x-api-key": os.getenv("LANGSMITH_API_KEY"),
}


# ============================================================================
# CREATE DATASET
# ============================================================================


def _read_instruction(task_path: Path) -> str:
    """Read the instruction.md file from a task directory."""
    instruction_file = task_path / "instruction.md"
    if instruction_file.exists():
        return instruction_file.read_text()
    return ""


def _read_task_metadata(task_path: Path) -> dict:
    """Read metadata from task.toml file."""
    task_toml = task_path / "task.toml"
    if task_toml.exists():
        return toml.load(task_toml)
    return {}


def _read_solution(task_path: Path) -> str | None:
    """Read the solution script from a task directory.

    Args:
        task_path: Path to the task directory

    Returns:
        Solution script content if it exists, None otherwise
    """
    solution_file = task_path / "solution" / "solve.sh"
    if solution_file.exists():
        return solution_file.read_text()
    return None


def _scan_downloaded_tasks(downloaded_tasks: list[DownloadedDatasetItem]) -> list:
    """Scan downloaded tasks and extract all task information.

    Args:
        downloaded_tasks: List of DownloadedDatasetItem objects from Harbor

    Returns:
        List of example dictionaries for LangSmith
    """
    examples = []

    for downloaded_task in downloaded_tasks:
        task_path = downloaded_task.downloaded_path

        instruction = _read_instruction(task_path)
        metadata = _read_task_metadata(task_path)
        solution = _read_solution(task_path)
        task_name = downloaded_task.id.name
        task_id = str(downloaded_task.id)

        if instruction:
            # Build outputs dict with reference solution if available
            outputs = {}
            if solution:
                outputs["reference_solution"] = solution

            example = {
                "inputs": {
                    "task_id": task_id,
                    "task_name": task_name,
                    "instruction": instruction,
                    "metadata": metadata.get("metadata", {}),
                },
                "outputs": outputs,
            }
            examples.append(example)

            solution_status = "with solution" if solution else "without solution"
            print(f"Added task: {task_name} (ID: {task_id}) [{solution_status}]")

    return examples


def create_dataset(
    dataset_name: str,
    version: str = "head",
    overwrite: bool = False,
    langsmith_name: str | None = None,
) -> None:
    """Create a LangSmith dataset from Harbor tasks.

    Args:
        dataset_name: Harbor registry dataset name (e.g., 'terminal-bench')
        version: Harbor dataset version (default: 'head')
        overwrite: Whether to overwrite cached remote tasks
        langsmith_name: Name for the LangSmith dataset (defaults to dataset_name)
    """
    ls_dataset_name = langsmith_name or dataset_name

    langsmith_client = Client()
    output_dir = Path(tempfile.mkdtemp(prefix="harbor_tasks_"))
    print(f"Using temporary directory: {output_dir}")

    # Download from Harbor registry
    print(f"Downloading dataset '{dataset_name}@{version}' from Harbor registry...")
    registry_client = RegistryClientFactory.create()
    downloaded_tasks = registry_client.download_dataset(
        name=dataset_name,
        version=version,
        overwrite=overwrite,
        output_dir=output_dir,
    )

    print(f"Downloaded {len(downloaded_tasks)} tasks")
    examples = _scan_downloaded_tasks(downloaded_tasks)

    print(f"\nFound {len(examples)} tasks")

    # Create the dataset
    print(f"\nCreating LangSmith dataset: {ls_dataset_name}")
    dataset = langsmith_client.create_dataset(dataset_name=ls_dataset_name)

    print(f"Dataset created with ID: {dataset.id}")

    # Add examples to the dataset
    print(f"\nAdding {len(examples)} examples to dataset...")
    langsmith_client.create_examples(dataset_id=dataset.id, examples=examples)

    print(f"\nSuccessfully created dataset '{ls_dataset_name}' with {len(examples)} examples")
    print(f"Dataset ID: {dataset.id}")


# ============================================================================
# CREATE EXPERIMENT
# ============================================================================


async def _create_experiment_session(
    dataset_id: str, name: str, session: aiohttp.ClientSession
) -> dict:
    """Create a LangSmith experiment session.

    Args:
        dataset_id: LangSmith dataset ID to associate with
        name: Name for the experiment session
        session: aiohttp ClientSession for making requests

    Returns:
        Experiment session dictionary with 'id' field
    """
    async with session.post(
        f"{LANGSMITH_API_URL}/sessions",
        headers=HEADERS,
        json={
            "start_time": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "reference_dataset_id": dataset_id,
            "name": name,
        },
    ) as experiment_response:
        if experiment_response.status == 200:
            return await experiment_response.json()
        else:
            raise Exception(
                f"Failed to create experiment: {experiment_response.status} "
                f"{await experiment_response.text()}"
            )


async def _get_dataset_by_name(dataset_name: str, session: aiohttp.ClientSession) -> dict:
    """Get a LangSmith dataset by name.

    Args:
        dataset_name: Name of the dataset to retrieve
        session: aiohttp ClientSession for making requests

    Returns:
        Dataset dictionary with 'id' field
    """
    async with session.get(
        f"{LANGSMITH_API_URL}/datasets?name={dataset_name}&limit=1",
        headers=HEADERS,
    ) as response:
        if response.status == 200:
            datasets = await response.json()
            if len(datasets) > 0:
                return datasets[0]
            else:
                raise Exception(f"Dataset '{dataset_name}' not found")
        else:
            raise Exception(
                f"Failed to get dataset: {response.status} {await response.text()}"
            )


async def create_experiment_async(dataset_name: str, experiment_name: str | None = None) -> str:
    """Create a LangSmith experiment session for the given dataset.

    Args:
        dataset_name: Name of the LangSmith dataset to create experiment for
        experiment_name: Optional name for the experiment (auto-generated if not provided)

    Returns:
        The experiment session ID
    """
    async with aiohttp.ClientSession() as session:
        # Get the dataset
        dataset = await _get_dataset_by_name(dataset_name, session)
        dataset_id = dataset["id"]
        print(f"Found dataset '{dataset_name}' with ID: {dataset_id}")

        # Generate experiment name if not provided
        if experiment_name is None:
            timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
            experiment_name = f"harbor-experiment-{timestamp}"

        # Create experiment session
        print(f"Creating experiment session: {experiment_name}")
        experiment_session = await _create_experiment_session(dataset_id, experiment_name, session)
        session_id = experiment_session["id"]
        tenant_id = experiment_session["tenant_id"]

        print("Experiment created successfully!")
        print(f"  Session ID: {session_id}")
        print(
            f"  View at: https://smith.langchain.com/o/{tenant_id}/datasets/"
            f"{dataset_id}/compare?selectedSessions={session_id}"
        )
        print("\nTo run Harbor with this experiment, use:")
        print(f"  LANGSMITH_EXPERIMENT={experiment_name} make bench-docker")

        return session_id


def create_experiment(dataset_name: str, experiment_name: str | None = None) -> str:
    """Synchronous wrapper for create_experiment_async."""
    return asyncio.run(create_experiment_async(dataset_name, experiment_name))


# ============================================================================
# CLI
# ============================================================================


def main() -> None:
    """Main CLI entrypoint with subcommands."""
    parser = argparse.ArgumentParser(
        description=(
            "Harbor-LangSmith integration CLI for managing datasets and experiments.\n\n"
            "For attaching feedback to traces after a benchmark run, use\n"
            "upload_to_langsmith.py instead (see README for details)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands", required=True)

    # ========================================================================
    # create-dataset subcommand
    # ========================================================================
    dataset_parser = subparsers.add_parser(
        "create-dataset",
        help="Create a LangSmith dataset from Harbor tasks",
    )
    dataset_parser.add_argument(
        "dataset_name",
        type=str,
        help="Harbor registry dataset name (e.g., 'terminal-bench')",
    )
    dataset_parser.add_argument(
        "--version",
        type=str,
        default="head",
        help="Harbor dataset version (default: 'head')",
    )
    dataset_parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite cached remote tasks",
    )
    dataset_parser.add_argument(
        "--langsmith-name",
        type=str,
        default=None,
        help="Name for the LangSmith dataset (defaults to dataset_name)",
    )

    # ========================================================================
    # create-experiment subcommand
    # ========================================================================
    experiment_parser = subparsers.add_parser(
        "create-experiment",
        help="Create an experiment session for a dataset",
    )
    experiment_parser.add_argument(
        "dataset_name",
        type=str,
        help="LangSmith dataset name (must already exist)",
    )
    experiment_parser.add_argument(
        "--name",
        type=str,
        help="Name for the experiment (auto-generated if not provided)",
    )

    args = parser.parse_args()

    # Route to appropriate command
    if args.command == "create-dataset":
        create_dataset(
            dataset_name=args.dataset_name,
            version=args.version,
            overwrite=args.overwrite,
            langsmith_name=args.langsmith_name,
        )
    elif args.command == "create-experiment":
        create_experiment(
            dataset_name=args.dataset_name,
            experiment_name=args.name,
        )

    return 0


if __name__ == "__main__":
    exit(main())
