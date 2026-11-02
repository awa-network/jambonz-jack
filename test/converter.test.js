'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { convertVoiceXml, XmlParseError } = require('../src');

test('converts simple say, play, pause, and hangup sequence', () => {
  const result = convertVoiceXml(`
    <Response>
      <Say language="en-US" voice="alice">Hello &amp; welcome</Say>
      <Play loop="2">https://example.com/hello.mp3</Play>
      <Pause length="3"/>
      <Hangup/>
    </Response>
  `);

  assert.deepEqual(result.jambonz, [
    { verb: 'say', text: 'Hello & welcome' },
    { verb: 'play', url: 'https://example.com/hello.mp3', loop: 2 },
    { verb: 'pause', length: 3 },
    { verb: 'hangup' }
  ]);
});

test('strips Twilio say voice overrides so jambonz app defaults apply', () => {
  const result = convertVoiceXml(`
    <Response>
      <Say voice="polly.Matthew-Neural" language="en-US">Hello</Say>
    </Response>
  `);

  assert.deepEqual(result.jambonz, [
    {
      verb: 'say',
      text: 'Hello'
    }
  ]);
});

test('converts gather with nested prompt and speech recognizer hints', () => {
  const result = convertVoiceXml(
    `
    <Response>
      <Gather input="dtmf speech" action="/collect" timeout="8" numDigits="1" finishOnKey="#" hints="sales,support" language="en-US">
        <Say>Choose sales or support</Say>
      </Gather>
    </Response>
  `,
    { defaults: { recognizerVendor: 'google' } }
  );

  assert.deepEqual(result.jambonz, [
    {
      verb: 'gather',
      actionHook: '/collect',
      input: ['digits', 'speech'],
      timeout: 8,
      finishOnKey: '#',
      numDigits: 1,
      recognizer: { vendor: 'google', language: 'en-US', hints: ['sales', 'support'] },
      say: { text: 'Choose sales or support' }
    }
  ]);
});

test('defaults gather input to digits for TwiML compatibility', () => {
  const result = convertVoiceXml(`
    <Response>
      <Gather action="/collect"><Say>Press one</Say></Gather>
    </Response>
  `);

  assert.deepEqual(result.jambonz, [
    {
      verb: 'gather',
      actionHook: '/collect',
      input: ['digits'],
      say: { text: 'Press one' }
    }
  ]);
});

test('converts dial targets', () => {
  const result = convertVoiceXml(`
    <Response>
      <Dial callerId="+14155550100" timeout="20" answerOnBridge="true">
        <Number>+14155550123</Number>
        <Sip>sip:agent@example.com</Sip>
        <Client>agent-7</Client>
      </Dial>
    </Response>
  `);

  assert.deepEqual(result.jambonz, [
    {
      verb: 'dial',
      callerId: '+14155550100',
      answerOnBridge: true,
      timeout: 20,
      target: [
        { type: 'phone', number: '+14155550123' },
        { type: 'sip', sipUri: 'sip:agent@example.com' },
        { type: 'user', name: 'agent-7' }
      ]
    }
  ]);
});

test('keeps warnings for approximate and unsupported mappings', () => {
  const result = convertVoiceXml(`
    <Response>
      <Record action="/recorded" maxLength="30"/>
      <Pay/>
    </Response>
  `);

  assert.equal(result.jambonz[0].verb, 'listen');
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0].message, /approximated/);
  assert.match(result.warnings[1].message, /No direct/);
});

test('rejects unsafe entity declarations', () => {
  assert.throws(
    () =>
      convertVoiceXml(`
    <!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
    <Response><Say>&xxe;</Say></Response>
  `),
    XmlParseError
  );
});

test('requires response root', () => {
  assert.throws(() => convertVoiceXml('<Say>Hello</Say>'), /Expected a single <Response>/);
});

test('rewrites XML-returning callbacks when a bridge hook is supplied', () => {
  const result = convertVoiceXml(
    `
    <Response>
      <Gather action="/next" method="GET"><Say>Press 1</Say></Gather>
      <Redirect>/fallback</Redirect>
    </Response>
  `,
    {
      hooks: {
        rewriteCallbackUrl: (value, meta) => `bridge:${meta.method}:${value}`
      }
    }
  );

  assert.equal(result.jambonz[0].actionHook, 'bridge:GET:/next');
  assert.equal(result.jambonz[1].actionHook, 'bridge:POST:/fallback');
});
