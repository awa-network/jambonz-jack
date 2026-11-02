# Security review brief

This prepares JACK for an independent Claude Code security review. It does not
claim that Claude Code has reviewed or approved the repository.

Read `AGENTS.md`, `CLAUDE.md`, the [mapping](mapping.md), and the
[November 2026 maintenance report](security-maintenance-2026-11.md). Historical
[review](review.md) and [follow-up](review-followup.md) findings are context,
not proof that a boundary is secure in the current revision.

## Suggested review prompt

> Review the current JACK repository for exploitable security defects. Follow
> AGENTS.md and docs/security-review.md. Independently trace untrusted data
> across HTTP input, descriptor decoding/signing, DNS/socket connections,
> redirects, decompression, XML parsing, callback rewriting, and logging.
> Inspect dependency advisories, the container, and CI credential/publishing
> boundaries. Reproduce findings with bounded synthetic local tests. Report
> findings before making changes, giving severity, exact file/line, attack
> prerequisites, impact, a minimal reproducer, and a proposed fix. Distinguish
> confirmed defects, deployment assumptions, known limitations, and unverified
> concerns. Do not contact live provider endpoints, publish, or expose secrets.

## Trust boundaries and review targets

| Boundary | Implementation | Existing regression evidence |
| --- | --- | --- |
| Untrusted HTTP bytes, JSON/form data, Host headers, connection limits, error responses and logs | `src/server.js`, `src/config.js`, `src/limits.js` | `test/http-contract.test.js`, `test/config.test.js`, `test/security.test.js` |
| Base64url descriptors, HMAC validation, callback URLs and forwarded scalar call fields | `src/bridge.js` | `test/bridge.test.js`, `test/edge-cases.test.js`, `test/http-contract.test.js` |
| Outbound protocol/host checks, alternate IP forms, DNS rebinding, redirects and deadlines | `src/targets.js`, `src/bridge.js` | `test/security.test.js`, `test/robustness.test.js` |
| Native gzip/deflate/Brotli decoders and byte/depth budgets | `src/bridge.js` | `test/security-limits.test.js`, `test/robustness.test.js` |
| XML tokenizer, entity/DTD rejection, recursion and generated jambonz instructions | `src/xml.js`, `src/converter.js` | `test/converter.test.js`, `test/robustness.test.js`, `test/security.test.js` |
| CLI local input and actual server startup | `src/cli.js`, `src/index.js`, `src/server.js` | `test/entrypoints.test.js` |
| Runtime supply chain, image metadata, non-root execution, CI secrets and release aliases | `Dockerfile`, `package-lock.json`, `.gitlab-ci.yml`, `.dockerignore`, `.githubignore` | npm audit, built-image test suite, image CVE scan and attestation inspection |

Check whether each control remains effective when composed with the next one;
tests cover examples rather than prove complete protection. Pay particular
attention to malformed compressed streams, XML CPU/memory amplification,
mixed DNS answers, IPv6 edge cases, disconnect cleanup and log redaction.

## Known boundaries and deferred work

- Production bridge mode requires `PUBLIC_BASE_URL` and `ALLOWED_TWIML_HOSTS`.
  Operators must restrict inbound traffic. Direct conversion has no caller
  authentication; provider webhook signature verification is not implemented.
- Descriptor signing is optional. Signed URLs authorize routes but do not
  authenticate callers, expire, prevent replay, or support key rotation.
  Base64url is not confidential. `ALLOW_PRIVATE_TARGETS=true` deliberately
  disables the private-address guard for trusted local tests.
- Allowlisted applications are trusted call-control code. Media/WebSocket/SIP
  destinations emitted for jambonz are not fetched or fully constrained by JACK.
- XML and decompression sizes/depth, upload deadlines, global concurrency and
  upstream deadlines are bounded. Per-client rate limiting and TLS termination
  remain proxy responsibilities. `/health` exposes runtime/version information.
- GET Redirect, Record recorder/status callback semantics and Gather behavior
  remain partial; see the mapping. Assess security impact without claiming
  unsupported behavior is compatible.
- Node embeds dependencies that `npm audit` cannot check. A scratch image can
  hide OS-library inventory unless metadata is retained. Scan the final image,
  inspect package coverage, and verify the Node version against vendor notices.
- CI uses a dedicated Docker-capable runner. Review access to that runner,
  protected variables/tags, temporary credentials, mirror exclusions, and
  attestations separately from application security.

## Local verification

Use a supported patched Node runtime. No production secrets are required:

```sh
npm ci --ignore-scripts
npm test
npm run lint
npm run audit
docker build --pull --platform linux/amd64 -t jambonz-jack:ci-test .
docker run --rm --platform linux/amd64 --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$PWD/test,dst=/app/test,readonly" \
  jambonz-jack:ci-test node --test
docker scout cves --exit-code local://jambonz-jack:ci-test
```

Record the reviewed commit, runtime, image digest, advisory/scan date, commands,
results, and coverage gaps. Do not label a clean dependency scan a complete
security review. Do not run unbounded exploits or test third-party systems.
