/** Explicit aliases of one logical OAuth resource. No route-specific token exchange. */
import { InvalidTargetError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export interface OAuthResourcePolicyInput {
  canonicalResource: string;
  aliases: string[];
  allowLegacyUnboundConfidential: boolean;
  allowLegacyAccessTokens: boolean;
}

function exactUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('OAuth resource must be an exact URL');
  const url = new URL(value);
  if (url.href !== value || url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('OAuth resource must be a normalized HTTPS or loopback URL without credentials, query or fragment');
  }
  return url;
}

export class OAuthResourcePolicy {
  readonly canonicalResource: string;
  readonly allowLegacyAccessTokens: boolean;
  readonly allowLegacyUnboundConfidential: boolean;
  private readonly resources: ReadonlySet<string>;

  constructor(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid OAuth resource policy');
    const value = input as OAuthResourcePolicyInput;
    const keys = Object.keys(value);
    if (keys.length !== 4 || keys.some(k => !['canonicalResource', 'aliases', 'allowLegacyUnboundConfidential', 'allowLegacyAccessTokens'].includes(k)) ||
        typeof value.allowLegacyUnboundConfidential !== 'boolean' || typeof value.allowLegacyAccessTokens !== 'boolean' ||
        !Array.isArray(value.aliases) || value.aliases.length > 16) throw new Error('Invalid OAuth resource policy fields');
    const canonical = exactUrl(value.canonicalResource);
    const aliases = value.aliases.map(exactUrl);
    if (new Set([canonical.href, ...aliases.map(url => url.href)]).size !== aliases.length + 1) throw new Error('OAuth resource aliases must be unique');
    if (aliases.some(url => url.origin !== canonical.origin)) throw new Error('OAuth resource aliases must share the canonical origin');
    this.canonicalResource = canonical.href;
    this.resources = new Set([canonical.href, ...aliases.map(url => url.href)]);
    this.allowLegacyAccessTokens = value.allowLegacyAccessTokens;
    this.allowLegacyUnboundConfidential = value.allowLegacyUnboundConfidential;
  }

  assertResource(resource: URL | string | null | undefined, client: {
    token_endpoint_auth_method?: string | null; client_secret?: string;
  }): void {
    const method = client.token_endpoint_auth_method ?? undefined;
    if (method !== undefined && !['none', 'client_secret_post', 'client_secret_basic'].includes(method)) throw new InvalidTargetError('Unknown client authentication method');
    if (method === undefined && !(typeof client.client_secret === 'string' && client.client_secret.length > 0)) throw new InvalidTargetError('Client authentication identity is missing');
    if (resource != null) {
      const value = typeof resource === 'string' ? resource : resource.href;
      if (!this.resources.has(value)) throw new InvalidTargetError('Resource is not accepted by this API');
      return;
    }
    const confidential = method === 'client_secret_post' || method === 'client_secret_basic' ||
      (method === undefined && typeof client.client_secret === 'string' && client.client_secret.length > 0);
    if (!confidential || !this.allowLegacyUnboundConfidential) throw new InvalidTargetError('A bound resource is required');
  }

  exchangeResource(stored: string | null | undefined, requested: URL | undefined, client: {
    token_endpoint_auth_method?: string | null; client_secret?: string;
  }): URL | undefined {
    this.assertResource(stored, client);
    if (requested !== undefined && requested.href !== stored) throw new InvalidTargetError('Resource must preserve the original grant');
    return stored == null ? undefined : new URL(stored);
  }
}

/** Absent config preserves legacy standalone behavior. Present invalid config never disables enforcement. */
export function resourcePolicyFromEnvironment(raw: string | undefined, publicUrl: string | undefined): OAuthResourcePolicy | undefined {
  if (raw === undefined) return undefined;
  if (!raw || Buffer.byteLength(raw) > 8192) throw new Error('Invalid OAuth resource policy length');
  if (!publicUrl) throw new Error('Configured OAuth resource policy requires a canonical public URL');
  const base = exactUrl(publicUrl.endsWith('/') ? publicUrl : publicUrl + '/');
  if (base.pathname !== '/' || ![base.origin, base.origin + '/'].includes(publicUrl)) throw new Error('Canonical public URL must be an origin');
  const policy = new OAuthResourcePolicy(JSON.parse(raw));
  if (policy.canonicalResource !== new URL('/mcp', base).href) throw new Error('OAuth resource policy does not match the canonical public URL');
  return policy;
}
