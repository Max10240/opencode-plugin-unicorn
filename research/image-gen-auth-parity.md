# image-gen and chat request authentication parity

**English** | [简体中文](image-gen-auth-parity.zh-CN.md)

Initial research: 2026-10-17. Review: 2026-10-20. The experiment table preserves conclusions from before the fix.
No real credentials were read and no paid model was called.

## Implementation status

Configuration authentication, anonymous deployments, connection priority, variants, and native-factory HTTP/auth
mapping were fixed within the image-gen plugin only. Core was not modified; the R7 session-hook limitation remains.
The reproduction entry point now runs the formal
[`auth-e2e.test.ts`](../packages/opencode-plugin-image-gen/test/auth-e2e.test.ts), which asserts the fixed success
path, keeps the missing-signature-hook failure assertion, and adds native custom-factory signature tests.

### Review fixes and evidence

- Meta/ZAI are not in Core's anonymous-auth coverage set (`model-resolver.ts:423-458`), so explicitly enabling them
  must not silently switch to `Auth.none`. Auth captures use synthetic environment keys for both the root entry and
  language sub-entry; the sub-entry reuses the same image adapter family.
- OAuth parameters follow Core's exact package mapping (`:303-314`) instead of guessing from custom package names.
  `test/deployment.test.ts` covers custom packages whose names contain provider keywords.
- SDK `2.0.15` `route/media.js:28-30` applies endpoint query before HTTP query. Both are preserved in that order, with
  assertions in deployment unit tests and native-factory signature captures. Unresolved URLs returned by factories
  are rejected.
- JSON overlay reads own properties only; `test/overlay.test.ts` covers `constructor`, `toString`, and `__proto__`
  without mutating the source configuration.
- `test/setup.test.ts` verifies registration URL override priority, OAuth metadata isolation, generation without a
  signal on older runtimes, and no output file when a signal cancels. Mid-generation and mid-download cancellation
  have separate HTTP tests.
- The current `@opencode/plugin 2.0.10` Promise adapter does not pass a cancellation signal to tools
  (`dist/promise/adapter.js:444-447`). The plugin supports an optional signal and does not claim remote cancellation
  on older runtimes.

2026-10-20 review additions:

- `model.test.ts` reproduces and covers a bare-model variant containing `/` being mistaken for a provider; the parser
  now separates the variant first.
- `deployment.test.ts` covers a canonical provider receiving both language and image factories without being
  overridden by stale settings.
- Shared E2E servers and auth subprocesses use environment allowlists; `e2e-environment.test.ts` verifies that real
  keys, proxies, config overrides, and preload scripts are not inherited while explicit self-config test options
  still work.
- `v2.1.0` rejects the old image SDK import `effect/dist/unstable/http/index.js`; the minimum image SDK version is now
  `2.1.1`. Other plugin SDK minimums, Core, and global configuration are unchanged.
- The new OpenAI image decoder expects `b64_json`. `openai-image-result.ts` also accepts URL/data URL results and null
  optional metadata: it only parses responses that were already received, never retries generation, and never changes
  authentication. Schema validation rejects invalid data and auth errors. `openai-images.test.ts` covers
  generation/editing, nullable responses, URL download, auth not being forwarded, and download cancellation;
  `openai-image-result.test.ts` covers parsing boundaries.
- `auth-e2e.test.ts` adds `header-only-edit` and `header-only-rejected`: real OpenCode sends a multipart reference
  image and a local gateway verifies Basic/X-API-Key. Rejected auth produces exactly one image request, a tool error,
  and no output file.

`bun run check` passes on `v2.1.0` and isolated `v2.0.21` with 238 tests and 0 failures (211 original, 27 added for
test optimization regressions), including six-package typecheck, real npm tarball installation, and TUI/Unicorn
regressions. Three additional isolation/cleanup tests run separately, and auth capture entries were re-run on both
versions.

2026-10-28 review additions:

- `@opencode/ai` was upgraded to `2.2.0`: the Promise client uses `make()`, `Media`/`ImageModel`/`LanguageModel` are
  imported from `@opencode/ai/effect`, and image requests use `aspect`/`resolution`/`providerOptions`.
- 2.2.0 no longer reads `mime_type` from response items. When `output_format` is missing, the plugin identifies the
  bytes first and falls back to the requested PNG format. `openai-image-result.ts` continues to handle null metadata
  and URL/data URL results.
- `npm run check` passes, including 119 image-plugin tests and packaged E2E.

## Validation scope

- Original capture server: `opencode v2.0.21`; review also validates `v2.1.0`.
- Original capture dependencies: `@opencode/plugin 2.0.10`, `@opencode/ai 2.0.15`; the current image SDK is `2.2.0`,
  with a direct `effect ^4.0.1` dependency for compatible response schema validation.
- OpenCode reference source: commit `07501ee86740ae1cef97f1c43819f3b98d783fd6`; referenced source files had no
  workspace changes.
- Reference source and the installed binary are not the same version. The experiment table only claims the
  binary/SDK versions above; upstream behavior is validated separately with source and upstream unit tests.
- All captures occur between isolated HOME/config/database and localhost services. Keys, Basic headers, and HMAC
  secrets are synthetic test data.
- Prefer the isolated entry point below: it builds the current source, allowlists environment variables, and does not
  inherit accounts, proxies, or config overrides. On macOS, `sandbox-exec` restricts outbound connections to
  localhost. Other platforms do not have that OS network restriction but still use a temporary HOME and local
  endpoints.
- On Unix, failures, timeouts, and SIGINT/SIGTERM clean up child process groups and temporary HOME; Windows cleans up
  direct children only, and process-tree cleanup is not verified. Probes set synthetic variables inside the test
  server only.

## Verified conclusions and experiments

Experiment code: [`image-gen-auth-parity.test.ts`](./image-gen-auth-parity.test.ts). Each experiment compares actual
network requests or asserts the current failure point.

| ID / test | Normal chat | image_gen before the fix | Conclusion |
| --- | --- | --- | --- |
| R1 `header-only` | No active connection, but configured Basic Authorization and X-API-Key complete the chat | `No active credential found`; no image HTTP request | Header auth cannot require a credential to exist. |
| R2 `inline-key` | No active connection; `settings.apiKey` produces a Bearer header | Fails before sending the request | A configured apiKey is a valid auth source, not only a saved credential. |
| R3 `anonymous` | An explicitly configured provider with no Authorization completes the chat | Fails before sending the request | Unauthenticated endpoints are valid deployments and must not be forced to use a token. |
| R4 `declared-env` | Test variables declared by `provider.env` resolve to a key through the connection API | Bearer matches chat; image succeeds | The existing connection API already covers declared env vars; do not search for credential files manually. |
| R5 `saved-key` | A saved test key overrides a different configured apiKey | Uses the saved key; image succeeds | settings.apiKey must not always win; preserve Core connection selection and priority. |
| R6 `variant` | Uses the premium variant URL, headers, and body | Uses base model URL/headers/body; variant is lost | The model catalog is not the full runtime configuration of a selected variant. |
| R7 `signed-hook` | `model.request` rewrites the URL; `http.request` signs method/URL/body with synthetic HMAC and the service verifies it | Does not enter those session hooks; original URL, no signature, service returns 401 | Copying catalog parameters or previous chat headers cannot reuse request-level auth. |
| R8 `organization` | Native OpenAI factory turns organization/project into HTTP headers | Image request lacks both headers | Calling `configure().image()` bypasses the normal chat `model()` factory settings mapping. |
| R9 `implicit-default` | The session uses a custom provider and its key | Without a tool model, falls back to the OpenAI provider and default image model | Auth and target-provider selection are separate issues; the default provider does not follow the session. The experiment also redirects the OpenAI endpoint to localhost. |
| R10 `making credentials optional alone...` | Standalone image SDK call | Omitting the token lets settings.apiKey be overwritten by undefined; the SDK uses synthetic OPENAI_API_KEY and overrides configured Basic auth | Removing the "no credential" error is insufficient; custom providers must not unconditionally fall back to OpenAI environment auth. |
| R11 `SDK feasibility: reuse a provider model's prepared HTTP/auth context...` | Native `model()` factory prepares context first | Uses prepared auth, headers, HTTP body/query, and baseURL on a known-compatible image route; synthetic key, organization/project, custom headers, query/body all match | The SDK can reuse runtime auth objects; it is not limited to passing token strings. |
| R12 `SDK feasibility: transferring Auth.Definition...` | Builds a runtime auth object with synthetic dynamic signatures | Image requests use the same Auth.Definition and re-sign their own URL/body; verification succeeds | Reuse auth behavior, not the final signature of a previous request. |

The same experiments also confirm:

- Provider/model headers and nested bodies are already merged by Core, and header name merging is case-insensitive;
  catalog probes still describe the base model without the current variant.
- `queryParams` is not a universal "always becomes URL query" setting: the native OpenAI factory maps it, the
  openai-compatible factory does not, and the old image fallback treated everything as OpenAI. Respect the target
  package's semantics.
- Normal chat includes `x-opencode-session-id`; the old image call did not. This is session correlation, not an auth
  credential.
- In runtime probes, `ctx.model.resolve`, `ctx.model.resolveImage`, and `ctx.generate.image` were all undefined. They
  are not existing plugin APIs.

## How normal chat actually works: source evidence

Paths are relative to the OpenCode source tree.

| Stage | Evidence |
| --- | --- |
| A configured provider can be enabled without a saved key | `packages/core/src/config/plugin/provider.ts:54-74` sets activation=enabled and merges settings/headers/body. |
| provider → model merge | `packages/core/src/model.ts:190-200`; `packages/core/src/provider.ts:147-179` implement deep merge and case-insensitive header overrides. |
| Variant overrides | `packages/core/src/model-resolver.ts:137-160`; `packages/core/src/session/runner/model.ts:90` passes `session.model.variant` to the resolver. |
| Select integration connection | `packages/core/src/model-resolver.ts:359-370` calls active/resolve from provider.integrationID/providerID. With no connection, credential is undefined instead of rejecting immediately. |
| Env vars, saved credentials, OAuth refresh | `packages/core/src/integration.ts:369-382,692-713`; active connections include saved credentials and declared env, and resolve refreshes when needed. |
| Prepare runtime provider | `packages/core/src/model-resolver.ts:196-251` merges config/credential parameters, then calls `package.model()`; it does not inject a token into every provider's apiKey. |
| Auth types are not uniform | `packages/core/src/model-resolver.ts:303-314`: keys use apiKey; some OAuth flows use authToken or accessToken. |
| Key metadata vs OAuth metadata | `packages/core/src/model-resolver.ts:254-262`: key metadata may merge into the request body; OAuth metadata does not. Do not treat all metadata the same. |
| Explicit unauthenticated deployments | `packages/core/src/model-resolver.ts:374-379,417-458` use Auth.none for qualifying API-key providers. |
| Package-specific settings mapping | `packages/ai/src/providers/openai.ts:136-167` and `packages/ai/src/providers/openai-compatible.ts:48-59` are different mapping functions. |
| Session headers, model hook, HTTP hook | `packages/core/src/session/model-request.ts:275-317,334-362`. HTTP hooks are execution middleware and are not in the catalog. |
| Auth can be a function, not only a string | `packages/ai/src/route/auth.ts:20-40,68-71,106-113`; AuthInput contains method/URL/body, and Auth.custom can generate headers per request. |
| SDK image requests can use auth/HTTP context | R11/R12 sent real requests; the current SDK is `@opencode/ai/dist/providers/openai.js:47-52`. |

Upstream unit tests run:

```sh
cd <opencode-source>/packages/core
bun test test/model-resolver.test.ts
bun test test/integration.test.ts
```

Result: 45 + 16 tests passed, 0 failed. Coverage includes configured/stored key priority, empty keys, explicit
enablement without a key, variants, OAuth parameter mapping, and credential/env connections.
`model-resolver.test.ts:711-753` asserts that key metadata may enter the body while OAuth metadata does not;
`:911-947` verifies OAuth parameter names for different packages. These use synthetic credentials and do not
represent real OAuth, ADC, AWS, or Azure accounts.

## Deviations in the old plugin: repository evidence

Paths and line numbers refer to pre-fix commit `ee5a328`, not the current implementation. Fixes live in image-gen's
`deployment.ts`, `credential.ts`, `model.ts`, and `overlay.ts`.

- `packages/opencode-plugin-image-gen/src/credential.ts:11-31` returned a value only for an active connection or an
  OpenAI environment key, otherwise threw. It did not read `auth.json`; the problem was making a connection mandatory.
- `src/index.ts:50-76` required resolveCredential first; metadata/configuration only expanded into settings, and HTTP
  hooks were not passed from Core to the image client.
- `src/model.ts:22-35,46-49` removed `#variant` without applying variant overlays and used a fixed OpenAI default when
  no model was specified.
- `src/openai-images.ts:74-83` always wrote `apiKey:request.token`, overriding settings.apiKey, and called
  `configure().image()` without the normal `package.model()` mapping.
- `src/openai-images.ts:125-138` could fall back to OpenAI for unknown packages or openai-compatible endpoints based
  only on baseURL. R8/R10 and query captures show this is not lossless.

## Implementation guidance

### Semantics to preserve

1. Resolve the target image provider/model/variant explicitly; never mix in another session model or provider key.
2. Reuse Core's provider/model/variant merge, active-connection selection, and credential resolve. No connection does
   not mean no auth or an error.
3. Preserve package-native auth and settings mapping: configured keys, header-only auth, anonymous deployments,
   `provider.env`, saved keys/OAuth, and native dynamic auth.
4. On a compatible image protocol, reuse the prepared auth/HTTP context and re-authenticate the image method/URL/body;
   R11/R12 prove this is feasible in the SDK.
5. To include every session hook, the same request middleware must be shared. R7 proves a separate AI client does not
   inherit it automatically.
6. Change only image payload fields such as model/prompt/images/size/quality; never copy chat messages/tools/max_tokens
   wholesale into the Image API.

### Recommended direction

The safest long-term direction is for Core to expose public "prepare image deployment / execute image request"
capabilities that reuse ModelResolver's config/credential handling and session request middleware, returning or
holding an executable Auth.Definition/HTTP context instead of serializing credentials to the model. **This is a
proposed extension, not an existing API.**

Evidence: the public ModelDomain currently exposes only catalog/API plus transform/reload (installed
`@opencode/plugin/dist/promise/model.d.ts:26-29`), and runtime probes have no resolve/image API. Core
`ModelResolver.Interface` resolve/resolveModel returns a LanguageModel (`:110-131`) and does not provide an image
call for external plugins.

This round intentionally changed only the plugin and fixed native/OpenAI-compatible scenarios: mandatory credentials
were removed, correct provider settings/credential priority is used, variant overlays run, and auth/HTTP context from
native factories is reused. This is not "any provider + any hooks are identical." AISDK extensions, cloud signatures,
ADC, private providers, and request-level hooks still need separate validation or a shared Core channel.

Chat support does not imply image support; protocol and endpoint capability must be confirmed separately. R11/R12
only succeed against local endpoints explicitly compatible with OpenAI Images and do not prove arbitrary chat URLs
support images.

## Reproduction

Recommended repository entry points:

```sh
node research/run-image-gen-auth-parity.mjs
bun test research/runner-isolation.test.ts
```

The fixed entry point runs 15 formal auth/feasibility tests, plus 3 isolation/interruption cleanup tests and the 61
upstream unit tests above. On macOS, isolation tests verify localhost success and OS rejection of external sockets
rather than treating a timeout or unreachable target as sandbox evidence. Historical experiments are version-limited
evidence; formal tests now expect the fixed behavior and do not preserve old defects.
