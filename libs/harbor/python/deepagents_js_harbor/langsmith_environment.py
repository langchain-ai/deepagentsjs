"""Custom Harbor environment backed by a LangSmith hosted sandbox.

Uses the ``langsmith.sandbox`` async client to create and manage
sandboxes on sandbox.langchain.com.  Plug it into Harbor via the
``--environment-import-path`` flag or the ``environment.import_path``
config key::

    harbor trials run \
      --environment-import-path \
          "deepagents_js_harbor.langsmith_environment:LangSmithEnvironment" \
      --environment-kwargs template_name=my-template ...
"""

from __future__ import annotations

import os
from pathlib import Path

from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.environment_type import EnvironmentType
from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.paths import EnvironmentPaths, TrialPaths
from langsmith.sandbox import AsyncSandbox, AsyncSandboxClient, ResourceNotFoundError


class LangSmithEnvironment(BaseEnvironment):
    """Harbor environment that delegates to a LangSmith hosted sandbox.

    Image resolution order (first non-None wins):

    1. ``task_env_config.docker_image`` -- pre-built image specified in the
       task's ``task.toml``.  This is the standard way Terminal-Bench tasks
       ship their environment (gcc, weights, test harness, etc.).
    2. ``template_image`` kwarg -- explicit override via ``--environment-kwargs``
       or ``environment.kwargs`` in YAML config.
    3. Fallback default: ``python:3.12-slim``.

    Constructor kwargs (passed via ``--environment-kwargs`` or
    ``environment.kwargs`` in YAML config):

    * ``template_name``  -- name of the LangSmith sandbox template to use.
      When omitted, a per-task name is derived from the environment name.
    * ``template_image`` -- container image override (only used when the task
      does not specify ``docker_image``).
    """

    _DEFAULT_TEMPLATE_IMAGE = "python:3.12-slim"
    _DEFAULT_EXEC_TIMEOUT = 300  # seconds

    def __init__(
        self,
        environment_dir: Path,
        environment_name: str,
        session_id: str,
        trial_paths: TrialPaths,
        task_env_config: EnvironmentConfig,
        *args,
        template_name: str | None = None,
        template_image: str | None = None,
        **kwargs,
    ):
        # Resolve the container image: task config > kwarg > default
        self._template_image = (
            task_env_config.docker_image
            or template_image
            or self._DEFAULT_TEMPLATE_IMAGE
        )

        # Store resource limits from the task config so they can be forwarded
        # to the LangSmith sandbox template.
        self._resource_cpu = str(task_env_config.cpus)
        self._resource_memory_mb = task_env_config.memory_mb
        self._resource_storage_mb = task_env_config.storage_mb

        # Derive a template name that is unique per image so different tasks
        # don't collide.  Sanitise for LangSmith naming rules (lowercase,
        # alphanumeric + hyphens, max 63 chars).
        if template_name:
            self._template_name = template_name
        else:
            safe_name = (
                self._template_image
                .replace("/", "-")
                .replace(":", "-")
                .replace(".", "-")
                .lower()
            )
            self._template_name = f"harbor-{safe_name}"[:63]

        # These are initialised in start()
        self._client: AsyncSandboxClient | None = None
        self._sandbox: AsyncSandbox | None = None

        super().__init__(
            environment_dir=environment_dir,
            environment_name=environment_name,
            session_id=session_id,
            trial_paths=trial_paths,
            task_env_config=task_env_config,
            **kwargs,
        )

    # ------------------------------------------------------------------
    # BaseEnvironment metadata
    # ------------------------------------------------------------------

    @staticmethod
    def type() -> EnvironmentType:
        # No LANGSMITH member in the enum.  Return DOCKER as a harmless
        # placeholder -- the import-path code path never checks this value
        # against the factory map.
        return EnvironmentType.DOCKER

    @property
    def is_mounted(self) -> bool:
        return False

    @property
    def supports_gpus(self) -> bool:
        return False

    @property
    def can_disable_internet(self) -> bool:
        return False

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    def _validate_definition(self):
        """No local Dockerfile needed for a remote LangSmith sandbox."""
        api_key = os.environ.get("LANGSMITH_API_KEY", "")
        if not api_key:
            raise RuntimeError(
                "LANGSMITH_API_KEY environment variable is not set.  "
                "It is required for the LangSmith sandbox environment."
            )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def _require_sandbox(self) -> AsyncSandbox:
        if self._sandbox is None:
            raise RuntimeError(
                "LangSmith sandbox not initialised. Call start() first."
            )
        return self._sandbox

    async def start(self, force_build: bool) -> None:
        self.logger.info(
            f"LangSmith environment: image={self._template_image}, "
            f"template={self._template_name}, "
            f"memory={self._resource_memory_mb}Mi, "
            f"cpu={self._resource_cpu}"
        )

        self._client = AsyncSandboxClient()

        # Ensure the template exists (create if missing or forced).
        # When reusing an existing template, verify its resource limits
        # still match what the task config requests.  If they differ
        # (e.g. a previous run used a lower memory limit), recreate it.
        if force_build:
            await self._ensure_template()
        else:
            try:
                existing = await self._client.get_template(self._template_name)
                needs_recreate = (
                    existing.resources.memory != f"{self._resource_memory_mb}Mi"
                    or existing.resources.cpu != self._resource_cpu
                )
                if needs_recreate:
                    self.logger.info(
                        f"Template '{self._template_name}' exists but resource "
                        f"limits differ (have cpu={existing.resources.cpu}, "
                        f"memory={existing.resources.memory}; want "
                        f"cpu={self._resource_cpu}, "
                        f"memory={self._resource_memory_mb}Mi). Recreating."
                    )
                    await self._ensure_template()
            except ResourceNotFoundError:
                await self._ensure_template()

        self._sandbox = await self._client.create_sandbox(
            template_name=self._template_name,
        )

        if not self._sandbox:
            raise RuntimeError(
                "LangSmith sandbox was not created. This should never happen."
            )

        self.logger.info(
            f"LangSmith sandbox started: {self._sandbox.name} "
            f"(template={self._template_name}, image={self._template_image})"
        )

        # Create standard Harbor directories inside the sandbox
        await self._sandbox.run(
            f"mkdir -p {EnvironmentPaths.agent_dir} {EnvironmentPaths.verifier_dir}"
        )

    async def _ensure_template(self) -> None:
        """Create (or recreate) the LangSmith sandbox template."""
        assert self._client is not None

        # Delete existing template if force-rebuilding
        try:
            await self._client.delete_template(self._template_name)
        except ResourceNotFoundError:
            pass

        # Convert Harbor's memory_mb / storage_mb to Kubernetes-style strings
        # that the LangSmith API expects (e.g. "2048Mi", "10Gi").
        memory_str = f"{self._resource_memory_mb}Mi"
        storage_str = f"{self._resource_storage_mb}Mi"

        await self._client.create_template(
            name=self._template_name,
            image=self._template_image,
            cpu=self._resource_cpu,
            memory=memory_str,
            storage=storage_str,
        )
        self.logger.info(
            f"Created LangSmith template '{self._template_name}' "
            f"with image '{self._template_image}' "
            f"(cpu={self._resource_cpu}, memory={memory_str}, storage={storage_str})"
        )

    async def stop(self, delete: bool) -> None:
        if not delete:
            self.logger.info(
                "LangSmith sandboxes are ephemeral and will be deleted "
                "after use, regardless of delete=False."
            )

        if self._sandbox:
            try:
                assert self._client is not None
                await self._client.delete_sandbox(self._sandbox.name)
                self.logger.info(
                    f"Deleted LangSmith sandbox: {self._sandbox.name}"
                )
            except Exception as e:
                self.logger.error(f"Error deleting LangSmith sandbox: {e}")
            finally:
                self._sandbox = None

        if self._client:
            try:
                await self._client.aclose()
            except Exception:
                pass
            finally:
                self._client = None

    # ------------------------------------------------------------------
    # Command execution
    # ------------------------------------------------------------------

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
    ) -> ExecResult:
        sandbox = self._require_sandbox()
        timeout = timeout_sec or self._DEFAULT_EXEC_TIMEOUT

        result = await sandbox.run(
            command,
            timeout=timeout,
            env=env,
            cwd=cwd,
        )

        return ExecResult(
            stdout=result.stdout,
            stderr=result.stderr,
            return_code=result.exit_code,
        )

    # ------------------------------------------------------------------
    # File upload
    # ------------------------------------------------------------------

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        sandbox = self._require_sandbox()
        content = Path(source_path).read_bytes()
        await sandbox.write(target_path, content)

    async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
        sandbox = self._require_sandbox()
        for file_path in Path(source_dir).rglob("*"):
            if file_path.is_file():
                relative = file_path.relative_to(Path(source_dir))
                remote_path = f"{target_dir}/{relative}"
                await sandbox.write(remote_path, file_path.read_bytes())

    # ------------------------------------------------------------------
    # File download
    # ------------------------------------------------------------------

    async def download_file(self, source_path: str, target_path: Path | str) -> None:
        sandbox = self._require_sandbox()
        data = await sandbox.read(source_path)
        Path(target_path).parent.mkdir(parents=True, exist_ok=True)
        Path(target_path).write_bytes(data)

    async def download_dir(self, source_dir: str, target_dir: Path | str) -> None:
        """Download a directory by listing files with ``find`` then reading each one."""
        sandbox = self._require_sandbox()

        # List all regular files under source_dir
        result = await sandbox.run(
            f"find {source_dir} -type f",
            timeout=30,
        )

        if result.exit_code != 0 or not result.stdout.strip():
            return

        for remote_file in result.stdout.strip().split("\n"):
            remote_file = remote_file.strip()
            if not remote_file:
                continue

            # Compute local target path preserving directory structure
            relative = Path(remote_file).relative_to(Path(source_dir))
            local_path = Path(target_dir) / relative
            local_path.parent.mkdir(parents=True, exist_ok=True)

            data = await sandbox.read(remote_file)
            local_path.write_bytes(data)
