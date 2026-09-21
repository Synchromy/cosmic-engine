/**
 * Optional host-owned admission policy for operations and background entry points.
 * This is not a database write barrier: already admitted handlers, incidental
 * read bookkeeping and unguarded direct writers are outside this gate.
 */
import { openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { OperationError, type Operation } from './ops/contract.ts';

const MAX_POLICY_BYTES = 4096;
const wrapped = new WeakSet<Operation>();

export function allowsMutation(): boolean {
  const path = process.env.GBRAIN_MUTATION_POLICY_FILE;
  if (path === undefined) return true;
  let fd: number | undefined;
  try {
    // Nonblocking open prevents a mistakenly configured FIFO from hanging the
    // caller. Only regular files are accepted; reads remain strictly bounded
    // even if another process changes the file after fstat.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_POLICY_BYTES) return false;
    const bytes = Buffer.alloc(MAX_POLICY_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_POLICY_BYTES) return false;
    const policy: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return false;
    const object = policy as Record<string, unknown>;
    return Object.keys(object).length === 2 && object.version === 1 && object.mutations === 'allow';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* a close failure never replaces the refusal */ }
    }
  }
}

/** Conservative unless the contract explicitly identifies a read/inspection. */
export function requiresMutationAdmission(op: Pick<Operation, 'scope' | 'mutating'>): boolean {
  if (op.mutating !== undefined) return op.mutating;
  return op.scope !== 'read';
}

/**
 * Preserve object identity so existing registry consumers and nested references
 * share the same guard. Never use caller params, auth or dryRun as a bypass.
 */
export function guardOperations(operations: Operation[]): void {
  for (const op of operations) {
    if (wrapped.has(op)) continue;
    const handler = op.handler;
    op.handler = async (ctx, params) => {
      if (requiresMutationAdmission(op) && !allowsMutation()) {
        throw new OperationError(
          'read_only',
          'Mutations are currently disabled by the operator.',
          'Read and export remain available. Contact the operator to restore mutation access.',
        );
      }
      return handler(ctx, params);
    };
    wrapped.add(op);
  }
}
