/**
 * ContextHubBackend: Store files in a LangSmith Hub agent repo (persistent).
 */

import micromatch from "micromatch";
import { Client } from "langsmith";
import type { AgentContext, Entry } from "langsmith/schemas";
import { Deferred } from "../utils.js";
import type {
  BackendProtocolV2,
  DeleteResult,
  EditResult,
  FileDownloadResponse,
  FileInfo,
  FileOperationError,
  FileUploadResponse,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from "./protocol.js";
import { applyGrepMaxCount } from "./protocol.js";
import { performStringReplacement } from "./utils.js";

const CONTEXT_URL_COMMIT_PATH_RE = /^\/context\/([^/]+)\/([0-9a-f]{8})$/;
const LEGACY_URL_COMMIT_PATH_RE = /^\/hub\/([^/]+)\/([^/:]+):([0-9a-f]{8})$/;
const MUTATION_COALESCE_MS = 50;
const MAX_CONFLICT_RETRIES = 3;
const TEXT_MIME_TYPE = "text/plain";
const FNMATCH_OPTIONS = { bash: true };

type FileChanges = Record<string, string | null>;

/**
 * The logical operation a caller requested. `changes` operations are absolute
 * file updates, while `edit` retains the replacement instruction so it can be
 * replayed against a freshly pulled tree after a parent-commit conflict.
 */
type MutationIntent =
  | { kind: "changes"; changes: FileChanges }
  | {
      kind: "edit";
      path: string;
      oldString: string;
      newString: string;
      replaceAll: boolean;
      updateOccurrences: (occurrences: number) => void;
    }
  | { kind: "delete"; base: string };

/**
 * A caller waiting for one logical mutation to become durable. Completion is
 * settled only after the batch push succeeds, or rejected if the worker can no
 * longer commit the caller's batch.
 */
interface MutationWaiter {
  intent: MutationIntent;
  completion: Deferred<void>;
}

/**
 * A coalesced group of mutations. `changes` is the current materialization of
 * the ordered waiter intents and is used both for the Hub payload and the
 * optimistic read overlay. A later conflict refresh may rebuild it.
 */
interface MutationBatch {
  changes: FileChanges;
  waiters: MutationWaiter[];
  ready: Deferred<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

interface MutationAcceptance<T> {
  result: T;
  completion?: Promise<void>;
}

/** The last authoritative Context Hub tree and its parent commit hash. */
interface TreeSnapshot {
  cache: Record<string, string>;
  linkedEntries: Record<string, string>;
  commitHash: string | null;
}

type PushBatchResult =
  | { kind: "commit"; commitHash: string }
  | { kind: "snapshot"; snapshot: TreeSnapshot };

function parseHubTargetIdentifier(
  identifier: string,
): [owner: string, name: string] | null {
  if (
    !identifier ||
    identifier.split("/").length > 2 ||
    identifier.startsWith("/") ||
    identifier.endsWith("/") ||
    identifier.split(":").length > 2
  ) {
    return null;
  }

  const [ownerNamePart] = identifier.split(":");
  if (ownerNamePart.includes("/")) {
    const [owner, name] = ownerNamePart.split("/", 2);
    return owner && name ? [owner, name] : null;
  }
  return ownerNamePart ? ["-", ownerNamePart] : null;
}

function parseCommitHashFromUrl(
  url: string,
  identifier: string,
): string | null {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const target = parseHubTargetIdentifier(identifier);
    if (target === null) {
      return null;
    }
    const [targetOwner, targetName] = target;

    const contextMatch = CONTEXT_URL_COMMIT_PATH_RE.exec(pathname);
    if (contextMatch !== null && contextMatch[1] === targetName) {
      return contextMatch[2];
    }

    const legacyMatch = LEGACY_URL_COMMIT_PATH_RE.exec(pathname);
    if (
      legacyMatch !== null &&
      legacyMatch[1] === targetOwner &&
      legacyMatch[2] === targetName
    ) {
      return legacyMatch[3];
    }
    return null;
  } catch {
    return null;
  }
}

function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
}

function getErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function splitLinesKeepEnds(content: string): string[] {
  const lines: string[] = [];
  let lineStart = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      lines.push(content.slice(lineStart, index + 1));
      lineStart = index + 1;
    }
  }

  if (lineStart < content.length) {
    lines.push(content.slice(lineStart));
  }

  return lines;
}

function sliceReadContent(
  content: string,
  offset: number,
  limit: number,
): { content?: string; error?: string } {
  if (!content || content.trim() === "") {
    return { content };
  }

  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = splitLinesKeepEnds(normalized);
  const startIndex = offset;
  const endIndex = Math.min(startIndex + limit, lines.length);

  if (startIndex >= lines.length) {
    return {
      error: `Line offset ${offset} exceeds file length (${lines.length} lines)`,
    };
  }

  return { content: lines.slice(startIndex, endIndex).join("") };
}

function isLangSmithNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const maybeError = error as { name?: unknown; status?: unknown };
  return (
    maybeError.name === "LangSmithNotFoundError" || maybeError.status === 404
  );
}

function isLangSmithError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const maybeError = error as { name?: unknown; status?: unknown };
  return (
    (typeof maybeError.name === "string" &&
      maybeError.name.startsWith("LangSmith")) ||
    typeof maybeError.status === "number"
  );
}

function getLangSmithStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const maybeError = error as { status?: unknown };
  if (typeof maybeError.status === "number") {
    return maybeError.status;
  }

  return undefined;
}

function createLangSmithConflictError(message: string): Error & {
  status: number;
} {
  const error = new Error(message) as Error & { status: number };
  error.name = "LangSmithConflictError";
  error.status = 409;
  return error;
}

function mapHubFileOperationError(error: unknown): FileOperationError {
  const status = getLangSmithStatus(error);
  if (status === 401 || status === 403) {
    return "permission_denied";
  }
  if (status === 404) {
    return "file_not_found";
  }
  return "invalid_path";
}

/**
 * Backend that stores files in a LangSmith Hub agent repo (persistent).
 */
/**
 * Backend that stores files in a LangSmith Hub agent repository.
 *
 * ## Mutation model
 *
 * Mutations are accepted in call order, coalesced for a short window, and
 * pushed by one worker. Only one batch is in flight at a time; mutations that
 * arrive during a push form the next batch. This serializes one backend
 * instance's writes while still reducing the number of Hub commits.
 *
 * Reads use an optimistic view: the last durable cache overlaid with the
 * in-flight batch and then the pending batch. A read can therefore observe an
 * accepted mutation before it is durable; a failed push invalidates that view
 * and the next operation reloads from Hub.
 *
 * A `409` parent conflict triggers an authoritative pull and rematerializes
 * the in-flight batch over the fetched tree before retrying. Edits replay their
 * original replacement intent; absolute writes, deletes, and uploads replay as
 * absolute changes. Retries are bounded by `MAX_CONFLICT_RETRIES`.
 */
export class ContextHubBackend implements BackendProtocolV2 {
  private identifier: string;
  private client: Client;
  /** Last durable Hub file state; `null` means the next access must load it. */
  private cache: Record<string, string> | null = null;
  private linkedEntries: Record<string, string> = {};
  /** Parent hash for the durable cache, used for optimistic-concurrency pushes. */
  private commitHash: string | null = null;
  /** Shared cold-load promise so concurrent first operations perform one pull. */
  private loadPromise: Promise<void> | null = null;
  /** Promise chain serializing mutation acceptance and optimistic projections. */
  private mutationOrder = Promise.resolve();
  /** Mutations accepted for the next coalesced push. */
  private pendingBatch: MutationBatch | null = null;
  /** The batch currently submitted to Hub and visible to optimistic reads. */
  private inFlightBatch: MutationBatch | null = null;
  /** The single queue-draining worker, when active. */
  private workerPromise: Promise<void> | null = null;
  /**
   * Blocks cache consumers while a successful push without a parseable commit
   * hash is being confirmed by an authoritative pull.
   */
  private snapshotPublication: Deferred<void> | null = null;

  constructor(
    identifier: string,
    options: {
      client?: Client;
    } = {},
  ) {
    this.identifier = identifier;
    this.client = options.client ?? new Client();
  }

  private static stripPrefix(path: string): string {
    return path.replace(/^\/+/, "");
  }

  private static toHubUnavailableError(error: unknown): string {
    return `Hub unavailable: ${getErrorMessage(error)}`;
  }

  private async fetchTree(): Promise<TreeSnapshot> {
    let context: AgentContext;
    try {
      context = await this.client.pullAgent(this.identifier);
    } catch (error) {
      if (isLangSmithNotFoundError(error)) {
        return { cache: {}, linkedEntries: {}, commitHash: null };
      }
      throw error;
    }

    const cache: Record<string, string> = {};
    const linkedEntries: Record<string, string> = {};

    for (const [path, entry] of Object.entries(context.files)) {
      if (entry.type === "file") {
        cache[path] = entry.content;
      } else if (
        (entry.type === "agent" || entry.type === "skill") &&
        typeof entry.repo_handle === "string"
      ) {
        linkedEntries[path] = entry.repo_handle;
      }
    }

    return { cache, linkedEntries, commitHash: context.commit_hash };
  }

  private publishSnapshot(snapshot: TreeSnapshot): void {
    this.cache = snapshot.cache;
    this.linkedEntries = snapshot.linkedEntries;
    this.commitHash = snapshot.commitHash;
  }

  private async loadTree(): Promise<void> {
    this.publishSnapshot(await this.fetchTree());
  }

  private beginSnapshotPublication(): void {
    if (this.snapshotPublication !== null) {
      throw new Error("Context Hub snapshot publication is already pending");
    }

    this.snapshotPublication = new Deferred<void>();
  }

  private finishSnapshotPublication(): void {
    const publication = this.snapshotPublication;
    this.snapshotPublication = null;
    publication?.resolve();
  }

  private async ensureCacheLoaded(): Promise<void> {
    // Publish a hashless-push snapshot only after its old in-flight overlay can be removed.
    while (this.snapshotPublication !== null) {
      await this.snapshotPublication;
    }

    if (this.cache === null) {
      let loadPromise = this.loadPromise;
      if (loadPromise === null) {
        loadPromise = this.loadTree();
        this.loadPromise = loadPromise;
      }

      try {
        await loadPromise;
      } finally {
        if (this.loadPromise === loadPromise) {
          this.loadPromise = null;
        }
      }
    }
    if (this.cache === null) {
      throw new Error("Context Hub cache failed to initialize");
    }
  }

  private async ensureCache(): Promise<Record<string, string>> {
    await this.ensureCacheLoaded();
    return this.visibleCache();
  }

  private static applyChanges(
    cache: Record<string, string>,
    changes: FileChanges,
  ): Record<string, string> {
    const next = { ...cache };
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) {
        delete next[path];
      } else {
        next[path] = content;
      }
    }
    return next;
  }

  /**
   * Select the exact key at `base` plus every key nested under `base + "/"`
   * and map each to `null` (a deletion marker). Returns an empty object when
   * nothing is stored at or under `base`. Recomputing this against the current
   * cache is what makes a recursive delete correct under conflict replay.
   */
  private static collectDeleteChanges(
    cache: Record<string, string>,
    base: string,
  ): FileChanges {
    const prefix = base === "" ? "" : `${base}/`;
    const changes: FileChanges = {};
    for (const key of Object.keys(cache)) {
      if (base === "" || key === base || key.startsWith(prefix)) {
        changes[key] = null;
      }
    }
    return changes;
  }

  /**
   * Build the read-your-writes view without publishing speculative data as the
   * durable cache. Later batches overlay earlier ones, matching worker order.
   */
  private visibleCache(): Record<string, string> {
    let visible = { ...(this.cache ?? {}) };
    if (this.inFlightBatch !== null) {
      visible = ContextHubBackend.applyChanges(
        visible,
        this.inFlightBatch.changes,
      );
    }
    if (this.pendingBatch !== null) {
      visible = ContextHubBackend.applyChanges(
        visible,
        this.pendingBatch.changes,
      );
    }
    return visible;
  }

  private invalidateCache(): void {
    this.cache = null;
    this.linkedEntries = {};
    this.commitHash = null;
    this.loadPromise = null;
  }

  private async acquireMutationTurn(): Promise<() => void> {
    let release!: () => void;
    const previous = this.mutationOrder;
    this.mutationOrder = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  /**
   * Serialize validation and enqueueing so each operation is evaluated against
   * a stable optimistic projection. Cache loading begins before acquiring the
   * turn, allowing concurrent cold-start callers to share the same pull.
   */
  private async acceptMutation<T>(
    operation: (cache: Record<string, string>) => MutationAcceptance<T>,
  ): Promise<MutationAcceptance<T>> {
    const turn = this.acquireMutationTurn();
    const cacheOutcome = this.ensureCacheLoaded().then(
      () => ({ loaded: true }) as const,
      (error: unknown) => ({ loaded: false, error }) as const,
    );
    const release = await turn;
    try {
      const outcome = await cacheOutcome;
      if (!outcome.loaded) {
        throw outcome.error;
      }
      while (this.cache === null) {
        await this.ensureCacheLoaded();
      }
      return operation(this.visibleCache());
    } finally {
      release();
    }
  }

  /**
   * Start a batch's coalescing window. The worker waits for this signal before
   * detaching the batch; cancellation resolves it immediately so failures do
   * not leave the worker waiting on a timer.
   */
  private createMutationBatch(): MutationBatch {
    const batch: MutationBatch = {
      changes: {},
      waiters: [],
      ready: new Deferred<void>(),
      timer: null,
    };
    batch.timer = setTimeout(() => {
      batch.timer = null;
      batch.ready.resolve();
    }, MUTATION_COALESCE_MS);
    return batch;
  }

  private cancelBatchTimer(batch: MutationBatch): void {
    if (batch.timer !== null) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }
    batch.ready.resolve();
  }

  private enqueueCommit(
    changes: FileChanges,
    intent: MutationIntent = { kind: "changes", changes: { ...changes } },
  ): Promise<void> {
    if (Object.keys(changes).length === 0) {
      return Promise.resolve();
    }

    let batch = this.pendingBatch;
    if (batch === null) {
      batch = this.createMutationBatch();
      this.pendingBatch = batch;
    }
    Object.assign(batch.changes, changes);

    const completion = new Deferred<void>();
    batch.waiters.push({ intent, completion });
    this.startWorker();
    return completion.promise;
  }

  /**
   * Replay ordered intents over an authoritative base after a conflict. This
   * rebuilds the push payload and optimistic overlay. An edit that no longer
   * applies throws the supplied conflict error; absolute changes are reapplied.
   */
  private rematerializeBatch(
    batch: MutationBatch,
    base: Record<string, string>,
    conflictError: unknown,
  ): Record<string, string> {
    let cache = { ...base };
    const changes: FileChanges = {};

    for (const waiter of batch.waiters) {
      const { intent } = waiter;
      if (intent.kind === "changes") {
        Object.assign(changes, intent.changes);
        cache = ContextHubBackend.applyChanges(cache, intent.changes);
        continue;
      }

      if (intent.kind === "delete") {
        // Recompute the recursive delete against the refreshed cache so
        // descendants added concurrently before replay are also removed.
        const deleteChanges = ContextHubBackend.collectDeleteChanges(
          cache,
          intent.base,
        );
        Object.assign(changes, deleteChanges);
        cache = ContextHubBackend.applyChanges(cache, deleteChanges);
        continue;
      }

      const current = cache[intent.path];
      if (current === undefined) {
        throw conflictError;
      }
      const replacementResult = performStringReplacement(
        current,
        intent.oldString,
        intent.newString,
        intent.replaceAll,
      );
      if (typeof replacementResult === "string") {
        throw conflictError;
      }

      const [newContent, occurrences] = replacementResult;
      const editChanges = { [intent.path]: newContent };
      Object.assign(changes, editChanges);
      cache = ContextHubBackend.applyChanges(cache, editChanges);
      intent.updateOccurrences(occurrences);
    }

    batch.changes = changes;
    return cache;
  }

  private rematerializeAfterConflict(
    batch: MutationBatch,
    snapshot: TreeSnapshot,
    conflictError: unknown,
  ): void {
    const cache = this.rematerializeBatch(batch, snapshot.cache, conflictError);
    let pendingReplayError: unknown = null;
    if (this.pendingBatch !== null) {
      try {
        this.rematerializeBatch(this.pendingBatch, cache, conflictError);
      } catch (error) {
        if (error !== conflictError) {
          throw error;
        }
        pendingReplayError = error;
      }
    }
    this.publishSnapshot(snapshot);
    if (pendingReplayError !== null) {
      // A queued replay failure must not abort the valid in-flight retry.
      this.failPendingBatch(pendingReplayError);
    }
  }

  private rematerializePendingBatch(snapshot: TreeSnapshot): Error | null {
    if (this.pendingBatch === null) {
      return null;
    }
    const conflictError = createLangSmithConflictError(
      "Pending Context Hub mutation conflicts with authoritative state",
    );
    try {
      this.rematerializeBatch(this.pendingBatch, snapshot.cache, conflictError);
      return null;
    } catch (error) {
      if (error !== conflictError) {
        throw error;
      }
      return conflictError;
    }
  }

  private startWorker(): void {
    if (this.workerPromise !== null) {
      return;
    }

    const worker = this.drainMutationQueue()
      .catch((error: unknown) => {
        this.failAllBatches(error);
      })
      .finally(() => {
        if (this.workerPromise === worker) {
          this.workerPromise = null;
          if (this.pendingBatch !== null) {
            this.startWorker();
          }
        }
      });
    this.workerPromise = worker;
  }

  /**
   * Drain coalesced batches sequentially. A completed batch publishes durable
   * state before settling its callers; a failed batch invalidates local state
   * and rejects both in-flight and queued callers so the next mutation reloads.
   */
  private async drainMutationQueue(): Promise<void> {
    while (this.pendingBatch !== null) {
      const batch = this.pendingBatch;
      await batch.ready;
      if (this.pendingBatch !== batch) {
        continue;
      }

      this.pendingBatch = null;
      this.inFlightBatch = batch;
      let pendingReplayError: Error | null = null;
      try {
        const result = await this.pushBatch(batch);
        if (result.kind === "snapshot") {
          pendingReplayError = this.rematerializePendingBatch(result.snapshot);
          this.publishSnapshot(result.snapshot);
        } else {
          this.cache = ContextHubBackend.applyChanges(
            this.cache ?? {},
            batch.changes,
          );
          this.commitHash = result.commitHash;
        }
      } catch (error) {
        this.inFlightBatch = null;
        this.invalidateCache();
        this.finishSnapshotPublication();
        for (const waiter of batch.waiters) {
          waiter.completion.reject(error);
        }
        this.failPendingBatch(error);
        return;
      }

      this.inFlightBatch = null;
      this.finishSnapshotPublication();
      for (const waiter of batch.waiters) {
        waiter.completion.resolve();
      }
      if (pendingReplayError !== null) {
        this.failPendingBatch(pendingReplayError);
        return;
      }
    }
  }

  private failPendingBatch(error: unknown): void {
    const pending = this.pendingBatch;
    if (pending === null) {
      return;
    }
    this.pendingBatch = null;
    this.cancelBatchTimer(pending);
    for (const waiter of pending.waiters) {
      waiter.completion.reject(error);
    }
  }

  private failAllBatches(error: unknown): void {
    const inFlight = this.inFlightBatch;
    this.inFlightBatch = null;
    this.invalidateCache();
    this.finishSnapshotPublication();
    if (inFlight !== null) {
      this.cancelBatchTimer(inFlight);
      for (const waiter of inFlight.waiters) {
        waiter.completion.reject(error);
      }
    }
    this.failPendingBatch(error);
  }

  /**
   * Push a materialized batch with the durable commit as its parent. On a 409,
   * refresh Hub state, replay the batch, and retry with the new parent. A push
   * response without a trustworthy hash is confirmed by a pull before callers
   * are allowed to observe it as durable.
   */
  private async pushBatch(batch: MutationBatch): Promise<PushBatchResult> {
    for (let attempt = 0; ; attempt += 1) {
      const payload: Record<string, Entry | null> = {};
      for (const [path, content] of Object.entries(batch.changes)) {
        payload[path] = content === null ? null : { type: "file", content };
      }

      let url: string;
      try {
        url = await this.client.pushAgent(this.identifier, {
          files: payload,
          ...(this.commitHash ? { parentCommit: this.commitHash } : {}),
        });
      } catch (error) {
        if (
          getLangSmithStatus(error) !== 409 ||
          attempt >= MAX_CONFLICT_RETRIES
        ) {
          throw error;
        }
        const snapshot = await this.fetchTree();
        this.rematerializeAfterConflict(batch, snapshot, error);
        continue;
      }

      const pushedCommitHash = parseCommitHashFromUrl(url, this.identifier);
      if (pushedCommitHash === null) {
        this.beginSnapshotPublication();
        const snapshot = await this.fetchTree();
        if (snapshot.commitHash === null) {
          throw new Error(
            "Context Hub commit succeeded but its hash could not be resolved",
          );
        }
        return {
          kind: "snapshot",
          snapshot,
        };
      }
      return { kind: "commit", commitHash: pushedCommitHash };
    }
  }

  /**
   * Return linked-entry paths mapped to their repo handles.
   */
  async getLinkedEntries(): Promise<Record<string, string>> {
    await this.ensureCache();
    return { ...this.linkedEntries };
  }

  /**
   * Return true if the hub repo already exists with at least one commit.
   */
  async hasPriorCommits(): Promise<boolean> {
    await this.ensureCache();
    return this.commitHash !== null;
  }

  async ls(path: string = "/"): Promise<LsResult> {
    const hubPrefix = ContextHubBackend.stripPrefix(path).replace(/\/+$/, "");

    let cache: Record<string, string>;
    try {
      cache = await this.ensureCache();
    } catch (error) {
      if (isLangSmithError(error)) {
        return { error: ContextHubBackend.toHubUnavailableError(error) };
      }
      throw error;
    }

    const dirs = new Set<string>();
    const entries: FileInfo[] = [];

    for (const filePath of Object.keys(cache)) {
      if (hubPrefix && !filePath.startsWith(`${hubPrefix}/`)) {
        continue;
      }

      const relative = hubPrefix
        ? filePath.slice(hubPrefix.length + 1)
        : filePath;
      if (!relative) {
        continue;
      }

      const slashIndex = relative.indexOf("/");
      if (slashIndex === -1) {
        entries.push({ path: `/${filePath}`, is_dir: false });
        continue;
      }

      const dirName = relative.slice(0, slashIndex);
      const dirPath = hubPrefix ? `${hubPrefix}/${dirName}` : dirName;
      if (!dirs.has(dirPath)) {
        dirs.add(dirPath);
        entries.push({ path: `/${dirPath}`, is_dir: true });
      }
    }

    return { files: entries };
  }

  async read(
    filePath: string,
    offset: number = 0,
    limit: number = 2000,
  ): Promise<ReadResult> {
    const hubPath = ContextHubBackend.stripPrefix(filePath);

    let cache: Record<string, string>;
    try {
      cache = await this.ensureCache();
    } catch (error) {
      if (isLangSmithError(error)) {
        return { error: ContextHubBackend.toHubUnavailableError(error) };
      }
      throw error;
    }

    const content = cache[hubPath];
    if (content === undefined) {
      return { error: `File '${filePath}' not found` };
    }

    const sliced = sliceReadContent(content, offset, limit);
    if (sliced.error) {
      return { error: sliced.error };
    }

    return { content: sliced.content ?? "", mimeType: TEXT_MIME_TYPE };
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    const readResult = await this.read(filePath, 0, Number.MAX_SAFE_INTEGER);
    if (readResult.error || typeof readResult.content !== "string") {
      return { error: readResult.error ?? `File '${filePath}' not found` };
    }

    const now = new Date().toISOString();
    return {
      data: {
        content: readResult.content,
        mimeType: TEXT_MIME_TYPE,
        created_at: now,
        modified_at: now,
      },
    };
  }

  async grep(
    pattern: string,
    path: string | null = null,
    glob: string | null = null,
    maxCount: number | null = null,
  ): Promise<GrepResult> {
    let cache: Record<string, string>;
    try {
      cache = await this.ensureCache();
    } catch (error) {
      if (isLangSmithError(error)) {
        return { error: ContextHubBackend.toHubUnavailableError(error) };
      }
      throw error;
    }

    const prefix = path
      ? ContextHubBackend.stripPrefix(path).replace(/\/+$/, "")
      : "";

    const matches: GrepMatch[] = [];
    for (const [filePath, content] of Object.entries(cache)) {
      if (prefix && !filePath.startsWith(prefix)) {
        continue;
      }
      if (glob && !micromatch.isMatch(filePath, glob, FNMATCH_OPTIONS)) {
        continue;
      }

      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.includes(pattern)) {
          matches.push({ path: `/${filePath}`, line: index + 1, text: line });
        }
      }
    }

    return applyGrepMaxCount({ result: { matches }, maxCount });
  }

  async glob(pattern: string, _path: string = "/"): Promise<GlobResult> {
    let cache: Record<string, string>;
    try {
      cache = await this.ensureCache();
    } catch (error) {
      if (isLangSmithError(error)) {
        return { error: ContextHubBackend.toHubUnavailableError(error) };
      }
      throw error;
    }

    const files: FileInfo[] = [];
    for (const filePath of Object.keys(cache)) {
      if (
        micromatch.isMatch(`/${filePath}`, pattern, FNMATCH_OPTIONS) ||
        micromatch.isMatch(filePath, pattern, FNMATCH_OPTIONS)
      ) {
        files.push({ path: `/${filePath}`, is_dir: false });
      }
    }

    return { files };
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    const hubPath = ContextHubBackend.stripPrefix(filePath);

    try {
      const accepted = await this.acceptMutation<WriteResult>(() => {
        return {
          result: { path: filePath, filesUpdate: null },
          completion: this.enqueueCommit({ [hubPath]: content }),
        };
      });
      await accepted.completion;
      return accepted.result;
    } catch (error) {
      if (isLangSmithError(error)) {
        return { error: ContextHubBackend.toHubUnavailableError(error) };
      }
      throw error;
    }
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
  ): Promise<EditResult> {
    const hubPath = ContextHubBackend.stripPrefix(filePath);

    try {
      const accepted = await this.acceptMutation<EditResult>((cache) => {
        const current = cache[hubPath];
        if (current === undefined) {
          return {
            result: { error: `Error: File '${filePath}' not found` },
          };
        }

        const replacementResult = performStringReplacement(
          current,
          oldString,
          newString,
          replaceAll,
        );
        if (typeof replacementResult === "string") {
          return { result: { error: replacementResult } };
        }

        const [newContent, occurrences] = replacementResult;
        const result: EditResult = {
          path: filePath,
          filesUpdate: null,
          occurrences,
        };
        return {
          result,
          completion: this.enqueueCommit(
            { [hubPath]: newContent },
            {
              kind: "edit",
              path: hubPath,
              oldString,
              newString,
              replaceAll,
              updateOccurrences: (replayedOccurrences) => {
                result.occurrences = replayedOccurrences;
              },
            },
          ),
        };
      });
      await accepted.completion;
      return accepted.result;
    } catch (error) {
      if (isLangSmithError(error)) {
        return { error: ContextHubBackend.toHubUnavailableError(error) };
      }
      throw error;
    }
  }

  async delete(filePath: string): Promise<DeleteResult> {
    const hubPath = ContextHubBackend.stripPrefix(filePath);

    try {
      const accepted = await this.acceptMutation<DeleteResult>((cache) => {
        // Delete the exact key plus every entry nested under it, so a directory
        // (represented only by descendant keys) is removed recursively. A
        // dedicated delete intent lets conflict replay re-select descendants
        // discovered after the initial materialization.
        const base = trimTrailingSlashes(hubPath);
        const deleteChanges = ContextHubBackend.collectDeleteChanges(
          cache,
          base,
        );
        if (Object.keys(deleteChanges).length === 0) {
          return {
            result: { error: `Error: File '${filePath}' not found` },
          };
        }

        return {
          result: { path: filePath },
          completion: this.enqueueCommit(deleteChanges, {
            kind: "delete",
            base,
          }),
        };
      });
      await accepted.completion;
      return accepted.result;
    } catch (error) {
      if (isLangSmithError(error)) {
        return { error: ContextHubBackend.toHubUnavailableError(error) };
      }
      throw error;
    }
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const decoded: Array<[string, string | null]> = [];
    const validFiles: Record<string, string> = {};

    for (const [path, content] of files) {
      try {
        const text = decoder.decode(content);
        decoded.push([path, text]);
        validFiles[ContextHubBackend.stripPrefix(path)] = text;
      } catch {
        decoded.push([path, null]);
      }
    }

    let commitError: FileOperationError | null = null;
    if (Object.keys(validFiles).length > 0) {
      try {
        const accepted = await this.acceptMutation<null>(() => {
          return {
            result: null,
            completion: this.enqueueCommit(validFiles),
          };
        });
        await accepted.completion;
      } catch (error) {
        if (isLangSmithError(error)) {
          commitError = mapHubFileOperationError(error);
        } else {
          throw error;
        }
      }
    }

    return decoded.map(([path, text]) => {
      if (text === null) {
        return { path, error: "invalid_path" };
      }
      if (commitError !== null) {
        return { path, error: commitError };
      }
      return { path, error: null };
    });
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    let cache: Record<string, string>;
    try {
      cache = await this.ensureCache();
    } catch (error) {
      if (isLangSmithError(error)) {
        const mappedError = mapHubFileOperationError(error);
        return paths.map((path) => ({
          path,
          content: null,
          error: mappedError,
        }));
      }
      throw error;
    }

    const encoder = new TextEncoder();
    return paths.map((path) => {
      const hubPath = ContextHubBackend.stripPrefix(path);
      const content = cache[hubPath];
      if (content !== undefined) {
        return { path, content: encoder.encode(content), error: null };
      }
      return { path, content: null, error: "file_not_found" };
    });
  }
}
