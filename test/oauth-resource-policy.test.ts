import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { OAuthResourcePolicy, resourcePolicyFromEnvironment } from '../src/core/oauth-resource-policy.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { hashToken } from '../src/core/utils.ts';

const canonical = 'https://api.example/mcp';
const alias = 'https://api.example/skills/mcp';
const input = { canonicalResource: canonical, aliases: [alias],
  allowLegacyUnboundConfidential: true, allowLegacyAccessTokens: true };
const policy = new OAuthResourcePolicy(input);

describe('configured logical API resource policy', () => {
  test('absent config preserves standalone compatibility', () => {
    expect(resourcePolicyFromEnvironment(undefined, undefined)).toBeUndefined();
  });
  test('configured env requires canonical public address and mandatory explicit compatibility', () => {
    expect(() => resourcePolicyFromEnvironment(JSON.stringify(input), undefined)).toThrow();
    expect(() => resourcePolicyFromEnvironment(JSON.stringify(input), 'https://other.example')).toThrow();
    expect(() => resourcePolicyFromEnvironment('', 'https://api.example')).toThrow();
    expect(resourcePolicyFromEnvironment(JSON.stringify(input), 'https://api.example')?.canonicalResource).toBe(canonical);
    expect(() => new OAuthResourcePolicy({canonicalResource:canonical,aliases:[]})).toThrow();
    for (const base of ['https://user@api.example','https://api.example/path','https://api.example?x','https://api.example#x','https://API.example'])
      expect(() => resourcePolicyFromEnvironment(JSON.stringify(input),base)).toThrow();
    expect(() => resourcePolicyFromEnvironment(' '.repeat(8193),'https://api.example')).toThrow();
    expect(() => new OAuthResourcePolicy({...input, aliases:[alias,alias]})).toThrow();
    expect(() => new OAuthResourcePolicy({...input, aliases:[canonical]})).toThrow();
    expect(() => new OAuthResourcePolicy({...input, aliases:['https://api.example/'+'x'.repeat(4096)]})).toThrow();

  });
  test.each(['https://foreign.example/mcp', 'https://api.example/mcp?x=1', 'https://api.example/mcp#x',
    'https://user@api.example/mcp', 'https://API.example/mcp', 'http://api.example/mcp'])('rejects invalid alias %s', value => {
    expect(() => new OAuthResourcePolicy({...input, aliases:[value]})).toThrow();
  });
  test('loopback HTTP supports isolated operation only', () => {
    expect(new OAuthResourcePolicy({...input, canonicalResource:'http://127.0.0.1:3456/mcp',
      aliases:['http://127.0.0.1:3456/skills/mcp']}).canonicalResource).toContain('127.0.0.1');
  });
});

let db: PGlite;
let sql: (s: TemplateStringsArray, ...v: unknown[]) => Promise<any>;
let provider: GBrainOAuthProvider;
let unconfigured: GBrainOAuthProvider;
beforeAll(async () => {
  db = new PGlite({extensions:{vector,pg_trgm}});
  await db.exec(PGLITE_SCHEMA_SQL);
  sql = async (s,...v) => (await db.query(s.reduce((q,t,i)=>q+t+(i<v.length?'$'+(i+1):''),''),v as any[])).rows;
  provider = new GBrainOAuthProvider({sql, resourcePolicy:policy});
  unconfigured = new GBrainOAuthProvider({sql});
}, 30_000);
afterAll(async () => { await db.close(); }, 15_000);

async function client(publicClient=true) {
  const made=await provider.registerClientManual('synthetic-resource', ['authorization_code','refresh_token'], 'read write',
    ['http://127.0.0.1/callback'], 'default', undefined, publicClient?'none':'client_secret_post');
  return (await provider.clientsStore.getClient(made.clientId))!;
}
async function code(c:any, resource:string|null=canonical, p=provider) {
  let redirect='';
  await p.authorize(c,{codeChallenge:'synthetic',redirectUri:'http://127.0.0.1/callback',
    scopes:['read'], ...(resource===null?{}:{resource:new URL(resource)})},
    {redirect:(url:string)=>{redirect=url}} as any);
  return new URL(redirect).searchParams.get('code')!;
}
async function mint(c:any, resource=canonical) {
  return provider.exchangeAuthorizationCode(c,await code(c,resource),undefined,'http://127.0.0.1/callback',new URL(resource));
}

describe('real provider resource boundaries', () => {
  test.each([canonical,alias])('accepted alias survives code and refresh omission: %s', async resource=>{
    const c=await client();
    const tokens=await provider.exchangeAuthorizationCode(c,await code(c,resource));
    expect((await provider.verifyAccessToken(tokens.access_token)).resource?.href).toBe(resource);
    const refreshed=await provider.exchangeRefreshToken(c,tokens.refresh_token!);
    const auth=await provider.verifyAccessToken(refreshed.access_token);
    expect(auth.resource?.href).toBe(resource);expect(auth.clientId).toBe(c.client_id);
    expect(auth.scopes).toEqual(['read']);expect((auth as any).sourceId).toBe('default');
  });
  test('foreign and null public authorization refused before code issuance', async()=>{
    const c=await client();
    await expect(code(c,'https://foreign.invalid/mcp')).rejects.toThrow();
    await expect(code(c,null)).rejects.toThrow();
    const rows=await db.query('SELECT * FROM oauth_codes WHERE client_id=$1',[c.client_id]);
    expect(rows.rows.length).toBe(0);
  });
  test('invalid concurrent code substitutions cannot consume legitimate code', async()=>{
    const c=await client(), issued=await code(c);
    const attempts=await Promise.allSettled([
      provider.exchangeAuthorizationCode(c,issued,undefined,undefined,new URL(alias)),
      provider.exchangeAuthorizationCode(c,issued,undefined,undefined,new URL('https://foreign.invalid/mcp')),
      provider.exchangeAuthorizationCode(c,issued),
    ]);
    expect(attempts.filter(r=>r.status==='fulfilled').length).toBe(1);
    expect(attempts[2].status).toBe('fulfilled');
  });
  test('invalid concurrent refresh substitutions cannot consume legitimate refresh', async()=>{
    const c=await client(), tokens=await mint(c);
    const attempts=await Promise.allSettled([
      provider.exchangeRefreshToken(c,tokens.refresh_token!,undefined,new URL(alias)),
      provider.exchangeRefreshToken(c,tokens.refresh_token!,undefined,new URL('https://foreign.invalid/mcp')),
      provider.exchangeRefreshToken(c,tokens.refresh_token!),
    ]);
    expect(attempts.filter(r=>r.status==='fulfilled').length).toBe(1);
    expect(attempts[2].status).toBe('fulfilled');
  });
  test('wrong callback still preserves valid code',async()=>{
    const c=await client(), issued=await code(c);
    await expect(provider.exchangeAuthorizationCode(c,issued,undefined,'http://127.0.0.1/wrong')).rejects.toThrow();
    const tokens=await provider.exchangeAuthorizationCode(c,issued,undefined,'http://127.0.0.1/callback');
    expect((await provider.verifyAccessToken(tokens.access_token)).clientId).toBe(c.client_id);
  });
  test.each([null,'https://foreign.invalid/mcp'])('preexisting public resource %s cannot use colliding legacy fallback',async resource=>{
    const c=await client(),tokens=await mint(c);
    await db.query('UPDATE oauth_tokens SET resource=$1 WHERE token_hash=$2',[resource,hashToken(tokens.access_token)]);
    await db.query("INSERT INTO access_tokens(token_hash,name,scopes) VALUES($1,'synthetic-legacy',ARRAY['read'])",[hashToken(tokens.access_token)]);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    expect((await unconfigured.verifyAccessToken(tokens.access_token)).clientId).toBe(c.client_id);
  });
  test('confidential unbound compatibility is explicit and cannot admit public null',async()=>{
    const c=await client(false);
    const issued=await code(c,null);
    const tokens=await provider.exchangeAuthorizationCode(c,issued);
    expect((await provider.verifyAccessToken(tokens.access_token)).resource).toBeUndefined();
    const strict=new GBrainOAuthProvider({sql,resourcePolicy:new OAuthResourcePolicy({...input,allowLegacyUnboundConfidential:false})});
    await expect(strict.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });
  test('legacy access_tokens compatibility is separately explicit',async()=>{
    const token='synthetic-legacy-only';
    await db.query("INSERT INTO access_tokens(token_hash,name,scopes) VALUES($1,'synthetic-old',ARRAY['read'])",[hashToken(token)]);
    expect((await provider.verifyAccessToken(token)).clientId).toBe('synthetic-old');
    const strict=new GBrainOAuthProvider({sql,resourcePolicy:new OAuthResourcePolicy({...input,allowLegacyAccessTokens:false})});
    await expect(strict.verifyAccessToken(token)).rejects.toThrow();
  });
  test('revoked client and narrowed source remain enforced',async()=>{
    const c=await client(),tokens=await mint(c);
    await db.query("INSERT INTO sources(id,name) VALUES('alpha','Synthetic alpha')");
    await provider.rescopeClient(c.client_id,{sourceId:'alpha',federatedRead:['alpha']});
    expect((await provider.verifyAccessToken(tokens.access_token) as any).allowedSources).toEqual(['alpha']);
    await db.query('DELETE FROM oauth_clients WHERE client_id=$1',[c.client_id]);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });
  test('actual SQL NULL auth method requires a stored confidential secret',async()=>{
    const publicClient=await client(),publicTokens=await mint(publicClient);
    await db.query('UPDATE oauth_clients SET token_endpoint_auth_method=NULL WHERE client_id=$1',[publicClient.client_id]);
    await expect(provider.verifyAccessToken(publicTokens.access_token)).rejects.toThrow();
    const confidential=await client(false),tokens=await mint(confidential);
    await db.query('UPDATE oauth_clients SET token_endpoint_auth_method=NULL WHERE client_id=$1',[confidential.client_id]);
    expect((await provider.verifyAccessToken(tokens.access_token)).clientId).toBe(confidential.client_id);
  });

});
