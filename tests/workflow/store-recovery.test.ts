import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ProviderSelectedEvent, TaskCreatedEvent } from "../../src/contracts/index.js";
import { FileEventStore, pathExists } from "../../src/workflow/index.js";

const AT = "2026-08-10T01:02:03.000Z";
const TEST_HOST = "workflow-lock-test-host";

describe("FileEventStore lock recovery", () => {
  it("ignores and truncates only an incomplete final event before the next transaction", async () => {
    const { store } = await initializedTask();
    await appendFile(store.eventsPath, '{"type":"provider.selected","eventId":"partial', "utf8");

    await expect(store.readEvents()).resolves.toHaveLength(1);
    await appendBinding(store, "event_after_partial_tail");

    const content = await readFile(store.eventsPath, "utf8");
    expect(content).not.toContain('"eventId":"partial');
    expect(content.endsWith("\n")).toBe(true);
    const lines = content.trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
  });

  it("reclaims an orphaned same-host lock when its PID is no longer alive", async () => {
    const { directory } = await initializedTask();
    const lockPath = join(directory, ".workflow.lock");
    await writeLock(lockPath, {
      owner: "crashed-owner",
      pid: 424_242,
      hostname: TEST_HOST,
      createdAt: AT,
    });

    const checkedPids: number[] = [];
    const store = new FileEventStore(directory, {
      hostname: TEST_HOST,
      processId: 101,
      ownerGenerator: () => "recovery-owner",
      isProcessAlive: (pid) => {
        checkedPids.push(pid);
        return false;
      },
    });

    await appendBinding(store, "event_after_recovery");

    expect(checkedPids).toEqual([424_242]);
    expect(await store.readEvents()).toHaveLength(2);
    expect(await pathExists(lockPath)).toBe(false);
  });

  it("recovers an old incomplete lock only after it stays unchanged for the full timeout", async () => {
    const { directory } = await initializedTask();
    const lockPath = join(directory, ".workflow.lock");
    await writeFile(lockPath, "{partial", "utf8");

    let now = 10_000;
    const sleeps: number[] = [];
    const store = new FileEventStore(directory, {
      lockTimeoutMs: 20,
      lockPollIntervalMs: 5,
      lockStaleMs: 0,
      clock: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      hostname: TEST_HOST,
      processId: 102,
      ownerGenerator: () => "incomplete-recovery-owner",
      isProcessAlive: () => true,
    });

    await appendBinding(store, "event_after_incomplete_recovery");

    expect(sleeps.reduce((total, value) => total + value, 0)).toBe(20);
    expect(await store.readEvents()).toHaveLength(2);
    expect(await pathExists(lockPath)).toBe(false);
  });

  it("times out without removing a live same-host lock", async () => {
    const { directory } = await initializedTask();
    const lockPath = join(directory, ".workflow.lock");
    await writeLock(lockPath, {
      owner: "live-owner",
      pid: 303,
      hostname: TEST_HOST,
      createdAt: AT,
    });
    const original = await readFile(lockPath, "utf8");

    let now = 0;
    const store = new FileEventStore(directory, {
      lockTimeoutMs: 10,
      lockPollIntervalMs: 2,
      lockStaleMs: 0,
      clock: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      hostname: TEST_HOST,
      processId: 103,
      ownerGenerator: () => "waiting-owner",
      isProcessAlive: (pid) => pid === 303,
    });

    await expect(appendBinding(store, "event_never_appended")).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
    });
    expect(await readFile(lockPath, "utf8")).toBe(original);
    expect(await store.readEvents()).toHaveLength(1);
  });

  it("does not delete a replacement lock when ownership changes during recovery", async () => {
    const { directory } = await initializedTask();
    const lockPath = join(directory, ".workflow.lock");
    await writeLock(lockPath, {
      owner: "dead-owner",
      pid: 404,
      hostname: TEST_HOST,
      createdAt: AT,
    });

    const replacement = lockJson({
      owner: "replacement-owner",
      pid: 405,
      hostname: TEST_HOST,
      createdAt: AT,
    });
    let now = 0;
    let replaced = false;
    const store = new FileEventStore(directory, {
      lockTimeoutMs: 10,
      lockPollIntervalMs: 2,
      clock: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      hostname: TEST_HOST,
      processId: 104,
      ownerGenerator: () => "contender-owner",
      isProcessAlive: async (pid) => {
        if (pid === 404 && !replaced) {
          replaced = true;
          await writeFile(lockPath, replacement, "utf8");
          return false;
        }
        return pid === 405;
      },
    });

    await expect(appendBinding(store, "event_blocked_by_replacement")).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
    });
    expect(await readFile(lockPath, "utf8")).toBe(replacement);
    expect(await store.readEvents()).toHaveLength(1);
  });

  it("release removes only the lock owned by the completed transaction", async () => {
    const { directory } = await initializedTask();
    const lockPath = join(directory, ".workflow.lock");
    const replacement = lockJson({
      owner: "next-owner",
      pid: 606,
      hostname: TEST_HOST,
      createdAt: AT,
    });
    const store = new FileEventStore(directory, {
      hostname: TEST_HOST,
      processId: 105,
      ownerGenerator: () => "transaction-owner",
      isProcessAlive: () => true,
    });

    await store.transact(async () => {
      const acquired: unknown = JSON.parse(await readFile(lockPath, "utf8"));
      expect(acquired).toMatchObject({
        schemaVersion: 1,
        owner: "transaction-owner",
        pid: 105,
        hostname: TEST_HOST,
      });
      expect(typeof (acquired as { createdAt?: unknown }).createdAt).toBe("string");
      await writeFile(lockPath, replacement, "utf8");
      return { events: [bindingEvent("event_with_replaced_lock")], result: undefined };
    });

    expect(await readFile(lockPath, "utf8")).toBe(replacement);
    expect(await store.readEvents()).toHaveLength(2);
  });
});

async function initializedTask(): Promise<{ directory: string; store: FileEventStore }> {
  const root = await mkdtemp(join(tmpdir(), "cartoon-lock-recovery-"));
  const directory = join(root, "task");
  const store = new FileEventStore(directory);
  await store.initialize(taskCreatedEvent());
  return { directory, store };
}

async function appendBinding(store: FileEventStore, eventId: string): Promise<void> {
  await store.transact(() => ({ events: [bindingEvent(eventId)], result: undefined }));
}

function taskCreatedEvent(): TaskCreatedEvent {
  return {
    eventId: "event_created",
    at: AT,
    type: "task.created",
    taskId: "lock-recovery-task",
    input: { ip: "Original Test IP", theme: "Crash recovery" },
  };
}

function bindingEvent(eventId: string): ProviderSelectedEvent {
  return {
    eventId,
    at: AT,
    type: "provider.selected",
    capability: "image.generate",
    providerId: "manual",
    mode: "manual",
  };
}

interface TestLockRecord {
  owner: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

async function writeLock(path: string, record: TestLockRecord): Promise<void> {
  await writeFile(path, lockJson(record), "utf8");
}

function lockJson(record: TestLockRecord): string {
  return `${JSON.stringify({ schemaVersion: 1, ...record }, null, 2)}\n`;
}
