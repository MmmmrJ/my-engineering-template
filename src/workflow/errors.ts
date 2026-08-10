export type WorkflowErrorCode =
  | "INVALID_INPUT"
  | "TASK_EXISTS"
  | "TASK_NOT_FOUND"
  | "EVENT_LOG_CORRUPT"
  | "STATE_INVARIANT"
  | "INVALID_TRANSITION"
  | "REVIEW_REQUIRED"
  | "PROVIDER_SELECTION_REQUIRED"
  | "RIGHTS_REQUIRED"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_EXISTS"
  | "EXPORT_NOT_READY"
  | "EXPORT_EXISTS"
  | "LOCK_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "USAGE";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: WorkflowErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(
  condition: unknown,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): asserts condition {
  if (!condition) {
    throw new WorkflowError("STATE_INVARIANT", message, details);
  }
}

