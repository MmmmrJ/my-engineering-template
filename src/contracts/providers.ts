import type { ProviderCapability } from "./stages.js";

export interface ProviderDescriptor {
  id: string;
  name?: string;
  capabilities: readonly ProviderCapability[];
  configured?: boolean;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ProviderHealth {
  providerId: string;
  ok: boolean;
  message?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ProviderJob {
  id: string;
  remoteJobId: string;
  providerId: string;
  capability: ProviderCapability;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed_retryable"
    | "failed_terminal"
    | "cancelled";
  model?: string;
  submittedAt: string;
  updatedAt: string;
  progress?: number;
  outputs?: readonly {
    kind: "image" | "video" | "audio" | "subtitle" | "text" | "json" | "other";
    uri?: string;
    localPath?: string;
    archivedPath?: string;
    mimeType?: string;
    sizeBytes?: number;
    sha256?: string;
    metadata?: Readonly<Record<string, unknown>>;
  }[];
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Readonly<Record<string, unknown>>;
  };
  retryAfterMs?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Deliberately small facade used by the CLI. Provider packages can adapt a richer
 * registry without making the workflow domain depend on any vendor SDK.
 */
export interface ProviderFacade {
  list(): Promise<readonly ProviderDescriptor[]>;
  check(providerId?: string): Promise<readonly ProviderHealth[]>;
}
