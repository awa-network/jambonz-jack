# Follow-up codebase review

Date: 2026-09-07. Baseline: `d36d1f0`. All locations in the findings table refer to that baseline, so they remain traceable after formatting. The earlier [review](review.md) records protections already present; those are not new findings in this pass.

## 1. Understand

- JACK translates supported TwiML and LaML/cXML voice instructions to jambonz JSON.
- `src/index.js` exports the library's conversion and target helpers.
- `src/cli.js` reads a file or stdin and emits JSON with compatibility warnings.
- `src/server.js` exposes conversion aliases, bridge mode, and health probes.
- Direct requests pass bounded XML through `xml.js`, then `converter.js` maps elements.
- Bridge requests decode a descriptor, forward selected call parameters, and fetch XML.
- Supported callbacks are rewritten through JACK; host, DNS, redirect, and size checks constrain outbound work.
- Routing is stateless, optional HMAC protects descriptors, and several mappings remain approximate.

## 2. Security review

| Severity | Baseline location | Finding and impact | Fix / disposition |
| --- | --- | --- | --- |
| Medium | `src/bridge.js:198–206` | An untrusted Content-Encoding list allocates a native decompressor per entry before enforcing any byte limit. Only final decoded bytes are bounded, allowing excessive intermediate or discarded compressed data. | Validate the whole list before allocation, permit at most three encoding layers, limit wire and every decoded stage, and destroy all transforms on failure. Regression tests cover valid stacks and each limit. |
| Medium | `src/server.js:273–275`, `Dockerfile:18` | Startup ignores HOST, so an operator's loopback bind configuration still exposes the unauthenticated HTTP service on all interfaces. | Honor HOST. Preserve the existing all-interface default when unset; document loopback configuration. |
| Low | `src/server.js:110–118` | Public health output reveals exact runtime/version information. | Retain the monitoring interface. Restrict `/health` at the proxy and use `/healthz` where less detail is needed. |
| Low | `src/server.js:183–219` | Per-request logs have no sampling or per-client rate limit and retain socket IP addresses. This allows log-volume amplification and requires a retention policy. | Leave rate limits, sampling and retention choices to the operator; global request/connection limits already exist. |
| Low | `Dockerfile:1`, `.gitlab-ci.yml:10,73` | Mutable image tags permit builds to change without a source revision. | Defer digest pinning and automated refresh policy for a deployment decision. |
| Low | `src/xml.js:47–69` | The small parser accepts some invalid XML, including whitespace immediately after an opening delimiter and processing instructions resembling misplaced XML declarations. | Defer stricter grammar because it changes currently accepted input. DTD/entity rejection, character checks and depth/byte limits remain enforced. |

No additional high issues were found. No application SQL, shell execution, template rendering, browser UI or remote file-serving surface exists. Operator-supplied CLI paths are not network input. JSON parsing does not execute code, XML attributes use null-prototype objects, and no hardcoded secret or insecure random generation was found. Responses are JSON with `nosniff` and `no-store`; no permissive CORS or debug endpoint is enabled. Logs omit payloads and complete target URLs. CI secrets come from environment variables and temporary credential storage.

The existing socket-time DNS checks, per-redirect allowlists, URL credential rejection, HTTPS downgrade rejection, descriptor signatures and input limits were reviewed and retained. npm audit reported zero known vulnerabilities in the baseline dependency graph.

Authentication remains a deployment boundary: signed descriptors authorize routes but do not authenticate callers, expire, or prevent replay. Production requires a target allowlist and callback base URL; inbound access must be restricted at a reverse proxy or private network. Allowlisted applications are trusted to emit call-control and media URLs. There is no new arbitrary authentication scheme in this pass.

Security behavior changes: responses exceeding three compression layers or the byte limit at any stage now fail with HTTP 502. Setting HOST now controls the bind address; leaving it unset preserves startup behavior.

References: [Node.js zlib resource guidance](https://nodejs.org/api/zlib.html#threadpool-usage-and-performance-considerations) describes the cost of many concurrent zlib objects; [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) supports checking both resolved addresses and redirects.

## 3. Correctness and robustness

- `src/bridge.js:73–76` emitted descriptors that exceeded the decoder's 8192-character limit. Encoding now rejects oversized tokens, including signature overhead, instead of handing callers unusable URLs.
- `src/server.js:163–178` used case-sensitive substring matching for callback Content-Type. The adapter now compares the normalized media type exactly; valid mixed-case JSON/form payloads retain their fields, and lookalike types use the existing unknown-type fallback.
- `src/bridge.js:28` let malformed relative callback URLs throw a generic TypeError. URL resolution now returns a controlled InputError without echoing the URL. HTTP callers receive 400 instead of 500 for this invalid upstream input.
- `src/bridge.js:120–121` allocated the fetch timer before composing abort signals. Invalid caller-supplied signals could throw before cleanup was installed. Signal composition now happens before timer allocation and still fails loudly for programming errors.
- No additional off-by-one, shared-state race, or file-resource defect was found in the bounded conversion flow. Existing connection, body-abort and deadline tests were retained.

GET Redirect, Record destination semantics, implicit Gather actions, empty attributes, and strict numeric coercion remain compatibility decisions. They are not silently changed under the interface-preservation constraint; see the earlier review and mapping notes.

## 4. Code quality and conventions

Applied the existing ESLint and Prettier configuration to source and tests. Named the timer ceiling and connection-check interval, reused the POST-route list, removed a redundant method check, and removed an unreachable gap check in the sticky XML tokenizer. These changes preserve conversion output and routing behavior. The baseline formatting failures are resolved. Shared environment-default extraction is grouped with phase 5 configuration work.

## 5. Configuration and secrets

Added `.env.example`, kept real env files ignored, and documented explicit loading with Node's `--env-file`. Runtime code requires no dotenv dependency. Centralized configuration in `src/config.js` and shared converter defaults between CLI and server. Each server now reads a consistent snapshot at construction; changes require a restart. Limits, nonempty callback base URLs, and signing keys validate before serving traffic. PORT validates before listening, including support for ephemeral port 0. Missing production routing configuration still returns 503 only on bridge requests, preserving direct conversion and health availability. No credentials were moved because none were hardcoded.

## 6. Dependencies

Ran `npm outdated --json`, `npm outdated --all --json`, `npm update --ignore-scripts`, and `npm audit --json` on 2026-09-07. All direct development dependencies are current: `@eslint/js` 10.0.1, `eslint` 10.10.0, `globals` 17.12.0, and `prettier` 3.9.6. No patch/minor updates within existing ranges were available; npm update left the dependency graph unchanged. npm audit reports zero known vulnerabilities. There are no runtime npm dependencies. This audit covers npm advisories, not the OS libraries or Node binary in the container.

The full tree check flags these newer major versions in development-only transitive dependencies. Current equals wanted in each row: leave them to their parent packages rather than force incompatible overrides.

| Transitive package | Installed | Latest | Parent |
| --- | --- | --- | --- |
| ajv | 6.15.0 | 8.20.0 | eslint |
| escape-string-regexp | 4.0.0 | 5.0.0 | eslint |
| eslint-visitor-keys | 3.4.3 | 5.0.1 | @eslint-community/eslint-utils |
| fast-levenshtein | 2.0.6 | 3.0.0 | optionator |
| find-up | 5.0.0 | 8.0.0 | eslint |
| hashery | 1.5.1 | 2.0.0 | @cacheable/utils, @keyv/bigmap |
| hookified | 1.15.1 | 2.2.0 | cacheable family, flat-cache, hashery |
| ignore | 5.3.2 | 7.0.8 | eslint |
| isexe | 2.0.0 | 4.0.0 | which |
| json-schema-traverse | 0.4.1 | 1.0.0 | ajv |
| locate-path | 6.0.0 | 8.0.0 | find-up |
| p-limit | 3.1.0 | 7.3.2 | p-locate |
| p-locate | 5.0.0 | 7.0.0 | locate-path |
| path-exists | 4.0.0 | 5.0.0 | find-up |
| path-key | 3.1.1 | 4.0.0 | cross-spawn |
| shebang-regex | 3.0.0 | 4.0.0 | shebang-command |
| which | 2.0.2 | 6.0.1 | cross-spawn |
| yocto-queue | 0.1.0 | 1.2.2 | p-limit |

ESLint also lists optional peer `jiti` 2.7.0 as uninstalled; it is unnecessary for this CommonJS configuration. No major dependency bump was applied. Corrected package engine metadata from Node >=20 to >=20.3.0, matching the existing [AbortSignal.any requirement](https://nodejs.org/api/globals.html#static-method-abortsignalanysignals), and documented [ESLint's stricter development prerequisites](https://eslint.org/docs/latest/use/getting-started#prerequisites). This corrects the advertised minimum without changing the runtime implementation.

## 7. Tests

The baseline's 32 tests passed; the expanded suite has 57 passing tests. Regression coverage added during each fix includes compression depth and every byte stage, descriptor boundaries, media types, malformed callback URLs, and configuration validation. This phase adds complete signed callback chains, unsigned rejection before upstream access, production guards with health/direct aliases still available, deadline and overload recovery, CLI success/failure, and verification of the actual startup bind address. Existing tests now supply their own environments rather than mutate process.env.

Validation: `npm test`, `npm run lint`, `docker build -t jambonz-jack:ci-test .`, and all 57 tests under the built Node 22 container with a read-only source mount and no external network. The normal suite also passes on the local Node 20.20.2 runtime. No live jambonz/provider integration or OS vulnerability scan is claimed.

A final independent review caught numeric PORT coercion accepting whitespace as 0, hexadecimal, and exponent notation. A focused follow-up commit restricts PORT to decimal digits and extends the malformed-port regression cases.

## 8. Documentation and hygiene

Consolidated duplicated setup/container instructions, documented explicit env loading and test prerequisites, corrected configuration defaults and mapping caveats, and labeled JACK Status as planned. The README links this review; the mapping and roadmap identify deferred GET Redirect, Record and Gather work. The existing MIT LICENSE already names AWA Network GmbH, so it is retained. No personal identity, real secrets, or private deployment URLs were added to tracked files. All review commits use AWA Development <dev@awa.network>; no release, remote push or publish was performed.

Next decisions: review the low-severity findings above, choose a compatibility scope for Redirect/Record/Gather, and validate representative flows against a real jambonz deployment. Leave transitive development-tool major versions to their parent packages unless a specific tested upgrade is needed.
