"""Harbor agent wrapper that runs deepagents-js via a JSON-RPC bridge.

Spawns a Node.js process running the deepagents-js agent and bridges
Harbor's environment.exec() via newline-delimited JSON over stdin/stdout.
"""

import asyncio
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from langsmith import trace
from langsmith.client import Client
from langsmith.run_helpers import get_current_run_tree

load_dotenv()

# Harmless TTY noise from non-interactive bash in Docker containers.
_TTY_NOISE = [
    "bash: cannot set terminal process group (-1): Inappropriate ioctl for device",
    "bash: cannot set terminal process group (1): Inappropriate ioctl for device",
    "bash: no job control in this shell",
    "bash: initialize_job_control: no job control in background: Bad file descriptor",
]

SYSTEM_MESSAGE = """\
You are an autonomous agent executing tasks in a sandboxed environment. \
Follow these instructions carefully.

## WORKING DIRECTORY & ENVIRONMENT CONTEXT

Your current working directory is:
{current_directory}

{file_listing_header}
{file_listing}

**IMPORTANT**: This directory information is provided for your convenience \
at the start of the task. You should:
- Use this information to understand the initial environment state
- Avoid redundantly calling `ls` or similar commands just to list the same directory
- Only use file listing commands if you need updated information \
(after creating/deleting files) or need to explore subdirectories
- Work in the /app directory unless explicitly instructed otherwise
"""


# ---------------------------------------------------------------------------
# Runner discovery
# ---------------------------------------------------------------------------

# This file lives at:  libs/harbor/python/deepagents_js_harbor/wrapper.py
# The TS source is at: libs/harbor/src/runner.ts
# The built JS is at:  libs/harbor/dist/runner.js
_HARBOR_ROOT = Path(__file__).resolve().parent.parent.parent  # libs/harbor/


def _find_js_runner() -> str:
    """Locate the JS runner script.

    Search order:
      1. DEEPAGENTS_JS_RUNNER env var (explicit override)
      2. Built dist/runner.js (production)
      3. Source src/runner.ts  (development via tsx)
    """
    env_path = os.environ.get("DEEPAGENTS_JS_RUNNER", "").strip()
    if env_path and os.path.isfile(env_path):
        return os.path.abspath(env_path)

    candidates = [
        _HARBOR_ROOT / "dist" / "runner.js",
        _HARBOR_ROOT / "src" / "runner.ts",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)

    search_paths = "\n  ".join(
        [f"DEEPAGENTS_JS_RUNNER env var: {env_path or '(not set)'}"]
        + [f"{c}" for c in candidates]
    )
    raise FileNotFoundError(
        f"Could not find the deepagents-js Harbor runner.\n"
        f"Searched:\n  {search_paths}\n\n"
        f"Run 'pnpm build' in libs/harbor/ or set DEEPAGENTS_JS_RUNNER."
    )


def _get_node_command(runner_path: str) -> list[str]:
    """Build the shell command to execute the runner."""
    if runner_path.endswith(".ts"):
        tsx_path = shutil.which("tsx")
        if tsx_path:
            return [tsx_path, runner_path]
        npx_path = shutil.which("npx")
        if npx_path:
            return [npx_path, "tsx", runner_path]
        raise FileNotFoundError(
            "Found TypeScript runner but tsx is not installed. "
            "Install it with: npm install -g tsx"
        )

    node_path = shutil.which("node")
    if not node_path:
        raise FileNotFoundError("node is not installed or not in PATH")
    return [node_path, runner_path]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _filter_tty_noise(stdout: str, stderr: str) -> str:
    """Strip harmless TTY messages and merge stdout/stderr into one string."""
    bash_messages: list[str] = []
    for noise in _TTY_NOISE:
        if noise in stdout:
            bash_messages.append(noise)
            stdout = stdout.replace(noise, "")
        if noise in stderr:
            stderr = stderr.replace(noise, "")

    stdout = stdout.strip()
    stderr = stderr.strip()

    if bash_messages:
        bash_text = "\n".join(bash_messages)
        stderr = f"{bash_text}\n{stderr}".strip() if stderr else bash_text

    if stderr:
        return f"{stdout}\n\nstderr: {stderr}" if stdout else f"\nstderr: {stderr}"
    return stdout


# ---------------------------------------------------------------------------
# Agent wrapper
# ---------------------------------------------------------------------------


class DeepAgentsJSWrapper(BaseAgent):
    """Harbor agent that delegates to deepagents-js via a Node.js subprocess."""

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        *args,
        **kwargs,
    ) -> None:
        super().__init__(logs_dir, model_name, *args, **kwargs)
        self._model_name = model_name or "anthropic:claude-sonnet-4-5-20250929"

        # Build instruction -> LangSmith example_id mapping (if experiment is set)
        self._instruction_to_example_id: dict[str, str] = {}
        experiment = os.environ.get("LANGSMITH_EXPERIMENT", "").strip() or None
        if experiment:
            try:
                client = Client()
                project = client.read_project(project_name=experiment)
                for example in client.list_examples(dataset_id=project.reference_dataset_id):
                    instruction = example.inputs.get("instruction") if example.inputs else None
                    if instruction:
                        self._instruction_to_example_id[instruction] = str(example.id)
            except Exception as e:
                print(f"Warning: Failed to build instruction->example_id mapping: {e}")

    @staticmethod
    def name() -> str:
        return "deepagent-js-harbor"

    def version(self) -> str | None:
        return "0.0.1"

    async def setup(self, environment: BaseEnvironment) -> None:
        pass

    # ------------------------------------------------------------------
    # System prompt
    # ------------------------------------------------------------------

    async def _format_system_prompt(self, environment: BaseEnvironment) -> str:
        """Build the system prompt with working directory and file listing context.

        Calls environment.exec() directly instead of going through a
        separate HarborSandbox backend.
        """
        pwd_result = await environment.exec("pwd")
        current_dir = (pwd_result.stdout or "/app").strip()

        ls_result = await environment.exec(
            "ls -1 2>/dev/null | head -50"
        )
        files = [f for f in (ls_result.stdout or "").strip().split("\n") if f]
        total_files = len(files)
        first_10 = files[:10]

        if total_files == 0:
            header = "Current directory is empty."
            listing = ""
        elif total_files <= 10:
            count_text = "1 file" if total_files == 1 else f"{total_files} files"
            header = f"Files in current directory ({count_text}):"
            listing = "\n".join(f"{i + 1}. {f}" for i, f in enumerate(first_10))
        else:
            header = f"Files in current directory (showing first 10 of {total_files}):"
            listing = "\n".join(f"{i + 1}. {f}" for i, f in enumerate(first_10))

        return SYSTEM_MESSAGE.format(
            current_directory=current_dir,
            file_listing_header=header,
            file_listing=listing,
        )

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        configuration = json.loads(environment.trial_paths.config_path.read_text())
        if not isinstance(configuration, dict):
            raise AssertionError(
                f"Unexpected configuration format. Expected a dict got {type(configuration)}."
            )

        system_prompt = await self._format_system_prompt(environment)

        runner_path = _find_js_runner()
        node_cmd = _get_node_command(runner_path)
        print(f"[DeepAgentsJS] Spawning: {' '.join(node_cmd)}")

        # 10 MB stream buffer (default 64 KB is too small for the "done" message
        # which contains the full serialized message history).
        process = await asyncio.create_subprocess_exec(
            *node_cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=os.environ.copy(),
            limit=100 * 1024 * 1024,
        )

        try:
            experiment_name = os.environ.get("LANGSMITH_EXPERIMENT", "").strip() or None

            if experiment_name:
                metadata = {
                    "task_instruction": instruction,
                    "model": self._model_name,
                    "harbor_session_id": environment.session_id,
                    "agent_mode": "js",
                    **configuration,
                }
                example_id = self._instruction_to_example_id.get(instruction)

                with trace(
                    name=environment.session_id,
                    reference_example_id=example_id,
                    inputs={"instruction": instruction},
                    project_name=experiment_name,
                    metadata=metadata,
                ) as run_tree:
                    # Propagate LangSmith trace context to the Node.js subprocess
                    # so its LLM calls and tool invocations nest under this trace.
                    # See: https://docs.langchain.com/langsmith/distributed-tracing
                    rt = get_current_run_tree()
                    langsmith_headers = rt.to_headers() if rt else {}

                    await self._send(process, {
                        "type": "init",
                        "instruction": instruction,
                        "sessionId": environment.session_id,
                        "model": self._model_name,
                        "systemPrompt": system_prompt,
                        "langsmithHeaders": langsmith_headers,
                    })

                    result_messages = await self._bridge_loop(process, environment)
                    last_ai = next(
                        (m for m in reversed(result_messages) if m.get("role") == "ai"),
                        None,
                    )
                    if last_ai:
                        run_tree.end(outputs={"last_message": last_ai.get("content", "")})
            else:
                await self._send(process, {
                    "type": "init",
                    "instruction": instruction,
                    "sessionId": environment.session_id,
                    "model": self._model_name,
                    "systemPrompt": system_prompt,
                })
                result_messages = await self._bridge_loop(process, environment)

            self._save_trajectory(environment, instruction, result_messages)

        finally:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    process.kill()

            if process.stderr:
                stderr_data = await process.stderr.read()
                if stderr_data:
                    for line in stderr_data.decode("utf-8", errors="replace").strip().split("\n"):
                        if line.strip():
                            print(f"[DeepAgentsJS] {line}")

    # ------------------------------------------------------------------
    # JSON-RPC bridge
    # ------------------------------------------------------------------

    @staticmethod
    async def _send(process: asyncio.subprocess.Process, msg: dict) -> None:
        assert process.stdin is not None
        process.stdin.write((json.dumps(msg) + "\n").encode("utf-8"))
        await process.stdin.drain()

    async def _bridge_loop(
        self,
        process: asyncio.subprocess.Process,
        environment: BaseEnvironment,
    ) -> list[dict]:
        """Proxy exec requests from Node to Harbor and return final messages."""
        assert process.stdout is not None

        while True:
            line = await process.stdout.readline()
            if not line:
                returncode = await process.wait()
                raise RuntimeError(
                    f"Node process exited unexpectedly with code {returncode}"
                )

            line_str = line.decode("utf-8").strip()
            if not line_str:
                continue

            try:
                msg = json.loads(line_str)
            except json.JSONDecodeError:
                print(f"[DeepAgentsJS] Warning: unparseable line: {line_str[:200]}")
                continue

            msg_type = msg.get("type")

            if msg_type == "exec_request":
                result = await environment.exec(msg["command"])
                output = _filter_tty_noise(result.stdout or "", result.stderr or "")
                await self._send(process, {
                    "type": "exec_response",
                    "id": msg["id"],
                    "output": output,
                    "exitCode": result.return_code,
                })

            elif msg_type == "done":
                return msg.get("messages", [])

            elif msg_type == "error":
                raise RuntimeError(
                    f"JS agent error: {msg.get('message', 'Unknown')}\n"
                    f"{msg.get('stack', '')}"
                )
            else:
                print(f"[DeepAgentsJS] Warning: unknown message type: {msg_type}")

    # ------------------------------------------------------------------
    # Trajectory
    # ------------------------------------------------------------------

    def _save_trajectory(
        self,
        environment: BaseEnvironment,
        instruction: str,
        messages: list[dict],
    ) -> None:
        """Convert serialized JS messages to ATIF trajectory format."""
        total_prompt_tokens = 0
        total_completion_tokens = 0

        steps: list[Step] = [
            Step(
                step_id=1,
                timestamp=datetime.now(timezone.utc).isoformat(),
                source="user",
                message=instruction,
            ),
        ]
        observations: list[ObservationResult] = []
        pending_step: Step | None = None

        for msg in messages:
            role = msg.get("role", "")

            if role == "ai":
                usage = msg.get("usage")
                if usage:
                    total_prompt_tokens += usage.get("input_tokens", 0)
                    total_completion_tokens += usage.get("output_tokens", 0)

                # Flush pending step
                if pending_step is not None:
                    if pending_step.tool_calls and observations:
                        pending_step.observation = Observation(results=observations)
                        observations = []
                    steps.append(pending_step)
                    pending_step = None

                tool_calls = [
                    ToolCall(
                        tool_call_id=tc.get("id", ""),
                        function_name=tc.get("name", ""),
                        arguments=tc.get("args", {}),
                    )
                    for tc in msg.get("toolCalls", [])
                ]

                new_step = Step(
                    step_id=steps[-1].step_id + 1 if steps else 0,
                    timestamp=datetime.now(timezone.utc).isoformat(),
                    source="agent",
                    message=msg.get("content", ""),
                    tool_calls=tool_calls or None,
                )

                if tool_calls:
                    pending_step = new_step
                else:
                    steps.append(new_step)

            elif role == "tool":
                observations.append(
                    ObservationResult(
                        source_call_id=msg.get("toolCallId", ""),
                        content=msg.get("content", ""),
                    )
                )
            # Skip human/system messages

        # Flush final pending step
        if pending_step is not None:
            if pending_step.tool_calls and observations:
                pending_step.observation = Observation(results=observations)
            steps.append(pending_step)

        trajectory = Trajectory(
            schema_version="ATIF-v1.2",
            session_id=environment.session_id,
            agent=Agent(
                name=self.name(),
                version=self.version() or "unknown",
                model_name=self._model_name,
                extra={"framework": "deepagents-js", "runtime": "node"},
            ),
            steps=steps,
            final_metrics=FinalMetrics(
                total_prompt_tokens=total_prompt_tokens or None,
                total_completion_tokens=total_completion_tokens or None,
                total_steps=len(steps),
            ),
        )
        trajectory_path = self.logs_dir / "trajectory.json"
        trajectory_path.write_text(json.dumps(trajectory.to_json_dict(), indent=2))
