import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LifecyclePorts, OperationLifecycleHost } from './operation-lifecycle.ts';

export const LIFECYCLE_MODULE_ENV = 'GBRAIN_OPERATION_LIFECYCLE_MODULE';
export const LIFECYCLE_INIT_MS = 10_000;
export const LIFECYCLE_CLEANUP_MS = 5_000;
export interface LoadedLifecycle {
  readonly host: OperationLifecycleHost;
  readonly signal: AbortSignal;
  reportFailure(): void;
  shutdown(): Promise<void>;
}
export function positiveLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}
/** Bounds asynchronous waits; non-yielding trusted JS still needs process supervision. */
export async function boundedWait<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Lifecycle wait exceeded')), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function validHost(value: unknown): value is OperationLifecycleHost {
  const h = value as OperationLifecycleHost | null;
  return !!h && h.version === 1 && typeof h.begin === 'function' && typeof h.shutdown === 'function'
    && !!h.limits && positiveLimit(h.limits.operationTimeoutMs)
    && positiveLimit(h.limits.maxResponseBytes) && positiveLimit(h.limits.shutdownTimeoutMs);
}
export async function loadOperationLifecycle(
  path: string | undefined, ports: LifecyclePorts,
): Promise<LoadedLifecycle | undefined> {
  if (path === undefined) return undefined;
  const controller = new AbortController();
  let host: OperationLifecycleHost | undefined;
  let shutdownCandidate: (() => Promise<void>) | undefined;
  let abandoned = false;
  let cleanupPromise: Promise<void> | undefined;
  const report = (event: Parameters<LifecyclePorts['report']>[0]) => {
    try { ports.report(event); } catch { /* reporting never changes admission */ }
  };
  const cleanup = (): Promise<void> => {
    controller.abort();
    if (!shutdownCandidate) return Promise.resolve();
    if (!cleanupPromise) {
      const close = shutdownCandidate;
      cleanupPromise = boundedWait(Promise.resolve().then(close),
        Math.min(host?.limits.shutdownTimeoutMs ?? LIFECYCLE_CLEANUP_MS, LIFECYCLE_CLEANUP_MS))
        .catch(() => { report('cleanup_failure'); });
    }
    return cleanupPromise;
  };
  const initialize = async () => {
    if (!path || !isAbsolute(path) || !ports.resource) throw new Error('Invalid lifecycle configuration');
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) throw new Error('Invalid lifecycle file');
    // Trusted host configuration only. Runtime path keeps external modules external in compiled Bun.
    const module = await import(pathToFileURL(canonical).href);
    if (abandoned) throw new Error('Late module import');
    if (module.protocolVersion !== 1 || typeof module.createOperationLifecycleHost !== 'function') {
      throw new Error('Invalid lifecycle module');
    }
    const candidate: unknown = await module.createOperationLifecycleHost(Object.freeze({ ...ports, report }));
    // Even an invalid returned host may already own resources.
    if (candidate && typeof (candidate as OperationLifecycleHost).shutdown === 'function') {
      shutdownCandidate = (candidate as OperationLifecycleHost).shutdown.bind(candidate);
    }
    if (!validHost(candidate)) {
      if (abandoned) void cleanup();
      throw new Error('Invalid lifecycle host');
    }
    host = Object.freeze({
      version: 1 as const,
      limits: Object.freeze({ ...candidate.limits }),
      begin: candidate.begin.bind(candidate),
      shutdown: shutdownCandidate!,
    });
    if (abandoned) { void cleanup(); throw new Error('Late lifecycle initialization'); }
    report('initialized');
    return { host, signal: controller.signal, shutdown: cleanup, reportFailure: () => report('host_failure') };
  };
  try { return await boundedWait(initialize(), LIFECYCLE_INIT_MS); }
  catch {
    abandoned = true;
    await cleanup();
    throw new Error('Configured operation lifecycle could not initialize');
  }
}
