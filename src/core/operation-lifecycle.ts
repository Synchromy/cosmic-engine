import type { CompositeHostV1 } from './operation-composite.ts';
export type { CompositeHostV1, CompositeInvocation, CompositeOutcomeContext, CompositeExecution, CompositeDispatch } from './operation-composite.ts';
import type { BrainEngine } from './engine.ts';
import type { PageReadTarget } from './page-read-identity.ts';

/** Generic host authority. No economic policy or bearer credentials cross this port. */
export type LifecycleFailure = Readonly<{
  code: 'admission_refused' | 'resource_exhausted' | 'unavailable';
  publicMessage?: string;
}>;
export type LifecyclePrincipal = Readonly<{
  clientId: string; scopes: readonly string[]; expiresAtMs?: number;
  sourceId?: string; allowedSources?: readonly string[]; hasSourceGrant?: boolean;
  takesHoldersAllowList?: readonly string[]; boundSlugPrefixes?: readonly string[];
  fenceProjectionDegraded?: boolean; surface?: string;
}>;
export type OperationDescriptor = Readonly<{ name: string; scope: string; mutating: boolean }>;
export type LifecycleInvocation = Readonly<{
  attemptId: string; operation: OperationDescriptor;
  params: Readonly<Record<string, unknown>>; principal: LifecyclePrincipal;
  resource: string; startedAt: number; deadlineAt: number; signal: AbortSignal;
}>;
export type ReleaseReason = 'handler_error' | 'host_refusal' | 'deadline' | 'disconnected'
  | 'invalid_response' | 'shutdown' | 'authorization_uncertain';
export interface OperationAdmission {
  readonly expiresAt: number;
  readonly allowOptionalEnrichment: boolean;
  beforePageRead?(target: PageReadTarget, signal: AbortSignal): Promise<
    void | Readonly<{ kind: 'refused'; failure: LifecycleFailure }>
  >;
  authorize(input: Readonly<{ deadlineAt: number; signal: AbortSignal; responseBytes: number }>): Promise<
    Readonly<{ kind: 'deliver' }> | Readonly<{ kind: 'refused'; failure: LifecycleFailure }>
  >;
  release(reason: ReleaseReason): Promise<void>;
}
export interface OperationLifecycleHost {
  readonly version: 1;
  readonly composite?: CompositeHostV1;
  readonly limits: Readonly<{
    operationTimeoutMs: number; maxResponseBytes: number; shutdownTimeoutMs: number;
  }>;
  begin(invocation: LifecycleInvocation): Promise<
    Readonly<{ kind: 'admitted'; admission: OperationAdmission }>
    | Readonly<{ kind: 'refused'; failure: LifecycleFailure }>
  >;
  shutdown(): Promise<void>;
}
export type LifecycleEvent = 'initialized' | 'host_failure' | 'cleanup_failure';
export type LifecyclePorts = Readonly<{
  engine: BrainEngine; resource: string; operations: readonly OperationDescriptor[];
  report(event: LifecycleEvent): void;
}>;
export interface OperationLifecycleModule {
  readonly protocolVersion: 1;
  createOperationLifecycleHost(ports: LifecyclePorts): Promise<OperationLifecycleHost>;
}
