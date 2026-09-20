# Optional composite host operations

A reviewed host module can expose bounded composite operations through an optional `composite.version: 1` port on the existing lifecycle v1 host. This does not change the native operation registry or load a second module. An absent extension leaves ordinary native tools unchanged; malformed advertised extensions refuse startup.

The separate registry contains unique read-only descriptors that do not collide with native operations. `execute(invocation, dispatch)` returns a refusal or an existing admission plus deferred `run(outcomeContext)`. Setup can validate host authority and acquire admission. It cannot dispatch children. The ordinary runner validates admission before running orchestration, applies trusted producer failures and authorizes the final immutable result before scheduling effects.

The engine retains the caller's Authorization value in a fixed loopback dispatcher. The module receives only a domain-separated credential binding and verified principal projection. Every child still enters the normal OAuth and native authorization path. A host-provided child capability is verified through `admitChild`; failure never falls back to ordinary admission.

Requests carrying child authority are captured with a 64 KiB byte bound before SDK schema normalization. The same immutable parsed value is supplied to the SDK and host admission. Accepted metadata and argument extensions remain part of that value. Unsupported top-level RPC extensions still receive the SDK's normal strict rejection. The optional deadline header only shortens the engine's 2s ceiling; the host must authenticate it together with its proof/capability and enforce its parent's deadline. An untrusted header never extends authority.

The host owns proof authentication, replay prevention, parent liveness and any accounting. This generic engine extension supplies none of those policies automatically. It is not a privileged dispatch bypass or a complete host activation. Public reverse proxies must deny the internal operation-host namespace and strip reserved internal headers on all engine forwarding paths before this extension is enabled.

`test/operation-composite.test.ts` covers port validation, admission ordering, original-envelope bounds and lifecycle failures. `test/operation-composite-http.test.ts` uses a disposable synthetic PGLite database and actual source server. Set `GBRAIN_TEST_COMPOSITE_BIN` to an explicitly built local binary to exercise the same fixture through the compiled server. Tests use synthetic capability verification; application-level signing and parent accounting require the separate host integration tests.

Say to your agent: “Review the configured host's composite authorization and lifecycle evidence before enabling its optional composite operations. Preserve existing authentication and request bounds.”
