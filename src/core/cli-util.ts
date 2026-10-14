import type { Operation } from './ops/contract.ts';

/**
 * Legacy home of the shared prompt helpers. They live in
 * `src/core/interaction.ts` now (agent operator wave A5); these re-exports
 * stay for one release with unchanged return contracts:
 *   - promptLine(prompt): string (trimmed line; '' on EOF/timeout, no longer hangs)
 *   - promptLineStderr(prompt, {timeoutMs}): string | null (null on EOF/timeout)
 * New code: use readLine() from interaction.ts.
 */
export { promptLine, promptLineStderr } from './interaction.ts';

/**
 * Coerce one raw CLI flag value to the operation param's declared type.
 * Structured (`object` / `array`) params parse as JSON so a CLI caller can
 * pass the same shapes MCP callers do; a malformed value or the wrong
 * top-level shape is an error rather than a string stored as a character map.
 */
export function parseTypedOpArg(
  key: string,
  type: Operation['params'][string]['type'],
  raw: string,
): unknown {
  if (type === 'boolean') return raw !== 'false';
  if (type === 'number') return Number(raw);
  if (type !== 'object' && type !== 'array') return raw;
  // Array-valued ops predate JSON CLI input and document comma-delimited
  // flag values. Preserve that wire shape unless the operator explicitly
  // supplies a JSON array. Individual
  // operation boundaries remain responsible for accepting or rejecting the
  // legacy string form.
  if (type === 'array' && !raw.trimStart().startsWith('[')) {
    if (raw.trimStart().startsWith('{')) {
      throw new Error(`--${key.replace(/_/g, '-')} requires a JSON array.`);
    }
    return raw;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--${key.replace(/_/g, '-')} requires valid JSON ${type}.`);
  }
  if (type === 'array' ? !Array.isArray(parsed) : parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`--${key.replace(/_/g, '-')} requires a JSON ${type}.`);
  }
  return parsed;
}
