# Configured OAuth API resources

**Say to your agent:** "Configure my native agent connection to use only this server's approved API addresses." Your agent sets the shared resource policy before enabling native onboarding.

Set `GBRAIN_OAUTH_RESOURCE_POLICY` to a JSON object, alongside the canonical `serve --http --public-url` address:

```json
{
  "canonicalResource": "https://brain.example/mcp",
  "aliases": ["https://brain.example/skills/mcp"],
  "allowLegacyUnboundConfidential": true,
  "allowLegacyAccessTokens": true
}
```

Aliases are explicit addresses for one logical API. They are not independent audiences or permission grants. Use only aliases actually served by this deployment. The generic engine does not require a skills endpoint; an empty aliases array is valid.

The canonical resource must match the configured public origin plus `/mcp`. All addresses must be exact normalized HTTPS URLs on the same origin, without credentials, query or fragment. Loopback HTTP is supported for isolated local operation. Duplicate aliases are rejected. Both compatibility booleans are required.

With policy configured, public clients must request a bound resource. Authorization codes and refresh tokens retain that resource when the request omits it; an explicit different resource is refused without consuming the valid credential. Token verification enforces the policy on every use. Source, scope, client identity and revocation checks remain independent requirements.

`allowLegacyUnboundConfidential` explicitly permits existing confidential OAuth credentials without a resource. `allowLegacyAccessTokens` separately permits the older access-token table. Neither flag allows an unbound public OAuth credential. Disable each compatibility path when its existing users have migrated. Unknown client authentication methods and missing methods without a stored secret are refused.

Unset configuration preserves existing standalone behavior. A configured invalid policy fails startup; it never silently falls back. Native onboarding must not be advertised as resource-enforced until both the engine and any separate gateway credential verifier run compatible policy code with identical configuration. This change does not configure a deployment, migrate clients, or implement separate-resource token exchange.
