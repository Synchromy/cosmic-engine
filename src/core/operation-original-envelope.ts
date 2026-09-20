import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const COMPOSITE_PATH = '/_internal/operation-host/v1/execute';
export const PROOF_HEADER = 'x-gbrain-internal-host-proof';
export const CAPABILITY_HEADER = 'x-gbrain-internal-parent-capability';
export const DEADLINE_HEADER = 'x-gbrain-internal-deadline';
export const ORIGINAL_BODY_BYTES = 65_536;
export const INTERNAL_HEADER_BYTES = 4096;
export const COMPOSITE_TIMEOUT_MS = 2000;
export type OriginalEnvelope = Readonly<Record<string, unknown> & {
  jsonrpc: '2.0'; id: string | number; method: 'tools/call';
  params: Readonly<Record<string, unknown> & { name: string; arguments?: Readonly<Record<string, unknown>> }>;
}>;
export function originalFailure(): never { throw new Error('Internal operation request refused'); }
export function canonicalOriginal(value: unknown, depth = 0): string {
  if (depth > 32) return originalFailure();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => canonicalOriginal(v, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalOriginal((value as any)[k], depth + 1)).join(',') + '}';
  }
  return originalFailure();
}
function deepFreeze(value: any): any {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
export function parseOriginalEnvelope(body: string): OriginalEnvelope {
  if (Buffer.byteLength(body) > ORIGINAL_BODY_BYTES) return originalFailure();
  let value: any;
  try { value = JSON.parse(body); } catch { return originalFailure(); }
  canonicalOriginal(value);
  if (!value || Array.isArray(value) || value.jsonrpc !== '2.0' || value.method !== 'tools/call'
    || !['string', 'number'].includes(typeof value.id) || (typeof value.id === 'number' && !Number.isFinite(value.id))
    || !value.params || Array.isArray(value.params) || typeof value.params !== 'object'
    || typeof value.params.name !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(value.params.name)
    || (value.params.arguments !== undefined && (!value.params.arguments || Array.isArray(value.params.arguments) || typeof value.params.arguments !== 'object'))) return originalFailure();
  return deepFreeze(value);
}
export function credentialBinding(authorization: string): string {
  if (!/^Bearer [^\s]+$/i.test(authorization) || authorization.length > INTERNAL_HEADER_BYTES) return originalFailure();
  return createHash('sha256').update('gbrain-operation-credential-v1\0').update(authorization).digest('hex');
}
export function internalHeader(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > INTERNAL_HEADER_BYTES) return originalFailure();
  return value;
}
/** This header only shortens a deadline; the host must bind it in its authenticated proof. */
export function internalDeadline(value: string | string[] | undefined, receivedAt: number): number {
  const text = internalHeader(value), n = Number(text);
  if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(n) || n <= Date.now()) return originalFailure();
  return Math.min(n, receivedAt + COMPOSITE_TIMEOUT_MS);
}
export function hasInternalHeaders(headers: Record<string, unknown>): boolean {
  return Object.keys(headers).some(k => k.toLowerCase().startsWith('x-gbrain-internal-'));
}
/** Capture before SDK normalization. Passing this object as parsedBody prevents a second stream parse. */
export async function readOriginalEnvelope(req: IncomingMessage, deadlineAt: number, signal?: AbortSignal): Promise<OriginalEnvelope> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const body = await new Promise<Buffer>((resolve, reject) => {
    let done = false;
    const fail = () => finish(new Error('Internal operation request refused'));
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', fail);
      signal?.removeEventListener('abort', fail);
      if (error) { req.pause(); reject(error); } else resolve(Buffer.concat(chunks, bytes));
    };
    const data = (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > ORIGINAL_BODY_BYTES || Date.now() >= deadlineAt) return fail();
      chunks.push(value);
    };
    const end = () => Date.now() >= deadlineAt ? fail() : finish();
    const timer = setTimeout(fail, Math.max(0, deadlineAt - Date.now()));
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', fail);
    signal?.addEventListener('abort', fail, { once: true });
    if (signal?.aborted || req.aborted || deadlineAt <= Date.now()) fail();
  });
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return originalFailure(); }
  return parseOriginalEnvelope(text);
}
