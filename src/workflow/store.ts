import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname as systemHostname } from "node:os";
import { dirname, join } from "node:path";

import type {
  ArtifactImportedEvent,
  ProviderBinding,
  ProjectManifest,
  ReviewRecordedEvent,
  RevisionRequestedEvent,
  TaskCreatedEvent,
  TaskState,
  WorkflowEvent,
} from "../contracts/index.js";
import {
  PROVIDER_CAPABILITIES,
  STAGE_DIRECTORIES,
  WORKFLOW_STAGES,
} from "../contracts/stages.js";
import { WorkflowError, invariant } from "./errors.js";
import { reduceEvents } from "./reducer.js";
import { stableJson, stableJsonLine, versionLabel } from "./util.js";

export const TASK_FILES = {
  project: "project.json",
  events: "events.jsonl",
  state: "state.json",
  artifacts: "artifacts.jsonl",
  providerBindings: "provider-bindings.json",
  reviews: "reviews",
  final: "final",
  exports: "exports",
} as const;

export interface TransactionResult<Result> {
  events: readonly WorkflowEvent[];
  result: Result;
}

export interface EventStoreOptions {
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
  lockStaleMs?: number;
  clock?: () => number;
  processId?: number;
  hostname?: string;
  ownerGenerator?: () => string;
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface LockRecord {
  schemaVersion: 1;
  owner: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

interface LockObservation {
  raw: string;
  record?: LockRecord;
  legacyPid?: number;
  modifiedAtMs: number;
  size: number;
  device: number;
  inode: number;
}

export class FileEventStore {
  readonly taskDirectory: string;
  readonly eventsPath: string;
  readonly statePath: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockPollIntervalMs: number;
  private readonly lockStaleMs: number;
  private readonly clock: () => number;
  private readonly processId: number;
  private readonly hostname: string;
  private readonly ownerGenerator: () => string;
  private readonly isProcessAlive: (pid: number) => boolean | Promise<boolean>;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(taskDirectory: string, options: EventStoreOptions = {}) {
    this.taskDirectory = taskDirectory;
    this.eventsPath = join(taskDirectory, TASK_FILES.events);
    this.statePath = join(taskDirectory, TASK_FILES.state);
    this.lockPath = join(taskDirectory, ".workflow.lock");
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.lockPollIntervalMs = options.lockPollIntervalMs ?? 20;
    this.lockStaleMs = options.lockStaleMs ?? Math.max(30_000, this.lockTimeoutMs);
    this.clock = options.clock ?? Date.now;
    this.processId = options.processId ?? process.pid;
    this.hostname = options.hostname ?? systemHostname();
    this.ownerGenerator = options.ownerGenerator ?? randomUUID;
    this.isProcessAlive = options.isProcessAlive ?? systemProcessAlive;
    this.sleep = options.sleep ?? wait;

    if (!Number.isFinite(this.lockTimeoutMs) || this.lockTimeoutMs < 0) {
      throw new RangeError("lockTimeoutMs must be a non-negative finite number.");
    }
    if (!Number.isFinite(this.lockPollIntervalMs) || this.lockPollIntervalMs <= 0) {
      throw new RangeError("lockPollIntervalMs must be a positive finite number.");
    }
    if (!Number.isFinite(this.lockStaleMs) || this.lockStaleMs < 0) {
      throw new RangeError("lockStaleMs must be a non-negative finite number.");
    }
    if (!Number.isSafeInteger(this.processId) || this.processId <= 0) {
      throw new RangeError("processId must be a positive safe integer.");
    }
  }

  async initialize(event: TaskCreatedEvent): Promise<TaskState> {
    try {
      await mkdir(dirname(this.taskDirectory), { recursive: true });
      await mkdir(this.taskDirectory);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new WorkflowError("TASK_EXISTS", `Task directory already exists: ${this.taskDirectory}`);
      }
      throw error;
    }

    await Promise.all([
      mkdir(join(this.taskDirectory, TASK_FILES.reviews)),
      mkdir(join(this.taskDirectory, TASK_FILES.final)),
      ...WORKFLOW_STAGES.map((stage) => mkdir(join(this.taskDirectory, STAGE_DIRECTORIES[stage]))),
    ]);

    const state = reduceEvents([event]);
    const project = projectManifest(event);
    await writeFile(this.eventsPath, stableJsonLine(event), { encoding: "utf8", flag: "wx" });
    await writeFile(join(this.taskDirectory, TASK_FILES.project), stableJson(project), {
      encoding: "utf8",
      flag: "wx",
    });
    await writeFile(join(this.taskDirectory, TASK_FILES.artifacts), "", {
      encoding: "utf8",
      flag: "wx",
    });
    await this.materializeDerived([event], state);
    return state;
  }

  async readEvents(options: { repairTail?: boolean } = {}): Promise<WorkflowEvent[]> {
    let content: string;
    try {
      content = await readFile(this.eventsPath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new WorkflowError("TASK_NOT_FOUND", `No workflow task found at ${this.taskDirectory}.`);
      }
      throw error;
    }

    const endedWithNewline = /\r?\n$/.test(content);
    const rawLines = content.split(/\r?\n/);
    if (rawLines.at(-1) === "") rawLines.pop();
    if (rawLines.length === 0) {
      throw new WorkflowError("EVENT_LOG_CORRUPT", "events.jsonl is empty.");
    }

    const events: WorkflowEvent[] = [];
    for (const [index, line] of rawLines.entries()) {
      if (!line.trim()) {
        if (index === rawLines.length - 1 && !endedWithNewline && events.length > 0) {
          if (options.repairTail) await this.repairIncompleteTail(content);
          break;
        }
        throw new WorkflowError(
          "EVENT_LOG_CORRUPT",
          `events.jsonl contains a blank record at line ${index + 1}.`,
        );
      }
      try {
        events.push(JSON.parse(line) as WorkflowEvent);
      } catch (error) {
        if (index === rawLines.length - 1 && !endedWithNewline && events.length > 0) {
          if (options.repairTail) await this.repairIncompleteTail(content);
          break;
        }
        throw new WorkflowError(
          "EVENT_LOG_CORRUPT",
          `events.jsonl contains invalid JSON at line ${index + 1}.`,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
    }
    if (options.repairTail && !endedWithNewline && events.length === rawLines.length) {
      const handle = await open(this.eventsPath, "a");
      try {
        await handle.writeFile("\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    return events;
  }

  async getState(): Promise<TaskState> {
    const events = await this.readEvents();
    await this.verifyProject(events);
    return reduceEvents(events);
  }

  private async verifyProject(events: readonly WorkflowEvent[]): Promise<void> {
    const created = events[0];
    invariant(created?.type === "task.created", "The first event must create the task.");
    const expectedProject = stableJson(projectManifest(created));
    let actualProject: string;
    try {
      actualProject = await readFile(join(this.taskDirectory, TASK_FILES.project), "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new WorkflowError("STATE_INVARIANT", "project.json is missing.");
      }
      throw error;
    }
    invariant(actualProject === expectedProject, "Immutable project.json differs from task.created.");
  }

  async transact<Result>(
    build: (state: TaskState) => Promise<TransactionResult<Result>> | TransactionResult<Result>,
  ): Promise<{ state: TaskState; result: Result }> {
    const release = await this.acquireLock();
    try {
      const currentEvents = await this.readEvents({ repairTail: true });
      await this.verifyProject(currentEvents);
      const currentState = reduceEvents(currentEvents);
      const transaction = await build(structuredClone(currentState));
      invariant(transaction.events.length > 0, "A transaction must append at least one event.");

      const allEvents = [...currentEvents, ...transaction.events];
      const nextState = reduceEvents(allEvents);
      const handle = await open(this.eventsPath, "a");
      try {
        await handle.writeFile(transaction.events.map(stableJsonLine).join(""), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      await this.materializeDerived(allEvents, nextState);
      return { state: nextState, result: transaction.result };
    } finally {
      await release();
    }
  }

  async verifyDerivedState(): Promise<boolean> {
    const expected = stableJson(await this.getState());
    try {
      return (await readFile(this.statePath, "utf8")) === expected;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async materializeDerived(events: readonly WorkflowEvent[], state: TaskState): Promise<void> {
    await this.writeAtomic(this.statePath, stableJson(state));

    const bindings = PROVIDER_CAPABILITIES.flatMap((capability) => {
      const binding = state.providers[capability];
      return binding ? [binding] : [];
    });
    await this.writeAtomic(
      join(this.taskDirectory, TASK_FILES.providerBindings),
      stableJson({ schemaVersion: 1, bindings }),
    );

    await this.appendMissingArtifacts(
      events.filter((event): event is ArtifactImportedEvent => event.type === "artifact.imported"),
    );
    await this.writeMissingReviews(
      events.filter(
        (event): event is ReviewRecordedEvent | RevisionRequestedEvent =>
          event.type === "review.recorded" || event.type === "revision.requested",
      ),
    );
  }

  private async repairIncompleteTail(content: string): Promise<void> {
    const lastNewline = Math.max(content.lastIndexOf("\n"), content.lastIndexOf("\r"));
    if (lastNewline < 0) {
      throw new WorkflowError("EVENT_LOG_CORRUPT", "The task creation event is incomplete.");
    }
    const committedPrefix = content.slice(0, lastNewline + 1);
    const handle = await open(this.eventsPath, "r+");
    try {
      await handle.truncate(Buffer.byteLength(committedPrefix, "utf8"));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async appendMissingArtifacts(events: readonly ArtifactImportedEvent[]): Promise<void> {
    const path = join(this.taskDirectory, TASK_FILES.artifacts);
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    const existingIds = new Set<string>();
    for (const [index, line] of existing.split(/\r?\n/).entries()) {
      if (!line) continue;
      try {
        const artifact = JSON.parse(line) as { artifactId?: string };
        invariant(artifact.artifactId, `artifacts.jsonl line ${index + 1} has no artifactId.`);
        existingIds.add(artifact.artifactId);
      } catch (error) {
        if (error instanceof WorkflowError) throw error;
        throw new WorkflowError(
          "EVENT_LOG_CORRUPT",
          `artifacts.jsonl contains invalid JSON at line ${index + 1}.`,
        );
      }
    }
    const missing = events.filter((event) => !existingIds.has(event.artifact.artifactId));
    if (missing.length === 0) return;
    const handle = await open(path, "a");
    try {
      await handle.writeFile(missing.map((event) => stableJsonLine(event.artifact)).join(""), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeMissingReviews(
    events: readonly (ReviewRecordedEvent | RevisionRequestedEvent)[],
  ): Promise<void> {
    for (const event of events) {
      const directory = join(
        this.taskDirectory,
        TASK_FILES.reviews,
        event.target.stage,
        versionLabel(event.target.revision),
      );
      const path = join(directory, `${event.eventId}.json`);
      const content = stableJson(event);
      await mkdir(directory, { recursive: true });
      try {
        await writeFile(path, content, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        invariant((await readFile(path, "utf8")) === content, `Review file differs from event ${event.eventId}.`);
      }
    }
  }

  private async writeAtomic(path: string, content: string): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      if (process.platform === "win32" && isNodeError(error, "EEXIST", "EPERM")) {
        await unlink(path);
        await rename(temporaryPath, path);
      } else {
        throw error;
      }
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const owner = this.ownerGenerator();
    invariant(owner.trim().length > 0, "The workflow lock owner must not be empty.");
    const startedAt = this.clock();
    let firstObservation: LockObservation | undefined;
    let firstObservedAt = startedAt;

    while (true) {
      const record: LockRecord = {
        schemaVersion: 1,
        owner,
        pid: this.processId,
        hostname: this.hostname,
        createdAt: new Date(this.clock()).toISOString(),
      };

      try {
        const handle = await open(this.lockPath, "wx");
        try {
          await handle.writeFile(stableJson(record), "utf8");
          await handle.sync();
        } catch (error) {
          await handle.close();
          await this.releaseOwnedLock(owner);
          throw error;
        }
        await handle.close();
        return async () => this.releaseOwnedLock(owner);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }

      const observed = await this.readLockObservation();
      if (!observed) continue;

      const now = this.clock();
      if (!firstObservation || !sameLock(firstObservation, observed)) {
        firstObservation = observed;
        firstObservedAt = now;
      }
      const timedOut = now - startedAt >= this.lockTimeoutMs;
      const unchangedForMs = now - firstObservedAt;
      if (await this.canRecoverLock(observed, timedOut, unchangedForMs, now)) {
        if (await this.removeLockIfUnchanged(observed)) {
          firstObservation = undefined;
          continue;
        }
      }

      if (timedOut) {
        throw new WorkflowError("LOCK_TIMEOUT", `Timed out waiting for ${this.lockPath}.`);
      }

      const remainingMs = this.lockTimeoutMs - (now - startedAt);
      await this.sleep(Math.min(this.lockPollIntervalMs, Math.max(1, remainingMs)));
    }
  }

  private async canRecoverLock(
    observed: LockObservation,
    timedOut: boolean,
    unchangedForMs: number,
    now: number,
  ): Promise<boolean> {
    const pid = observed.record?.pid ?? observed.legacyPid;
    const lockHostname = observed.record?.hostname ?? this.hostname;
    if (pid && sameHostname(lockHostname, this.hostname)) {
      return !(await this.processIsAlive(pid));
    }

    // A partially written lock has no trustworthy PID. Only reclaim it after it
    // remained byte-for-byte unchanged for the complete wait and its filesystem
    // timestamp is old enough. A valid lock owned by another host is never aged
    // out because creation time alone cannot prove that its owner is dead.
    if (observed.record || !timedOut || unchangedForMs < this.lockTimeoutMs) return false;
    return Math.max(0, now - observed.modifiedAtMs) >= this.lockStaleMs;
  }

  private async processIsAlive(pid: number): Promise<boolean> {
    try {
      return await this.isProcessAlive(pid);
    } catch {
      // Failure to establish liveness is not proof that a process is dead.
      return true;
    }
  }

  private async readLockObservation(): Promise<LockObservation | undefined> {
    let handle;
    try {
      handle = await open(this.lockPath, "r");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }

    try {
      const [raw, metadata] = await Promise.all([handle.readFile("utf8"), handle.stat()]);
      const record = parseLockRecord(raw);
      const legacyPid = parseLegacyPid(raw);
      return {
        raw,
        ...(record ? { record } : {}),
        ...(legacyPid ? { legacyPid } : {}),
        modifiedAtMs: metadata.mtimeMs,
        size: metadata.size,
        device: metadata.dev,
        inode: metadata.ino,
      };
    } finally {
      await handle.close();
    }
  }

  private async removeLockIfUnchanged(observed: LockObservation): Promise<boolean> {
    const current = await this.readLockObservation();
    if (!current || !sameLock(observed, current)) return false;
    try {
      await unlink(this.lockPath);
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async releaseOwnedLock(owner: string): Promise<void> {
    const current = await this.readLockObservation();
    if (current?.record?.owner !== owner) return;
    await this.removeLockIfUnchanged(current);
  }
}

function parseLockRecord(raw: string): LockRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LockRecord>;
    const createdAtMs = typeof value.createdAt === "string" ? Date.parse(value.createdAt) : Number.NaN;
    if (
      value.schemaVersion !== 1 ||
      typeof value.owner !== "string" ||
      value.owner.trim().length === 0 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.hostname !== "string" ||
      value.hostname.trim().length === 0 ||
      !Number.isFinite(createdAtMs)
    ) {
      return undefined;
    }
    return value as LockRecord;
  } catch {
    return undefined;
  }
}

function parseLegacyPid(raw: string): number | undefined {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function sameLock(left: LockObservation, right: LockObservation): boolean {
  return (
    left.record?.owner === right.record?.owner &&
    left.raw === right.raw &&
    left.size === right.size &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function sameHostname(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase("en-US") === right.trim().toLocaleLowerCase("en-US");
}

function systemProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown, ...codes: string[]): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && codes.includes(String(error.code));
}

export function providerBindings(state: TaskState): readonly ProviderBinding[] {
  return PROVIDER_CAPABILITIES.flatMap((capability) => {
    const binding = state.providers[capability];
    return binding ? [binding] : [];
  });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

export function projectManifest(event: TaskCreatedEvent): ProjectManifest {
  return {
    schemaVersion: 1,
    taskId: event.taskId,
    createdAt: event.at,
    input: { ...event.input },
    workflow: { stages: [...WORKFLOW_STAGES] },
    delivery: {
      language: "zh-CN",
      aspectRatio: "9:16",
      targetDurationSeconds: 75,
      minimumDurationSeconds: 60,
      maximumDurationSeconds: 90,
      targetShotCount: 10,
      minimumShotCount: 8,
      maximumShotCount: 12,
      width: 1080,
      height: 1920,
      frameRate: 30,
      videoCodec: "h264",
      pixelFormat: "yuv420p",
      audioCodec: "aac",
      audioSampleRate: 48000,
      subtitles: { language: "zh-CN", sidecars: ["srt", "ass"], burnIn: true },
    },
    policies: { voiceClone: { defaultEnabled: false, consentRequired: true } },
  };
}
