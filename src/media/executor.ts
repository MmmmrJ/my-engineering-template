import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { MediaCommandPlan } from "./plans.js";
import type { ProcessRunner } from "./process.js";
import { runChecked, runProcess } from "./process.js";

export interface ExecuteMediaPlanOptions {
  /** Every generated output and auxiliary file must remain under this root. */
  readonly workspaceRoot: string;
  readonly runner?: ProcessRunner;
  readonly timeoutMs?: number;
  readonly maxProcessOutputBytes?: number;
}

export interface ExecutedMediaPlan {
  readonly outputPath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly auxiliaryFiles: readonly string[];
  readonly durationMs: number;
}

/** Execute a deterministic plan without allowing it to overwrite task artifacts. */
export async function executeMediaPlan(
  plan: MediaCommandPlan,
  options: ExecuteMediaPlanOptions,
): Promise<ExecutedMediaPlan> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const outputPath = assertWorkspacePath(workspaceRoot, plan.outputPath, "media output");
  const auxiliaryFiles = plan.auxiliaryFiles.map((file) => ({
    path: assertWorkspacePath(workspaceRoot, file.path, "media auxiliary file"),
    content: file.content,
  }));
  await assertMissing(outputPath, "Media output already exists and is immutable");
  for (const file of auxiliaryFiles) {
    await mkdir(dirname(file.path), { recursive: true });
    try {
      await writeFile(file.path, file.content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      if ((await readFile(file.path, "utf8")) !== file.content) {
        throw new Error(`Media auxiliary file already exists with different content: ${file.path}`, {
          cause: error,
        });
      }
    }
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const result = await runChecked(
    options.runner ?? runProcess,
    plan.executable,
    plan.args,
    {
      timeoutMs: options.timeoutMs ?? 30 * 60_000,
      maxOutputBytes: options.maxProcessOutputBytes ?? 25 * 1_024 * 1_024,
    },
  );
  const metadata = await stat(outputPath);
  if (!metadata.isFile() || metadata.size <= 0) {
    throw new Error(`Media plan did not create a non-empty file: ${outputPath}`);
  }
  return {
    outputPath,
    sizeBytes: metadata.size,
    sha256: await sha256File(outputPath),
    auxiliaryFiles: auxiliaryFiles.map((file) => file.path),
    durationMs: result.durationMs,
  };
}

function assertWorkspacePath(root: string, candidate: string, label: string): string {
  if (!isAbsolute(candidate)) throw new TypeError(`${label} must be an absolute path`);
  const resolved = resolve(candidate);
  const relation = relative(root, resolved);
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) {
    throw new TypeError(`${label} must be a child of the configured workspace root`);
  }
  return resolved;
}

async function assertMissing(path: string, message: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  throw new Error(`${message}: ${path}`);
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
