import { randomUUID } from 'node:crypto';
import type { AuthInfo, Operation, OperationContext } from './ops/contract.ts';
import type { ToolResult } from '../mcp/dispatch.ts';
import type { LifecycleFailure, LifecyclePrincipal, OperationAdmission, ReleaseReason } from './operation-lifecycle.ts';
import { boundedWait, LIFECYCLE_CLEANUP_MS, type LoadedLifecycle } from './operation-lifecycle-loader.ts';

type Events = { once(event: string, fn: () => void): unknown; off(event: string, fn: () => void): unknown };
type ResponseEvents = Events & { readonly writableFinished?: boolean; readonly destroyed?: boolean };
type RequestEvents = Events & { readonly aborted?: boolean };
const scopes = new WeakSet<object>();
export type OperationRequest = RequestScope;

export function freezeJson<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (v: unknown): void => {
    if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); }
  };
  freeze(copy);
  return copy;
}
export function projectLifecyclePrincipal(auth: AuthInfo): LifecyclePrincipal {
  // AuthInfo.token and clientName are deliberately not copied.
  const expiresAtMs = auth.expiresAt === undefined ? undefined : auth.expiresAt * 1000;
  if (!auth.clientId || !Array.isArray(auth.scopes) ||
      (expiresAtMs !== undefined && !Number.isSafeInteger(expiresAtMs))) throw new Error('Invalid verified identity');
  return freezeJson({
    clientId: auth.clientId, scopes: auth.scopes, expiresAtMs, sourceId: auth.sourceId,
    allowedSources: auth.allowedSources, hasSourceGrant: auth.hasSourceGrant,
    takesHoldersAllowList: auth.takesHoldersAllowList, boundSlugPrefixes: auth.boundSlugPrefixes,
    fenceProjectionDegraded: auth.fenceProjectionDegraded, surface: auth.surface,
  });
}
class LifecycleError extends Error {
  constructor(readonly reason: ReleaseReason, readonly failure?: LifecycleFailure) {
    super('Configured operation lifecycle refused the operation');
  }
}
function failureResult(failure?: LifecycleFailure): ToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({
    error: failure?.code ?? 'unavailable',
    message: failure?.publicMessage ?? 'The configured host could not authorize this operation.',
  }) }] };
}
function checkedFailure(value: unknown): LifecycleFailure {
  const f = value as LifecycleFailure | null;
  if (!f || !['admission_refused', 'resource_exhausted', 'unavailable'].includes(f.code) ||
      (f.publicMessage !== undefined && (typeof f.publicMessage !== 'string' || f.publicMessage.length > 512))) {
    throw new LifecycleError('authorization_uncertain');
  }
  return { code: f.code, ...(f.publicMessage !== undefined ? { publicMessage: f.publicMessage } : {}) };
}
class RequestScope {
  readonly controller = new AbortController();
  readonly principal: LifecyclePrincipal;
  readonly attemptId = randomUUID();
  readonly startedAt = Date.now();
  private endMono: number;
  private endEpoch: number;
  private timer?: ReturnType<typeof setTimeout>;
  private admission?: OperationAdmission;
  private began = false;
  private ended = false;
  private delivered = false;
  private pageFailure?: LifecycleError;
  private releasePromise?: Promise<void>;
  private stopReason: ReleaseReason = 'deadline';
  private rejectStopped!: (error: LifecycleError) => void;
  private readonly stopped = new Promise<never>((_, reject) => { this.rejectStopped = reject; });
  constructor(readonly loaded: LoadedLifecycle, readonly resource: string, auth: AuthInfo) {
    this.principal = projectLifecyclePrincipal(auth);
    this.endEpoch = Math.min(this.startedAt + loaded.host.limits.operationTimeoutMs,
      this.principal.expiresAtMs ?? Infinity);
    this.endMono = performance.now() + Math.max(0, this.endEpoch - Date.now());
    // A stopped scope can precede the first awaited work.
    void this.stopped.catch(() => {});
    scopes.add(this);
    this.arm();
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop('deadline'), Math.max(0, this.endMono - performance.now()));
  }
  stop(reason: ReleaseReason): void {
    if (this.ended || this.controller.signal.aborted) return;
    this.stopReason = reason;
    this.controller.abort();
    this.rejectStopped(new LifecycleError(reason));
  }
  private check(): void {
    if (this.ended) throw new LifecycleError('authorization_uncertain');
    if (performance.now() >= this.endMono || Date.now() >= this.endEpoch) this.stop('deadline');
    if (this.controller.signal.aborted) throw new LifecycleError(this.stopReason);
  }
  private epochDeadline(): number { return Math.min(this.endEpoch, Date.now() + Math.max(0, this.endMono - performance.now())); }
  private async hostCall<T>(call: () => Promise<T>): Promise<T> {
    this.check();
    try {
      const value = await Promise.race([Promise.resolve().then(() => { this.check(); return call(); }), this.stopped]);
      this.check();
      return value;
    } catch (e) {
      if (e instanceof LifecycleError) throw e;
      this.loaded.reportFailure();
      throw new LifecycleError('authorization_uncertain');
    }
  }
  async begin(op: Operation, params: Record<string, unknown>, ctx: OperationContext): Promise<boolean> {
    this.check();
    if (this.began) throw new LifecycleError('authorization_uncertain');
    this.began = true;
    const deadlineAt = this.epochDeadline();
    const invocation = Object.freeze({
      attemptId: this.attemptId, operation: Object.freeze({ name: op.name, scope: op.scope ?? 'read', mutating: op.mutating === true }),
      params: freezeJson(params), principal: this.principal, resource: this.resource,
      startedAt: this.startedAt, deadlineAt, signal: this.controller.signal,
    });
    const beginWork = Promise.resolve().then(() => {
      this.check(); // recheck at scheduled invocation, including expensive parameter cloning
      return this.loaded.host.begin(invocation);
    }).then(async result => {
      if (!result || typeof result !== 'object') throw new LifecycleError('authorization_uncertain');
      if (result.kind === 'refused') throw new LifecycleError('host_refusal', checkedFailure(result.failure));
      if (result.kind !== 'admitted') throw new LifecycleError('authorization_uncertain');
      const a = result.admission;
      // Retain cleanup authority even if another admission field is invalid.
      if (a && typeof a.release === 'function') {
        this.admission = a;
        if (this.ended || this.controller.signal.aborted) { await this.release(this.stopReason); throw new LifecycleError(this.stopReason); }
      }
      if (!a || typeof a.authorize !== 'function' || typeof a.release !== 'function' ||
          typeof a.allowOptionalEnrichment !== 'boolean' || !Number.isFinite(a.expiresAt) ||
          (a.beforePageRead !== undefined && typeof a.beforePageRead !== 'function')) {
        throw new LifecycleError('authorization_uncertain');
      }
      this.admission = a;
      if (this.ended || this.controller.signal.aborted) { await this.release(this.stopReason); throw new LifecycleError(this.stopReason); }
      if (a.expiresAt <= Date.now() || a.expiresAt > deadlineAt) throw new LifecycleError('authorization_uncertain');
      this.endEpoch = Math.min(this.endEpoch, a.expiresAt);
      this.endMono = Math.min(this.endMono, performance.now() + Math.max(0, a.expiresAt - Date.now()));
      this.arm();
      return a;
    });
    // hostCall may refuse before awaiting; every late begin still has an observer.
    void beginWork.catch(() => {});
    const a = await this.hostCall(() => beginWork);
    const prior = ctx.beforePageRead;
    ctx.beforePageRead = async target => {
      if (this.pageFailure) throw this.pageFailure;
      try {
        this.check();
        if (prior) await prior(target);
        this.check();
        if (a.beforePageRead) {
          const decision = await this.hostCall(() => a.beforePageRead!(target, this.controller.signal));
          if (decision !== undefined) {
            if (!decision || decision.kind !== 'refused') throw new LifecycleError('authorization_uncertain');
            throw new LifecycleError('host_refusal', checkedFailure(decision.failure));
          }
        }
      } catch (error) {
        // Admission is terminal even if a handler catches and returns fallback content.
        this.pageFailure ??= error instanceof LifecycleError ? error : new LifecycleError('handler_error');
        throw error;
      }
    };
    return a.allowOptionalEnrichment;
  }
  async release(reason: ReleaseReason): Promise<void> {
    if (!this.admission || this.delivered) return;
    if (!this.releasePromise) {
      this.releasePromise = boundedWait(Promise.resolve().then(() => this.admission!.release(reason)),
        Math.min(this.loaded.host.limits.shutdownTimeoutMs, LIFECYCLE_CLEANUP_MS))
        .catch(() => { this.loaded.reportFailure(); });
    }
    await this.releasePromise;
  }
  async run(work: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      this.check();
      const result = await Promise.race([Promise.resolve().then(work), this.stopped]);
      this.check();
      if (this.pageFailure) throw this.pageFailure;
      if (result.isError) {
        const admitted = !!this.admission;
        await this.release('handler_error');
        // Handler failures may embed stored content. Only pre-admission errors
        // and deliberate public host refusals retain their original envelope.
        return admitted ? failureResult() : result;
      }
      // Early successful non-tool protocol work never uses this runner; successful
      // tools must have reached dispatcher begin.
      if (!this.admission) throw new LifecycleError('authorization_uncertain');
      const serialized = JSON.stringify(result);
      const responseBytes = Buffer.byteLength(serialized, 'utf8');
      if (responseBytes > this.loaded.host.limits.maxResponseBytes) throw new LifecycleError('invalid_response');
      const frozen = freezeJson(JSON.parse(serialized) as ToolResult);
      this.check();
      const decision = await this.hostCall(() => this.admission!.authorize(Object.freeze({
        deadlineAt: this.epochDeadline(), signal: this.controller.signal, responseBytes,
      })));
      if (!decision || decision.kind !== 'deliver') {
        throw new LifecycleError('host_refusal', decision?.kind === 'refused' ? checkedFailure(decision.failure) : undefined);
      }
      this.delivered = true;
      return frozen;
    } catch (e) {
      const known = e instanceof LifecycleError ? e : new LifecycleError('invalid_response');
      this.stopReason = known.reason;
      await this.release(known.reason);
      return failureResult(known.failure);
    } finally {
      this.ended = true;
      scopes.delete(this);
      if (this.timer) clearTimeout(this.timer);
    }
  }
}
export function assertOperationRequest(scope: OperationRequest, ctx: OperationContext): void {
  if (!scopes.has(scope) || ctx.remote !== true || ctx.transport !== 'http' ||
      (!ctx.auth || JSON.stringify(projectLifecyclePrincipal(ctx.auth)) !== JSON.stringify(scope.principal))) throw new LifecycleError('host_refusal');
}
export function operationRequestError(error: unknown): ToolResult | undefined {
  return error instanceof LifecycleError ? failureResult(error.failure) : undefined;
}
export async function runOperationRequest(
  loaded: LoadedLifecycle | undefined, resource: string, auth: AuthInfo,
  request: RequestEvents, response: ResponseEvents,
  work: (scope?: OperationRequest) => Promise<ToolResult>,
): Promise<ToolResult> {
  if (!loaded) return work();
  let scope: RequestScope;
  try { scope = new RequestScope(loaded, resource, auth); }
  catch { return failureResult(); }
  const onAbort = () => scope.stop('disconnected');
  const onClose = () => { if (!response.writableFinished) scope.stop('disconnected'); };
  const onShutdown = () => scope.stop('shutdown');
  request.once('aborted', onAbort);
  response.once('close', onClose);
  loaded.signal.addEventListener('abort', onShutdown, { once: true });
  if (request.aborted || response.destroyed) onAbort();
  if (loaded.signal.aborted) onShutdown();
  try { return await scope.run(() => work(scope)); }
  finally {
    request.off('aborted', onAbort);
    response.off('close', onClose);
    loaded.signal.removeEventListener('abort', onShutdown);
  }
}
