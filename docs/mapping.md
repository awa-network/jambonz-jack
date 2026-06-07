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
| `<Gather>` | `gather` | `action`, `method`, `input`, `timeout`, `finishOnKey`, `numDigits`, `minDigits`, `maxDigits`, `bargeIn`, `hints`, `speechTimeout`, `language`, first nested `<Say>` or `<Play>` | `actionOnEmptyResult`, `enhanced`, `partialResultCallback`, `profanityFilter`, `speechModel`, `hintsBoost`, repeated nested prompts after the first | Missing TwiML `input` defaults to jambonz `["digits"]` for Twilio compatibility. Speech gather needs `DEFAULT_STT_VENDOR` or a jambonz app recognizer default. |
| `<Dial>` | `dial` | Direct number body, nested `<Number>`, `<Sip>`, `<Client>`, `action`, `method`, `callerId`, `answerOnBridge`, `timeout`, `timeLimit` | `hangupOnStar`, `record`, recording callbacks, `ringTone`, `sequential`, most nested noun attributes | Basic outbound bridging only. Advanced recording and call progress behavior needs more design. |
| `<Dial><Number>` | `dial.target[]` | Number body, `callerId` | `sendDigits`, `url`, `method`, `statusCallback`, `machineDetection` | Multiple targets are emitted as jambonz dial targets. |
| `<Dial><Sip>` | `dial.target[]` | SIP URI body | SIP auth, headers, status callbacks | Basic SIP URI only. |
| `<Dial><Client>` | `dial.target[]` | Client name body | status callbacks, parameters | Mapped to a jambonz user target. Confirm against your jambonz user model before relying on it. |
| `<Dial><Conference>` | `conference` | Conference name body, `beep`, `startConferenceOnEnter`, `endConferenceOnExit` | wait music, callbacks, recording, coaching, muted, jitter buffer options | Partial because Twilio conference lifecycle semantics do not exactly match jambonz. |
| `<Record>` | `listen` | `action`, `method`, `recordingStatusCallback`, `finishOnKey`, `maxLength`, `playBeep` | `timeout`, `trim`, `transcribe`, `transcribeCallback`, recording event options | Approximate. Real recording needs a websocket recorder URL via `RECORDING_WS_URL` or a recorder callback design. |
| `<Redirect>` | `redirect` | Body URL, `method` | none known | Body URL is rewritten through the bridge in bridge mode. |
| `<Hangup>` | `hangup` | none | none known | Direct mapping. |
| `<Reject>` | `sip:decline` | `reason` | none known | `busy` maps to SIP 486; other reasons map to SIP 603. |
| `<Enqueue>` | `enqueue` | Queue name body, `action`, `method`, `waitUrl`, `waitUrlMethod` | workflow, queue result callbacks, nested task attributes | Partial. Queue semantics need real jambonz queue testing. |
| `<Leave>` | `leave` | none | none known | Direct mapping. |
| `<Connect><Stream>` | `listen` | `url` | nested `<Parameter>`, track selection, status callbacks | Approximate. Emits bidirectional `listen` with mono mix. |

## Unsupported verbs and nouns

These are not mapped yet: `<Pay>`, `<Refer>`, `<Siprec>`, `<VirtualAgent>`, `<ConversationRelay>`, `<Room>`, `<Start>`, `<Stop>`, most nested `<Parameter>` behavior, and non-voice API concepts.

Unsupported commands should produce warnings from the converter rather than silently pretending they worked.

## Callback parameter forwarding

When the bridge fetches an existing TwiML app, it sends Twilio-compatible form parameters where possible:

| Twilio-style parameter | Source candidates from jambonz callback payload |
| --- | --- |
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

The XML parser rejects `DOCTYPE` and `ENTITY` declarations to avoid XXE-style attacks. Request bodies and fetched TwiML responses are capped by `MAX_XML_BYTES`, defaulting to 256 KiB. The HTTP service returns JSON only, sets `X-Content-Type-Options: nosniff`, and does not cache conversion responses.

For production, terminate TLS before the container, restrict who can call the bridge, and keep webhook secrets out of XML. Set `PUBLIC_BASE_URL` so rewritten callbacks use the externally reachable bridge URL. Set `ALLOWED_TWIML_HOSTS` to prevent arbitrary outbound fetches. Private hosts such as localhost and RFC1918 addresses are blocked unless `ALLOW_PRIVATE_TARGETS=true` is set for local testing.

The default target descriptor is base64url JSON, not encryption or authentication. For multi-tenant production, sign descriptors with an HMAC or store route IDs server-side. Base64url descriptors are still useful for a stateless first deployment because jambonz can carry the next TwiML URL without bridge-side session state.
