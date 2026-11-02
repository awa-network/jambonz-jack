# Claude Code review context

Follow `AGENTS.md` when present in the maintainer repository. The public mirror
omits that maintainer file. In both repositories, use `jambonz-jack` branding,
AWA Network GmbH copyright, and AWA Development <dev@awa.network> for project
commit author/committer identity. Use short Conventional Commit messages.
Run `npm test` and `npm run lint` before code commits and build/test the container
for container changes. Keep real credentials, call data and personal identities
out of tracked files. Retain XML declaration rejection, socket-time DNS checks,
redirect restrictions and minimal structured logs.

Read [the security review brief](docs/security-review.md) before reviewing JACK.
It maps trust boundaries, security-critical files, existing regression tests,
known limitations, and the requested finding format. The dated maintenance
report linked there records dependency and image CVE checks; independently
verify its conclusions against the current revision and advisory databases.

The runtime has no npm dependencies. Development dependencies and the Node
binary/native libraries in the container must be reviewed separately.
Use synthetic fixtures and loopback test servers. Do not include credentials,
real call payloads, target URLs, or personal identities in findings or commits.
