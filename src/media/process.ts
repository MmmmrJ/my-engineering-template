import { spawn } from "node:child_process";

export interface ProcessRunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export type ProcessRunner = (
  executable: string,
  args: readonly string[],
  options?: ProcessRunOptions,
) => Promise<ProcessResult>;

export class MediaProcessError extends Error {
  readonly executable: string;
  readonly args: readonly string[];
  readonly exitCode?: number;
  readonly stderr?: string;

  constructor(
    message: string,
    details: {
      executable: string;
      args: readonly string[];
      exitCode?: number;
      stderr?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: details.cause });
    this.name = "MediaProcessError";
    this.executable = details.executable;
    this.args = details.args;
    this.exitCode = details.exitCode;
    this.stderr = details.stderr;
  }
}

export const runProcess: ProcessRunner = async (executable, args, options = {}) => {
  const startedAt = performance.now();
  const maxOutputBytes = options.maxOutputBytes ?? 10 * 1_024 * 1_024;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finishReject(new MediaProcessError(`Process timed out after ${timeoutMs}ms`, {
        executable,
        args,
      }));
    }, timeoutMs);
    timer.unref();

    const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        finishReject(new MediaProcessError(
          `Process output exceeded the ${maxOutputBytes}-byte limit`,
          { executable, args },
        ));
        return;
      }
      target.push(buffer);
    };
    child.stdout.on("data", collect(stdoutChunks));
    child.stderr.on("data", collect(stderrChunks));
    child.once("error", (error) => {
      finishReject(new MediaProcessError(`Could not start ${executable}`, {
        executable,
        args,
        cause: error,
      }));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        durationMs: Math.round(performance.now() - startedAt),
      });
    });

    function finishReject(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
};

export async function runChecked(
  runner: ProcessRunner,
  executable: string,
  args: readonly string[],
  options?: ProcessRunOptions,
): Promise<ProcessResult> {
  const result = await runner(executable, args, options);
  if (result.exitCode !== 0) {
    throw new MediaProcessError(`${executable} exited with code ${result.exitCode}`, {
      executable,
      args,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 4_096),
    });
  }
  return result;
}
