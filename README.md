# JACK

JACK is the Jambonz Application Compatibility Kit.

Run TwiML and LaML voice applications on jambonz.

This repository packages JACK as `jambonz-jack`.

The project is intentionally focused on voice-call control, not full API compatibility. It maps the easy and common verbs, and reports warnings for places where the XML behavior does not cleanly translate to jambonz.

## Quick start

Use a patched, supported Node.js release: 22.23.4+ on 22.x, 24.22.1+ on 24.x, or 26.12.1+ on newer lines. Node.js 20 is end of life and is no longer supported. CI and the container pin Node.js 22.23.4 with Alpine 3.24.3 by image digest. These minimums include the [October 2026 Node.js security fixes](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), including the Brotli decoder fix relevant to bridge responses. Continue applying later security patches.

```sh
npm ci
npm test
npm run lint
node src/cli.js examples/ivr.xml
npm start
```

For local bridge testing, use the same public base URL and target allowlist that jambonz will use:

```sh
PUBLIC_BASE_URL=https://bridge.example.com \
ALLOWED_TWIML_HOSTS=your-existing-app.example.com \
npm start
```

Convert raw XML directly:

```sh
curl -s http://localhost:3000/convert \
  -H 'Content-Type: application/xml' \
  --data-binary @examples/ivr.xml
```

The response body is a jambonz application JSON array.

Development tools are installed by `npm ci`. `npm run lint` runs ESLint and checks formatting across source and tests; `npm run format` applies Prettier. The runtime itself has no package dependencies.

## Testing

Run `npm test`, `npm run lint`, and `npm run audit` before committing. Tests start temporary loopback HTTP servers and child processes; they do not require jambonz, provider credentials, or external network access. Use `npm outdated --all` to inspect the full development dependency tree. CI also runs the full test suite against the built runtime image before publishing. These checks do not replace live-call compatibility testing.

The temporary `minimatch` override selects the patched 11.x line for development tooling (CVE-2026-118764); ESLint still requests 10.x. Remove the override once upstream dependencies require a patched version. See the [security maintenance report](docs/security-maintenance-2026-11.md) and [Claude Code review brief](docs/security-review.md) for evidence, reproduction commands, and remaining boundaries.

## Bridge mode

Point the jambonz application webhook to `/bridge?target=...`, where `target` is a base64url-encoded JSON descriptor:

```json
{"url":"https://your-existing-app.example.com/voice","method":"POST"}
```

Generate one locally:

```sh
node -e "const { encodeTarget } = require('./src'); console.log(encodeTarget({ url: 'https://your-existing-app.example.com/voice', method: 'POST' }))"
```

Then configure jambonz with:

```text
https://bridge.example.com/bridge?target=eyJ1cmwiOiJodHRwczovL3lvdXItZXhpc3RpbmctYXBwLmV4YW1wbGUuY29tL3ZvaWNlIiwibWV0aG9kIjoiUE9TVCJ9
```

Runtime flow:

1. jambonz calls the bridge webhook.
2. The bridge forwards Twilio-compatible form parameters such as `CallSid`, `From`, `To`, `Digits`, and `SpeechResult` to the target TwiML/LaML app.
3. The TwiML app returns XML.
4. The bridge converts XML to jambonz JSON.
5. Callback URLs such as `<Gather action="/menu">` and `<Redirect>/next</Redirect>` are rewritten back through `/bridge?target=...`, so later TwiML responses are also converted.

This is stateless: the next target URL and method are carried in the encoded descriptor. Unsigned base64url is not authentication. Set `TARGET_SIGNING_SECRET` to a random secret of at least 32 bytes to require HMAC-SHA256 signed descriptors. Generated callbacks are signed with the same key. Existing unsigned URLs then return HTTP 403 and must be regenerated:

```sh
node -e "const { encodeTarget } = require('./src'); console.log(encodeTarget({ url: 'https://your-existing-app.example.com/voice', method: 'POST' }, { targetSigningSecret: process.env.TARGET_SIGNING_SECRET }))"
```

The command and server must receive the same secret through the environment. Signed URLs authorize a route; they do not authenticate the caller or prevent replay. Restrict inbound access at your reverse proxy. Expiry and key rotation are not implemented yet.

Encoded descriptors are limited to 8192 characters including any signature; the encoder rejects longer targets. Bridge callback bodies accept JSON objects or form data, with case-insensitive media types. Malformed callback URLs return an input error without exposing their contents.

## HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Monitoring endpoint with service status, package version, uptime, and Node.js runtime version. |
| `GET` | `/healthz` | Minimal health probe returning `{ "ok": true }`. Useful for simple container checks. |
| `POST` | `/bridge?target=...` | Fetches the encoded TwiML/LaML/cXML target, forwards call parameters, converts the XML response to jambonz JSON, and rewrites supported callbacks through the bridge. |
| `POST` | `/convert` | Converts a raw XML voice response in the request body to jambonz JSON. |
| `POST` | `/twiml` | Alias for `/convert`, intended for Twilio-oriented callers. |
| `POST` | `/laml` | Alias for `/convert`, intended for SignalWire LaML callers. |
| `POST` | `/cxml` | Alias for `/convert`, intended for SignalWire cXML callers. |

Example health response:

```json
{
  "ok": true,
  "status": "ok",
  "service": "jambonz-jack",
  "version": "0.1.6",
  "uptimeSeconds": 42,
  "node": "v22.23.4"
}
```

Example lightweight probe response from `/healthz`:

```json
{
  "ok": true
}
```

## Container

```sh
docker build -t jambonz-jack .
docker run --rm --name jambonz-jack -p 127.0.0.1:3000:3000 \
  -e PUBLIC_BASE_URL=https://bridge.example.com \
  -e ALLOWED_TWIML_HOSTS=your-existing-app.example.com \
  jambonz-jack
```

This publishes the port on the host's loopback interface for a local TLS reverse proxy. Configure the proxy to restrict webhook callers. The image runs as numeric user 1000 and contains no npm/npx. When using `docker run --env-file .env`, override the template's loopback bind with `-e HOST=0.0.0.0` inside the container.

## Configuration

Copy `.env.example` to `.env`, edit the placeholder URLs, then run `node --env-file=.env src/server.js`. Node's built-in env-file support loads it explicitly; `npm start` uses the environment already supplied by your shell or process manager. `.env` and `.env.*` are ignored by Git except for `.env.example`, and Docker build context excludes env files. Restart the service after configuration changes: each server instance reads its environment once. Invalid limits, signing keys, ports, or non-HTTP/credential-bearing callback base URLs fail at startup without including secret values in the validation message.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | unset | `production` requires an explicit callback base URL and target allowlist for bridge requests. |
| `PORT` | `3000` | Decimal HTTP port, 0–65535; 0 lets the OS choose an ephemeral port. |
| `HOST` | all interfaces | Bind address for the server process; set `127.0.0.1` behind a local proxy. The container uses `0.0.0.0`. |
| `MAX_XML_BYTES` | `262144` | Maximum request body size and upstream bytes at each compression stage, including wire bytes. |
| `DEFAULT_STT_VENDOR` | unset | Fallback jambonz recognizer vendor for speech gathers. |
| `DEFAULT_TTS_LANGUAGE` | unset | Historical name for the fallback speech Gather recognizer language; Say uses jambonz app defaults. |
| `DEFAULT_SYNTH_VENDOR` | unset | Accepted for compatibility, currently unused because Say synthesizer overrides are stripped. |
| `RECORDING_WS_URL` | unset | WebSocket recorder URL used when approximating `<Record>` as `listen`. |
| `PUBLIC_BASE_URL` | inferred | Public URL used when rewriting TwiML callbacks through the bridge. |
| `ALLOWED_TWIML_HOSTS` | unset | Comma-separated exact hostname allowlist. Required for bridge mode in production. |
| `ALLOW_PRIVATE_TARGETS` | `false` | Allows localhost/private IP TwiML targets for local testing. |
| `FETCH_TIMEOUT_MS` | `5000` | Timeout for fetching TwiML from the target app. |
| `TARGET_SIGNING_SECRET` | unset | At least 32 bytes. When set, requires signed targets and signs generated callbacks. |
| `REQUEST_TIMEOUT_MS` | `10000` | Maximum time to receive a request body. |
| `MAX_CONCURRENT_REQUESTS` | `64` | Maximum simultaneous conversion/bridge requests; overload returns 503. |

In `NODE_ENV=production` (the container default), `/bridge` requires `PUBLIC_BASE_URL` and a nonempty `ALLOWED_TWIML_HOSTS`; otherwise it returns 503. Conversion and health endpoints remain available. Forwarded host/protocol headers are not trusted; always set `PUBLIC_BASE_URL` behind a proxy.

Targets are checked against the allowlist on every redirect. DNS answers are checked at connection time; private, loopback, link-local, shared, reserved, and IPv6 transition addresses are blocked by default. HTTPS-to-HTTP redirects and URL credentials are rejected. `ALLOW_PRIVATE_TARGETS=true` is only for trusted local testing. XML nesting is limited to 64 elements. Logs omit target paths, query strings, and request bodies.

Upstream responses support gzip, deflate, and Brotli with at most three nested content encodings. Excess nesting or bytes at any decoding stage return HTTP 502, bounding decompressor allocation and work even when the final XML is small.

## Compatibility limits

Mappings are partial. In particular, GET Redirect currently puts GET on a bridge endpoint that accepts only POST; use POST redirects until that mapping is corrected. Record is an approximation via `listen`: `recordingStatusCallback` is currently used as a media URL, so an ordinary HTTP status callback is not a working recorder destination. Gather does not fully reproduce implicit actions, prompt ordering, or empty attributes. See [the mapping notes](docs/mapping.md) before relying on these flows.

Dedicated status-event routing (JACK Status) is planned. Current callback parameter forwarding supports the XML-returning bridge flow; it does not implement all Twilio/SignalWire status webhooks.

## Architecture

`src/converter.js` is the product core. It accepts XML and returns:

```js
{
  jambonz: [/* ordered jambonz verbs */],
  warnings: [/* lossy or unsupported mapping notes */]
}
```

`src/server.js` exposes direct conversion and bridge mode. `src/bridge.js` fetches existing TwiML/LaML apps, forwards call context, rewrites callbacks, and applies outbound target guardrails. `src/cli.js` is useful for migration tests and local inspection. `src/xml.js` is a deliberately small parser for the supported XML shape; it rejects external entities and oversized bodies.

See [docs/mapping.md](docs/mapping.md) for the mapping matrix and security notes.

See [docs/product.md](docs/product.md) for product positioning and the JACK component model.

See [docs/review-followup.md](docs/review-followup.md) for review findings with baseline locations, validation results, and deferred decisions.

## References

The implementation follows the public voice markup surfaces documented by jambonz, Twilio, and SignalWire:

- jambonz verbs overview: https://docs.jambonz.org/verbs/verbs/overview
- Twilio Voice TwiML: https://www.twilio.com/docs/voice/twiml
- SignalWire voice cXML: https://signalwire.com/docs/compatibility-api/cxml/reference/voice

## License and Copyright

MIT License.

Copyright (c) 2026 AWA Network GmbH.

Contact: info@awa.network
