# Codebase review

This is the historical review preceding the current snapshot. See [the follow-up review](review-followup.md) for the latest changes and remaining decisions.

Reviewed baseline: `2ec09ec`. Locations below refer to that revision so findings remain traceable after changes. Review date: 2026-09-07.

## Security findings

| Severity | Baseline location | Problem | Fix / disposition |
| --- | --- | --- | --- |
| High | `src/bridge.js:77`, `183-214` | Fetch automatically follows unchecked redirects. Hostname-only checks miss private DNS answers, DNS rebinding, IPv6 and shared-address ranges. This permits requests into internal services, even with a hostname allowlist. | Validate every hop and use a socket lookup that returns only checked addresses. Block non-public addresses, downgrade redirects and URL credentials. |
| High | `src/server.js:15`, `src/bridge.js:38-64` | URL parsing before the error boundary can reject the async request handler without a response. Recursive decoding of string-valued JSON can exhaust the stack. | Parse inside the boundary, bound tokens, require object descriptors and return controlled input errors. |
| Medium | `src/server.js:34-39`, `src/bridge.js:53-65` | Unsigned descriptors allow anyone who reaches the service to choose upstream paths and forge callback requests. An absent allowlist also permits arbitrary public destinations. | Optional HMAC-SHA256 signing with constant-time verification; configuring a secret rejects unsigned requests. Production requires an allowlist and explicit public base URL. Operators must enable signing or enforce access control at the proxy; signing does not prevent replay. |
| Medium | `src/xml.js:67`, `116-117`; `src/server.js:175-190` | Byte limits alone do not bound nesting or concurrent slow uploads. Recursive conversion and retained request buffers can exhaust resources. | Cap nesting at 64, bound body receipt time and active requests/connections; reject overload with 503. |
| Medium | `src/server.js:108-126` | Arbitrary forwarded headers control generated callback destinations and claimed client addresses. Invalid JSON is silently treated as empty call context. | Ignore forwarding headers, require a configured production callback base URL, and reject malformed/non-object JSON. |
| Medium | `src/bridge.js:79-94`, `src/server.js:68-69,132-142`, `src/xml.js:94` | Error responses expose complete upstream URLs; paths may contain webhook secrets or phone numbers. XML errors can echo sensitive input. | Remove target paths and query strings from logs/errors, log a fixed marker for unknown routes, and return a generic 500 for unexpected errors. |
| Medium | `.gitlab-ci.yml:42`, `99` | Shell-runner Docker credentials can persist; a GitHub token embedded in a URL can appear in process arguments, config or failure output. | Job-scoped temporary Docker configuration and an environment-backed Git askpass helper; cleanup on exit. |
| Low | `src/server.js:75-83` | Public health output exposes the precise runtime version and uptime. This was explicitly requested for monitoring. | Retained. Restrict health access at the proxy if runtime fingerprinting matters. |
| Low | `Dockerfile:1`, `.gitlab-ci.yml:10,64` | Mutable builder/runtime tags can change without a repository change. | Retained. Consider automated digest pinning with scheduled security updates. |
| Low | `src/server.js:166-173` | Per-request logs and no per-client rate limit can create log volume under sustained internet scanning. | Global concurrency is bounded. Choose proxy rate limits, log rotation and retention for your deployment; no arbitrary per-caller quota added. |

No SQL, template rendering, browser UI, runtime command execution, file-serving routes, hardcoded credentials, or insecure random generation were found in the application. CLI file paths are operator-supplied, not remote input. JSON parsing does not execute code. XML DTD/entity declarations remain rejected. HTTP responses are JSON with `nosniff` and `no-store`; no permissive CORS was found.

These checks do not validate arbitrary media URLs that jambonz itself fetches. Allowlisted TwiML applications remain trusted call-control code. TLS termination, webhook access restrictions and protection of signing keys remain deployment responsibilities.

## References

- [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html): validate addresses and redirects, avoid a second unchecked lookup.
- [Node.js network API](https://nodejs.org/docs/latest-v22.x/api/net.html): address parsing, CIDR checks and custom connection lookup.

## Correctness and robustness

- The XML tokenizer ended tags at quoted `>` characters, accepted duplicate/adjacent attributes and malformed entities, and matched closing namespace prefixes loosely. It now handles quoted delimiters and validates attributes, character references, comments and closing names. Invalid XML fails as `XmlParseError`, not a generic runtime exception.
- Numeric zero callback values were lost through truthiness fallback. They are now forwarded; structured values in scalar callback fields are rejected.
- Upstream responses are destroyed on errors and redirects. Streaming decompression preserves compressed-response support and enforces the byte limit after decompression. One deadline spans the entire redirect chain and response body; client disconnects abort upstream work.
- Each CI job owns its Buildx builder and credential directory. The public GitHub export preserves the project's `.gitignore` after applying mirror exclusions.

### Compatibility decisions left open

These require changing existing emitted JSON or adding call behavior, so they are deferred under the review's interface constraint:

- `src/converter.js:64-69` (baseline): `<Redirect method="GET">` carries GET onto a bridge hook served only by POST. The bridge-to-upstream method must be separated from the jambonz-to-bridge method.
- `src/converter.js:155-165` (baseline): `<Record recordingStatusCallback="https://...">` uses an HTTP status callback as a media WebSocket destination. Decide on recorder behavior and status-event routing before enabling recording in production.
- Gather without `action` does not yet emulate the provider's current-document callback behavior; mixed/multiple prompts and empty `finishOnKey` remain approximate.
- Numeric verb attributes still use permissive integer coercion; stricter verb schemas, provider fixtures and live-call validation should be a dedicated compatibility change.
