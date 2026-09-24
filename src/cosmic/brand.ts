/**
 * Cosmic's name on what this engine tells the outside (Synchromy/cosmic-hub#691).
 *
 * A Synchromy patch, carried permanently (cosmic/patches.json, `cosmic-brand`).
 * scripts/cosmic-brand.ts wires these functions into the few places engine
 * text leaves the process: tool and parameter descriptions, the catalog's
 * one-liners, the MCP handshake instructions, the server name, the protected
 * resource name, the error envelope, the remote put_page hint, and the prefix
 * of newly minted credentials.
 *
 * 🔴 INERT UNLESS COSMIC_BRAND IS SET. Unset, every function returns exactly
 * what it was given, so upstream's own tests, which pin descriptions and the
 * handshake byte for byte, keep passing on the rebuilt lane. The Cosmic hub
 * image sets it; nothing else does.
 *
 * WHAT THIS IS NOT: concealment. Tool names, parameters and response shapes
 * are unchanged, and anyone who knows the engine will still recognise it.
 * The aim is that a customer, and the agent they connect, meet the name
 * Cosmic in normal use.
 */

/** The product name, or null when branding is off. */
export function brandName(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.COSMIC_BRAND?.trim();
  return v ? v : null;
}

const CLI_REF = /`gbrain [a-z]|\bgbrain [a-z][a-z-]*\b(?= CLI| command)|\bCLI: `/i;
const ENV_OR_DOTFILE = /\bGBRAIN_[A-Z_]+\b|\.gbrain-source\b|\$GBRAIN_HOME\b|~\/\.gbrain\b/;

/** One sentence of engine prose, or null when the sentence only makes sense
 *  to someone holding the engine's own CLI or config: the customer's agent
 *  has neither, and telling it to run `gbrain doctor` sends it nowhere. */
function sentence(s: string, name: string): string | null {
  if (CLI_REF.test(s) || ENV_OR_DOTFILE.test(s)) return null;
  // A resource URI is an address, not prose: renamed, it points nowhere. The
  // contract's "Read gbrain://capabilities (or whoami when available)" keeps
  // its meaning as "Read whoami", which every connection can call.
  s = s.replace(/\bgbrain:\/\/[\w/-]+\s*\(or (\w+) when available\)/gi, '$1');
  if (/\bgbrain:\/\//i.test(s)) return null;
  return s
    // Engine release markers: "v0.40.6.0: ", "(v0.39.3.0)", "v0.29.1 recency boost".
    .replace(/\(\s*v\d+\.\d+(?:\.\d+){0,2}\s*\)/g, '')
    .replace(/\bv\d+\.\d+(?:\.\d+){0,2}(?:\s*(?:—|-|:))?\s*/g, '')
    // Upstream issue references: "(#4433)", "#2225: ".
    .replace(/\s*\(#\d{3,5}(?:,\s*#\d{3,5})*\)/g, '')
    .replace(/#\d{3,5}:?\s*/g, '')
    // The name itself. The bare word only: `gbrain_cl_…` is an identifier.
    .replace(/\bgbrain-native\b/gi, 'native')
    .replace(/(?<![\w-])gbrain(?![\w-])/gi, name)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Engine prose as a customer's agent should read it. */
export function brandText(text: string, env: Record<string, string | undefined> = process.env): string {
  const name = brandName(env);
  if (!name || !text) return text;
  // Paragraphs keep their breaks; sentences inside them are judged one by one.
  return text
    .split('\n')
    .map((line) => {
      const lead = /^\s*(?:[-*]|\d+\.)\s+/.exec(line)?.[0] ?? '';
      const kept = line.slice(lead.length)
        .split(/(?<=[.!?])\s+(?=[A-Z`(])/)
        .map((s) => sentence(s, name))
        .filter((s): s is string => !!s);
      if (!kept.length) return line.trim() ? null : line;
      return lead + kept.join(' ');
    })
    .filter((l): l is string => l !== null)
    .join('\n');
}

/** The MCP server name. */
export function brandServerName(original: string, env: Record<string, string | undefined> = process.env): string {
  const name = brandName(env);
  return name ? name.toLowerCase() : original;
}

/** The protected resource's display name. */
export function brandResourceName(original: string, env: Record<string, string | undefined> = process.env): string {
  return brandName(env) ?? original;
}

/** The prefix for a newly minted credential: `gbrain_cl_` becomes `cosmic_cl_`.
 *  Only NEW credentials change. Stored credentials are hashes of the whole
 *  string and client ids are looked up exactly, so every credential already
 *  issued keeps working; `isCredential` below accepts both forever. */
export function credentialPrefix(original: string, env: Record<string, string | undefined> = process.env): string {
  const name = brandName(env);
  if (!name) return original;
  return original.replace(/^gbrain_/, 'cosmic_');
}

/** The prefixes a credential may carry: the engine's own and Cosmic's. Fixed,
 *  not derived from COSMIC_BRAND, so an auth check never widens with config. */
export const CREDENTIAL_PREFIXES = ['gbrain_', 'cosmic_'] as const;

/** Does `value` carry this credential kind's prefix, old or new? `kind` is the
 *  engine's own prefix (`gbrain_cl_`). Both forms are accepted whatever the
 *  current setting is, so turning branding off never strands a credential. */
export function isCredential(value: string, kind: string): boolean {
  const rest = kind.replace(/^gbrain_/, '');
  return CREDENTIAL_PREFIXES.some((p) => value.startsWith(p + rest));
}
