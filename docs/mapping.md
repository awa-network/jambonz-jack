# Voice XML to jambonz mapping

This bridge converts Twilio TwiML and SignalWire LaML/cXML voice responses into jambonz JSON. It focuses on common call-control verbs and returns warnings for commands that are approximate or not implemented.

In bridge mode, TwiML callback URLs are rewritten because jambonz expects callbacks to return jambonz JSON, while a TwiML app returns XML. For example, `<Gather action="/menu">` becomes a jambonz `gather.actionHook` that points back to `/bridge?target=...`, with `/menu` resolved relative to the original TwiML document URL.

## Support levels

| Level | Meaning |
| --- | --- |
| Supported | Mapped intentionally and covered by tests or live-call feedback. |
| Partial | Basic behavior maps, but Twilio/SignalWire semantics differ or some parameters are ignored. |
| Approximate | Converted to a jambonz feature that can support a similar workflow, but not the same runtime contract. |
| Unsupported | Ignored with a warning or not represented yet. |

## Verb and parameter support

| XML verb/noun | jambonz output | Supported parameters | Ignored or unsupported parameters | Notes |
| --- | --- | --- | --- | --- |
| `<Say>` | `say` | Body text, `loop` | `voice`, `language`, `gender` | TTS overrides are intentionally stripped so the jambonz application default synthesizer is used. SSML is not specially transformed yet. |
| `<Play>` | `play` | Body URL, `loop`, `timeout` | `digits` | Only URL playback is mapped. Twilio DTMF playback via `digits` is not mapped. |
| `<Pause>` | `pause` | `length` | none known | Direct mapping. |
| `<Gather>` | `gather` | `action`, `method`, `input`, `timeout`, `finishOnKey`, `numDigits`, `minDigits`, `maxDigits`, `bargeIn`, `hints`, `speechTimeout`, `language`, first nested `<Say>` and first `<Play>` | `actionOnEmptyResult`, `enhanced`, `partialResultCallback`, `profanityFilter`, `speechModel`, `hintsBoost`, repeated prompts of the same type and nested pauses | Missing TwiML `input` defaults to jambonz `["digits"]`. Prompt ordering and implicit actions are partial. Speech gather needs `DEFAULT_STT_VENDOR` or a jambonz app recognizer default. |
| `<Dial>` | `dial` | Direct number body, nested `<Number>`, `<Sip>`, `<Client>`, `action`, `method`, `callerId`, `answerOnBridge`, `timeout`, `timeLimit` | `hangupOnStar`, `record`, recording callbacks, `ringTone`, `sequential`, most nested noun attributes | Basic outbound bridging only. Advanced recording and call progress behavior needs more design. |
| `<Dial><Number>` | `dial.target[]` | Number body, `callerId` | `sendDigits`, `url`, `method`, `statusCallback`, `machineDetection` | Multiple targets are emitted as jambonz dial targets. |
| `<Dial><Sip>` | `dial.target[]` | SIP URI body | SIP auth, headers, status callbacks | Basic SIP URI only. |
| `<Dial><Client>` | `dial.target[]` | Client name body | status callbacks, parameters | Mapped to a jambonz user target. Confirm against your jambonz user model before relying on it. |
| `<Dial><Conference>` | `conference` | Conference name body, `beep`, `startConferenceOnEnter`, `endConferenceOnExit` | wait music, callbacks, recording, coaching, muted, jitter buffer options | Partial because Twilio conference lifecycle semantics do not exactly match jambonz. |
| `<Record>` | `listen` | `action`, `method`, `finishOnKey`, `maxLength`, `playBeep` | `timeout`, `trim`, `transcribe`, `transcribeCallback`, recording event options; status callback semantics | Approximate. `recordingStatusCallback` currently overrides the media URL, which is incorrect for an HTTP status webhook. A websocket recorder via `RECORDING_WS_URL` is needed; omit the status callback until proper routing exists. |
| `<Redirect>` | `redirect` | Body URL, `method` | GET method separation in bridge mode | Body URL is rewritten through the bridge. Current GET output conflicts with the POST-only bridge endpoint; use POST until corrected. |
| `<Hangup>` | `hangup` | none | none known | Direct mapping. |
| `<Reject>` | `sip:decline` | `reason` | none known | `busy` maps to SIP 486; other reasons map to SIP 603. |
| `<Enqueue>` | `enqueue` | Queue name body, `action`, `method`, `waitUrl`, `waitUrlMethod` | workflow, queue result callbacks, nested task attributes | Partial. Queue semantics need real jambonz queue testing. |
| `<Leave>` | `leave` | none | none known | Direct mapping. |
| `<Connect><Stream>` | `listen` | `url` | nested `<Parameter>`, track selection, status callbacks | Approximate. Emits bidirectional `listen` with mono mix. |

## Unsupported verbs and nouns

These are not mapped yet: `<Pay>`, `<Refer>`, `<Siprec>`, `<VirtualAgent>`, `<ConversationRelay>`, `<Room>`, `<Start>`, `<Stop>`, most nested `<Parameter>` behavior, and non-voice API concepts.

Unsupported commands should produce warnings from the converter rather than silently pretending they worked.

Known compatibility gaps also include Gather without `action` (no implicit current-document callback), dropped empty attributes such as `finishOnKey=""`, and permissive integer parsing. Mixed Say/Play prompts cannot preserve arbitrary source ordering. Changing these output semantics is deferred pending representative provider fixtures and a compatibility decision. Some unsupported nested elements are ignored without a dedicated warning, so warnings are not a complete compatibility validator.

## Callback parameter forwarding

When the bridge fetches an existing TwiML app, it sends Twilio-compatible form parameters where possible:

| Twilio-style parameter | Source candidates from jambonz callback payload |
| --- | --- |
| `AccountSid` | `account_sid`, `accountSid`, `AccountSid` |
| `CallSid` | `call_sid`, `callSid`, `CallSid`, `call_id` |
| `CallStatus` | `call_status`, `callStatus`, `CallStatus` |
| `Direction` | `direction`, `Direction` |
| `From` | `from`, `From`, `caller_id` |
| `To` | `to`, `To`, `called_number` |
| `Digits` | `digits`, `Digits` |
| `SpeechResult` | `speech_result`, `SpeechResult`, first speech alternative transcript |
| `RecordingUrl` | `recording_url`, `RecordingUrl` |
| `RecordingDuration` | `recording_duration`, `RecordingDuration` |
| `DialCallStatus` | `dial_call_status`, `DialCallStatus` |
| `DialCallSid` | `dial_call_sid`, `DialCallSid` |

This is intentionally conservative. As we see real jambonz callback payloads, add fixtures and expand the mapping.

## Security notes

The XML parser rejects `DOCTYPE` and `ENTITY` declarations to avoid XXE-style attacks. Request bodies and fetched TwiML responses are capped by `MAX_XML_BYTES`, defaulting to 256 KiB. Upstream wire bytes and each decompression stage use the same cap; at most three gzip/deflate/Brotli layers are accepted. The HTTP service returns JSON only, sets `X-Content-Type-Options: nosniff`, and does not cache conversion responses.

For production, terminate TLS before the container, restrict who can call the bridge, and keep webhook secrets out of XML. Set `PUBLIC_BASE_URL` so rewritten callbacks use the externally reachable bridge URL. Set `ALLOWED_TWIML_HOSTS` to prevent arbitrary outbound fetches. Private hosts such as localhost and RFC1918 addresses are blocked unless `ALLOW_PRIVATE_TARGETS=true` is set for local testing.

The default target descriptor is base64url JSON, not encryption or authentication. Set `TARGET_SIGNING_SECRET` to a random secret of at least 32 bytes to require HMAC-SHA256 signed descriptors and sign generated callbacks. This authorizes a route but does not authenticate webhook callers or prevent replay; expiry and key rotation are planned. Keep inbound access restricted. Descriptors, including signatures, are limited to 8192 characters. Production bridge mode requires `PUBLIC_BASE_URL` and `ALLOWED_TWIML_HOSTS`; DNS answers and every redirect remain checked before connecting.
