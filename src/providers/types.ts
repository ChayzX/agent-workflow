// Provider-independent execution interface. Adapters declare capabilities instead of the
// engine assuming every provider behaves identically.
import type { FailureClass, ProviderId, TaskKind, RoleId } from '../core/types.js';

export interface ProviderCapabilities {
  nonInteractive: boolean;
  structuredOutput: 'json-schema' | 'prompt-only' | 'none';
  streamingEvents: boolean;
  sessionIds: boolean;
  resume: boolean;
  modelSelection: boolean;
  reasoningSelection: boolean;
  workdirIsolation: boolean;
  sandboxModes: Array<'read-only' | 'workspace-write'>;
  cancellation: boolean;
  authValidation: boolean;
  usageLimitDetection: 'provider-reset-time' | 'message-parse' | 'none';
  capacityProbe: 'non-model' | 'none';     // can we check remaining capacity without spending model usage?
  usageReporting: 'tokens' | 'tokens+cost-estimate' | 'none';
}

export interface ProviderEvent {
  kind: 'session' | 'message' | 'tool' | 'rate_limit' | 'error' | 'usage' | 'raw';
  text?: string;
  data?: unknown;
}

export interface RateLimitObservation {
  window: string;                       // five_hour, seven_day, primary, secondary, model:<name>
  status: 'allowed' | 'warning' | 'rejected' | 'unknown';
  utilization?: number | null;          // 0..1 when provider exposes it
  resetsAt?: number | null;             // epoch ms
}

export interface ExecRequest {
  prompt: string;
  cwd: string;
  mode: 'read-only' | 'workspace-write';
  model?: string | null;
  effort?: string | null;
  outputSchema?: Record<string, unknown>;
  resumeSessionId?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  env: Record<string, string>;
  maxTurns?: number;
  transcriptPath?: string;
  onEvent?: (e: ProviderEvent) => void;
  onSpawn?: (pid: number) => void;
  /** Optional OS confinement applied by the supervisor; adapters pass extra scratch dirs they need writable. */
  /** May also return the environment for the local process (e.g. devvm gets only its own minimal environment). */
  wrap?: (cmd: string, args: string[], extraWritable: string[], env: Record<string, string>) => { cmd: string; args: string[]; env?: Record<string, string> };
  /** True when the supervisor's OS sandbox makes the working tree and repository read-only (bubblewrap). Read-only
   *  tasks may then run commands (tests, scripts) because writes are impossible, matching Codex `-s read-only`. */
  osReadOnly?: boolean;
  meta: { taskId: string; taskKind: TaskKind; role: RoleId; projectId: string; workItemKey?: string | null; attempt: number; agentId?: string | null };
}

export interface ExecFailure {
  cls: FailureClass;
  message: string;
  resetAt?: number | null;              // epoch ms, provider-reported when available
  resetSource?: 'provider' | 'parsed' | 'none';
  limitKind?: string | null;            // five_hour | seven_day | weekly | model | unknown
  model?: string | null;                // model-specific limit
}

export interface ExecResult {
  ok: boolean;
  sessionId: string | null;
  structured: unknown | null;
  text: string;
  failure?: ExecFailure;
  usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; costUsd?: number; model?: string | null };
  rateLimits: RateLimitObservation[];
  exitCode: number | null;
  durationMs: number;
  authSource?: string | null;           // e.g. Claude init.apiKeySource
}

export interface DetectResult { installed: boolean; version?: string; path?: string; error?: string }
export interface AuthResult { ok: boolean; method?: string; detail?: string; apiKeyBilling?: boolean }
export interface CapacityProbe {
  available: boolean | null;            // null = unknown
  windows: RateLimitObservation[];
  resetAt?: number | null;
  detail?: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  detect(): Promise<DetectResult>;
  checkAuth(): Promise<AuthResult>;
  probeCapacity(): Promise<CapacityProbe | null>;
  execute(req: ExecRequest): Promise<ExecResult>;
}
