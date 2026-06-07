# JACK

JACK is the Jambonz Application Compatibility Kit.

Run TwiML and LaML voice applications on jambonz.

This repository packages JACK as `jambonz-jack`.

The project is intentionally focused on voice-call control, not full API compatibility. It maps the easy and common verbs, and reports warnings for places where the XML behavior does not cleanly translate to jambonz.

## Quick start

```sh
npm test
node src/cli.js examples/ivr.xml
npm start
```

For local bridge testing, use the same public base URL and target allowlist that jambonz will use:

```sh
PUBLIC_BASE_URL=https://bridge.example.com \
ALLOWED_TWIML_HOSTS=your-existing-app.example.com \
npm test

PUBLIC_BASE_URL=https://bridge.example.com \
ALLOWED_TWIML_HOSTS=your-existing-app.example.com \
npm start
```

Concrete local-style example:

```sh
PUBLIC_BASE_URL=https://bridge.example.net \
ALLOWED_TWIML_HOSTS=workflow.example.com \
npm test

PUBLIC_BASE_URL=https://bridge.example.net \
ALLOWED_TWIML_HOSTS=workflow.example.com \
npm start
```

Generate a sample target for a real TwiML URL:

```sh
node -e "const { encodeTarget } = require('./src'); console.log(encodeTarget({ url: 'https://your-existing-app.example.com/voice', method: 'POST' }))"
```

Convert raw XML directly:

```sh
curl -s http://localhost:3000/convert \
  -H 'Content-Type: application/xml' \
  --data-binary @examples/ivr.xml
```

The response body is a jambonz application JSON array.

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

This is stateless: the next target URL and method are carried in the encoded descriptor. For production you can replace this with signed descriptors, but unsigned base64url is a good development default and easy to inspect.

## Container

```sh
docker build -t jambonz-jack .
docker run --rm --name jtb -p 3000:3000 \
  -e PUBLIC_BASE_URL=https://bridge.example.com \
  -e ALLOWED_TWIML_HOSTS=your-existing-app.example.com \
  jambonz-jack
```

Preferred branded image name:

```sh
docker build -t jambonz-jack .
docker run --rm --name jambonz-jack -p 3000:3000 \
  -e PUBLIC_BASE_URL=https://bridge.example.com \
  -e ALLOWED_TWIML_HOSTS=your-existing-app.example.com \
  jambonz-jack
```

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `MAX_XML_BYTES` | `262144` | Maximum request body size. |
| `DEFAULT_STT_VENDOR` | unset | Fallback jambonz recognizer vendor for speech gathers. |
| `RECORDING_WS_URL` | unset | WebSocket recorder URL used when approximating `<Record>` as `listen`. |
| `PUBLIC_BASE_URL` | inferred | Public URL used when rewriting TwiML callbacks through the bridge. |
| `ALLOWED_TWIML_HOSTS` | unset | Comma-separated allowlist for TwiML app hostnames. Strongly recommended in production. |
| `ALLOW_PRIVATE_TARGETS` | `false` | Allows localhost/private IP TwiML targets for local testing. |
| `FETCH_TIMEOUT_MS` | `5000` | Timeout for fetching TwiML from the target app. |

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

## References

The implementation follows the public voice markup surfaces documented by jambonz, Twilio, and SignalWire:

- jambonz verbs overview: https://docs.jambonz.org/verbs/verbs/overview
- Twilio Voice TwiML: https://www.twilio.com/docs/voice/twiml
- SignalWire voice cXML: https://signalwire.com/docs/compatibility-api/cxml/reference/voice

## License and Copyright

MIT License.

Copyright (c) 2026 AWA Network GmbH.

Contact: info@awa.network
