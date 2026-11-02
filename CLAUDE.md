@AGENTS.md

# Claude Code review context

Read [the security review brief](docs/security-review.md) before reviewing JACK.
It maps trust boundaries, security-critical files, existing regression tests,
known limitations, and the requested finding format. The dated maintenance
report linked there records dependency and image CVE checks; independently
verify its conclusions against the current revision and advisory databases.

The runtime has no npm dependencies. Development dependencies and the Node
binary/native libraries in the container must be reviewed separately.
Use synthetic fixtures and loopback test servers. Do not include credentials,
real call payloads, target URLs, or personal identities in findings or commits.
