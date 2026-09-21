import type { ToolResult } from '../mcp/dispatch.ts';
import type { OperationFailure, OperationDeliveryEffect } from './ops/contract.ts';
import type { LifecycleInvocation, LifecycleFailure, OperationAdmission, OperationDescriptor } from './operation-lifecycle.ts';
import type { OriginalEnvelope } from './operation-original-envelope.ts';

export type CompositeInvocation = LifecycleInvocation & Readonly<{
  original: OriginalEnvelope; method: 'POST'; path: string;
  credentialBinding: string; proof: string; requestedDeadlineAt: number;
}>;
export type CompositeOutcomeContext = Readonly<{
  signal: AbortSignal;
  reportFailure(failure: OperationFailure): void;
  deferAfterDelivery(effect: OperationDeliveryEffect): void;
}>;
export type CompositeDispatch = (body: string, capability: string, signal: AbortSignal) => Promise<Response>;
export type CompositeExecution =
  | Readonly<{ kind: 'refused'; failure: LifecycleFailure }>
  | Readonly<{ kind: 'admitted'; admission: OperationAdmission; run(context: CompositeOutcomeContext): Promise<ToolResult> }>;
/** Trusted optional extension on a v1 host. No network-supplied function or destination enters this port. */
export interface CompositeHostV1 {
  readonly version: 1;
  readonly operations: readonly OperationDescriptor[];
  execute(invocation: CompositeInvocation, dispatch: CompositeDispatch): Promise<CompositeExecution>;
  admitChild(invocation: CompositeInvocation, capability: string): Promise<
    Readonly<{ kind: 'admitted'; admission: OperationAdmission }> | Readonly<{ kind: 'refused'; failure: LifecycleFailure }>
  >;
}
export function validateCompositeHost(value: unknown, native: readonly OperationDescriptor[]): CompositeHostV1 | undefined {
  if (value === undefined) return undefined;
  const h = value as CompositeHostV1;
  if (!h || h.version !== 1 || typeof h.execute !== 'function' || typeof h.admitChild !== 'function'
    || !Array.isArray(h.operations) || !h.operations.length || h.operations.length > 16) throw new Error('Invalid composite host');
  const seen = new Set(native.map(o => o.name));
  const operations = h.operations.map(o => {
    if (!o || Object.keys(o).sort().join(',') !== 'mutating,name,scope' || !/^[a-z][a-z0-9_]{0,99}$/.test(o.name)
      || o.scope !== 'read' || o.mutating !== false || seen.has(o.name)) throw new Error('Invalid composite descriptor');
    seen.add(o.name); return Object.freeze({ name: o.name, scope: o.scope, mutating: false });
  });
  return Object.freeze({ version: 1, operations: Object.freeze(operations), execute: h.execute.bind(h), admitChild: h.admitChild.bind(h) });
}
