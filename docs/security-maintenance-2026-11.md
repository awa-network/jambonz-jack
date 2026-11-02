# Security maintenance: November 2026

Date: 2026-11-02. Source baseline: `994d30f`. Release: `v0.1.7`.
This records dependency/runtime CVE maintenance and local regression testing;
an independent Claude Code review and live provider testing remain outstanding.

## Findings and changes

| Surface | Evidence | Change |
| --- | --- | --- |
| Runtime Node.js | The previous published image (`sha256:83de5b6dfb5eb4b6fea44f24a4fff638712e32dbbcade9f490a4e3330af74813`) contains Node 22.22.3. Scout reports 27 Node vulnerabilities. The vendor's October release also fixes Brotli CVE-2026-111497, directly relevant to JACK's `createBrotliDecompress` path. | Pin Node 22.23.4 / Alpine 3.24.3 by index digest in Docker and CI. This also updates embedded OpenSSL to 3.5.9. |
| Development dependencies | npm audit reports six affected dependency entries: one high and five moderate. They trace to brace-expansion CVE-2026-102276/102277/102278 and minimatch CVE-2026-118764. There are no runtime npm dependencies. | Update ESLint to 10.14.0, globals to 17.14.0, Prettier to 3.9.10 and the lockfile. Resolved brace-expansion is 5.0.12; a temporary minimatch override resolves 11.0.4 because ESLint still requests 10.x. Audit now reports zero. |
| Native library inventory | The scratch image previously omitted Alpine package metadata, limiting OS CVE visibility. | Retain OS identification and metadata only for the copied musl, libgcc, libstdc++ and CA bundle packages. No apk, shell, npm or npx is added to the runtime. |
| CI and release checks | CI previously tested a mutable Node tag and published without exercising the final scratch image. The GitHub export job used an old Git image. | Pin CI bases, install maintained Alpine Git for export, gate on npm audit, and run all tests inside the built amd64 runtime before publication. Keep SBOM and max-mode provenance in the single release build. |
| Supported runtime | Node 20 is end of life and older supported versions lack recent fixes. | Require patched Node 22.23.4+, 24.22.1+, or 26.12.1+ and document ongoing patch maintenance. |

The application retains its existing XML declaration rejection, socket-time DNS
checks, per-redirect target restrictions, byte/depth limits, cancellation,
optional HMAC signatures and log redaction. No new claim of full provider
compatibility or caller authentication is made.

## Image scan disposition

Docker Scout 1.27.0 indexes eight component records in the patched image,
including Node and the four copied Alpine package records (some source-package
records are also reported). It reports one unspecified-severity finding:
`CVE-2026-107891` on musl `1.2.6-r3`, claiming a fix at `1.2.6-r6`.

The [Alpine security tracker](https://security.alpinelinux.org/vuln/CVE-2026-107891)
lists **3.24 musl 1.2.6-r3 as fixed**; `1.2.6-r6` is the edge-branch fix.
The installed stable package therefore includes the distribution backport.
Trivy 0.76.1 with its freshly downloaded database independently detects Alpine
3.24.3, inventories all four copied OS packages and the Node binary, and reports
zero vulnerabilities. Treat the Scout result as a distribution-version matching
false positive, not an unpatched runtime defect. It is documented rather than
hidden through a blanket scanner exclusion. Recheck this disposition against
current vendor records whenever rebuilding.

Final runtime inventory:

| Component | Version |
| --- | --- |
| Node | 22.23.4 |
| Embedded OpenSSL | 3.5.9 |
| Alpine identification | 3.24.3 |
| musl | 1.2.6-r3 |
| libgcc / libstdc++ | 15.2.0-r5 |
| CA bundle | 20261020-r0 |

## Validation

- `npm test`: 57/57 pass.
- `npm run lint`: ESLint and Prettier pass with the minimatch override.
- Clean `npm ci --ignore-scripts` on the pinned Node 22.23.4 image, lint and audit.
- `npm run audit`: zero vulnerabilities, including development dependencies.
- `docker build --pull --platform linux/amd64 -t jambonz-jack:ci-test .`: passes.
- All 57 tests pass against the amd64 scratch runtime with only the test suite
  added in the `test` build stage, using `--network none --read-only --cap-drop ALL` and
  `--security-opt no-new-privileges`.
- Runtime checks confirm UID 1000, Node 22.23.4, the four OS package records,
  and absence of shell, apk, npm, npx and runtime node_modules.
- CI YAML parses; every shell fragment passes `sh -n`.
- Final-image scans and vendor disposition are recorded above. Repeat scans on
  the published digest, since advisory databases change independently of code.

The first release attempt, `v0.1.6` at `47a533c`, passed GitLab's Node tests but
failed to publish the Docker image: its test bind mount referred to a checkout
path unavailable to the runner's separate Docker daemon. The corrected `test`
stage avoids host bind mounts and shares the final runtime layers; the default
`final` stage omits tests. The earlier tag is retained, and `v0.1.7` contains the
runner correction. The configured public GitHub export had already succeeded
for the earlier tag.

The development host's older Node can still execute the suite, but it is no
longer an advertised deployment runtime. The pinned container is the release
validation environment. No live jambonz/provider calls, penetration test of
external systems, or independent Claude Code approval is claimed.

## Follow-up review

Use [the Claude Code security review brief](security-review.md) and root
`CLAUDE.md`. Review descriptor replay/expiry and caller authentication,
untrusted XML/resource usage, DNS/IPv6 edge cases, media destinations delegated
to jambonz, and CI runner/protected-variable controls. Remove the minimatch
override once parent dependencies require the patched line. Keep pinned image
digests and supported runtime patch minimums current.

## Primary references

- [Node October 2026 advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
- [Node 22.23.4 release](https://nodejs.org/en/blog/release/v22.23.4)
- [Alpine 3.24.3 release and stable security backports](https://www.alpinelinux.org/posts/Alpine-3.21.9-3.22.7-3.23.7-3.24.3-released.html)
- [minimatch CVE-2026-118764](https://github.com/advisories/GHSA-g3hv-75wg-m249)
- [brace-expansion CVE-2026-102276](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p)
- [brace-expansion CVE-2026-102277](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)
- [brace-expansion CVE-2026-102278](https://github.com/advisories/GHSA-qhr7-859c-m2p7)
