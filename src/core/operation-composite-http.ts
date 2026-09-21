import type { Request, Response as ExpressResponse } from 'express';
import type { AuthInfo, Operation, OperationContext } from './ops/contract.ts';
import type { LoadedLifecycle } from './operation-lifecycle-loader.ts';
import type { CompositeExecution, CompositeInvocation, CompositeDispatch } from './operation-composite.ts';
import { runOperationRequest } from './operation-lifecycle-runner.ts';
import { hasScope } from './scope.ts';
import {
  COMPOSITE_PATH, PROOF_HEADER, CAPABILITY_HEADER, DEADLINE_HEADER, COMPOSITE_TIMEOUT_MS,
  internalHeader, internalDeadline, credentialBinding, readOriginalEnvelope, parseOriginalEnvelope,
  originalFailure, type OriginalEnvelope,
} from './operation-original-envelope.ts';

const received = new WeakMap<object, { epoch: number; mono: number }>();
export function markCompositeAdmission(req: object): void { received.set(req, { epoch: Date.now(), mono: performance.now() }); }
/** Preserve the signed declaration while bounding waits by elapsed monotonic admission time. */
export function compositeDeadlines(req: Request): { requested: number; effective: number } {
  const start = received.get(req); if (!start) return originalFailure();
  const declared = internalHeader(req.headers[DEADLINE_HEADER]);
  const epoch = internalDeadline(declared, start.epoch);
  const budget = Math.min(COMPOSITE_TIMEOUT_MS, Number(declared) - start.epoch);
  const remaining = budget - Math.max(0, performance.now() - start.mono);
  if (remaining <= 0) return originalFailure();
  return { requested: Number(declared), effective: Math.min(epoch, Date.now() + remaining) };
}
export function internalRefusal(res: ExpressResponse): void {
  res.status(403).set('Cache-Control', 'no-store').set('Connection', 'close').json({ error: 'internal_operation_refused' });
}
function exactHeaders(req: Request, primary: string): void {
  const allowed = new Set([primary, DEADLINE_HEADER]);
  for (const name of Object.keys(req.headers)) {
    if (name.toLowerCase().startsWith('x-gbrain-internal-') && !allowed.has(name.toLowerCase())) originalFailure();
  }
}
function invocation(base: CompositeInvocation | any, original: OriginalEnvelope, req: Request, proof: string, deadline: number): CompositeInvocation {
  return Object.freeze({ ...base, original, method: 'POST', path: req.originalUrl,
    credentialBinding: credentialBinding(internalHeader(req.headers.authorization)), proof, requestedDeadlineAt: deadline });
}
/** Called only after normal OAuth verification; the captured value is also handed to the SDK. */
export async function prepareCompositeChild(req: Request, loaded: LoadedLifecycle | undefined): Promise<{
  lifecycle: LoadedLifecycle; original: OriginalEnvelope; deadlineAt: number;
}> {
  if (!loaded?.host.composite || req.method !== 'POST' || req.originalUrl !== '/mcp') return originalFailure();
  exactHeaders(req, CAPABILITY_HEADER);
  const capability = internalHeader(req.headers[CAPABILITY_HEADER]);
  const firstDeadline = compositeDeadlines(req);
  const original = await readOriginalEnvelope(req, firstDeadline.effective, loaded.signal);
  const { requested, effective: deadlineAt } = compositeDeadlines(req);
  const composite = loaded.host.composite;
  const lifecycle: LoadedLifecycle = { ...loaded, host: { ...loaded.host,
    begin: async base => {
      if (base.operation.name !== original.params.name || Date.now() >= deadlineAt) return originalFailure();
      return composite.admitChild(invocation(base, original, req, '', requested), capability);
    },
  } };
  return { lifecycle, original, deadlineAt };
}
async function boundedResponse(response: globalThis.Response, deadline: number, signal: AbortSignal): Promise<globalThis.Response> {
  if (!response.body) return new globalThis.Response(null, { status: response.status, headers: response.headers });
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    while (true) {
      if (signal.aborted || Date.now() >= deadline) return originalFailure();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 131_072) return originalFailure();
      chunks.push(next.value);
    }
    return new globalThis.Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
  } finally { signal.removeEventListener('abort', cancel); cancel(); }
}
function dispatcher(endpoint: string, authorization: string, deadline: () => number,
  live: () => boolean, parentSignal: () => AbortSignal, fetchFn: typeof fetch): CompositeDispatch {
  const u = new URL(endpoint);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.pathname !== '/mcp' || u.search || u.hash || u.username || u.password) originalFailure();
  return async (body, capability, signal) => {
    if (!live() || !(signal instanceof AbortSignal) || signal.aborted) return originalFailure();
    parseOriginalEnvelope(body); internalHeader(capability);
    const end = deadline(), controller = new AbortController();
    const joined = AbortSignal.any([signal, parentSignal(), controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Internal operation request refused'));
      joined.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => controller.abort(), Math.max(0, end - Date.now()));
      if (joined.aborted) abort();
    });
    try {
      const work = (async () => {
        const response = await fetchFn(endpoint, { method: 'POST', redirect: 'manual', signal: joined,
          headers: { authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
            [CAPABILITY_HEADER]: capability, [DEADLINE_HEADER]: String(Math.floor(end)) }, body });
        return boundedResponse(response, end, joined);
      })();
      const response = await Promise.race([work, stopped]);
      if (!live() || joined.aborted || Date.now() >= end) return originalFailure();
      return response;
    } finally { clearTimeout(timer); joined.removeEventListener('abort', abort); controller.abort(); }
  };
}
/** One execute request. Admission is validated by the ordinary runner before deferred work starts. */
export async function executeCompositeHttp(req: Request, res: ExpressResponse, loaded: LoadedLifecycle | undefined,
  resource: string, endpoint: string, fetchFn: typeof fetch = fetch): Promise<void> {
  try {
    if (!loaded?.host.composite || req.method !== 'POST' || req.originalUrl !== COMPOSITE_PATH) return internalRefusal(res);
    exactHeaders(req, PROOF_HEADER);
    const auth = (req as any).auth as AuthInfo;
    if (!auth) return internalRefusal(res);
    const proof = internalHeader(req.headers[PROOF_HEADER]);
    const firstDeadline = compositeDeadlines(req);
    const original = await readOriginalEnvelope(req, firstDeadline.effective, loaded.signal);
    const { requested, effective: deadlineAt } = compositeDeadlines(req);
    const composite = loaded.host.composite;
    const descriptor = composite.operations.find(o => o.name === original.params.name);
    if (!descriptor || !hasScope(auth.scopes, descriptor.scope)) return internalRefusal(res);
    let execution: Extract<CompositeExecution, { kind: 'admitted' }> | undefined;
    let active = false, end = deadlineAt, parent: AbortSignal = loaded.signal;
    const dispatch = dispatcher(endpoint, internalHeader(req.headers.authorization), () => end,
      () => active && !parent.aborted && Date.now() < end, () => parent, fetchFn);
    const scoped: LoadedLifecycle = { ...loaded, host: { ...loaded.host,
      limits: { ...loaded.host.limits, operationTimeoutMs: Math.min(loaded.host.limits.operationTimeoutMs, COMPOSITE_TIMEOUT_MS),
        maxResponseBytes: Math.min(loaded.host.limits.maxResponseBytes, 131_072) },
      begin: async base => {
        parent = base.signal; end = Math.min(base.deadlineAt, deadlineAt);
        const result = await composite.execute(invocation(base, original, req, proof, requested), dispatch);
        if (result?.kind === 'admitted') {
          execution = result;
          if (typeof result.run !== 'function') {
            // The runner retains release authority before rejecting other admission fields.
            return { kind: 'admitted', admission: { ...result.admission, expiresAt: NaN } };
          }
        }
        return result;
      },
    } };
    const result = await runOperationRequest(scoped, resource, auth, req, res, async scope => {
      if (!scope) return originalFailure();
      const context: Pick<OperationContext, 'reportFailure' | 'deferAfterDelivery' | 'beforePageRead'> = {};
      await scope.begin(descriptor as Operation, { ...(original.params.arguments ?? {}) }, context);
      if (!execution || parent.aborted || Date.now() >= end) return originalFailure();
      active = true;
      try {
        return await execution.run(Object.freeze({ signal: parent,
          reportFailure: context.reportFailure!, deferAfterDelivery: context.deferAfterDelivery! }));
      } finally { active = false; }
    }, deadlineAt);
    if (!res.destroyed && !res.headersSent) res.set('Cache-Control', 'no-store').json({ jsonrpc: '2.0', id: original.id, result });
  } catch { if (!res.destroyed && !res.headersSent) internalRefusal(res); }
}
