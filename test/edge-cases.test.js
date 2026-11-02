'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { decodeTarget, encodeTarget, fetchAndConvertTarget } = require('../src');
const { InputError } = require('../src/errors');
const { createServer } = require('../src/server');

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

async function callbackBridge(t) {
  const received = [];
  const upstream = await listen(
    t,
    http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received.push(
          Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
        );
        res.end('<Response><Hangup/></Response>');
      });
    })
  );
  const base = await listen(t, createServer({ env: { ALLOW_PRIVATE_TARGETS: 'true' }, log() {} }));
  return { url: `${base}/bridge?target=${encodeTarget({ url: upstream })}`, received };
}

for (const signed of [false, true]) {
  test(`${signed ? 'signed' : 'unsigned'} target descriptors round-trip at the size limit`, () => {
    const options = signed ? { targetSigningSecret: 'a'.repeat(32) } : {};
    const target = { url: 'https://example.com/', method: 'POST' };
    // SHA-256 adds a separator and 43 base64url characters to a signed descriptor.
    const encodedLength = 8192 - (signed ? 44 : 0);
    const jsonBytes = (encodedLength / 4) * 3;
    target.url += 'a'.repeat(jsonBytes - Buffer.byteLength(JSON.stringify(target)));

    const token = encodeTarget(target, options);
    assert.equal(token.length, 8192);
    assert.deepEqual(decodeTarget(token, options), target);
    assert.throws(
      () => encodeTarget({ ...target, url: `${target.url}a` }, options),
      (err) =>
        err instanceof InputError && /Target descriptor exceeds 8192 characters/.test(err.message)
    );
  });
}

test('mixed-case JSON and form media types forward callback fields', async (t) => {
  const { url, received } = await callbackBridge(t);
  const requests = [
    {
      contentType: 'Application/JSON; Charset=UTF-8',
      body: JSON.stringify({ call_sid: 'json-call', digits: 0 }),
      expected: { CallSid: 'json-call', Digits: '0' }
    },
    {
      contentType: 'Application/X-Www-Form-Urlencoded; Charset=UTF-8',
      body: 'call_sid=form-call&digits=%23',
      expected: { CallSid: 'form-call', Digits: '#' }
    }
  ];
  for (const request of requests) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': request.contentType },
      body: request.body
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ verb: 'hangup' }]);
    assert.deepEqual(received.at(-1), request.expected);
  }
});

test('lookalike media types preserve the unknown-content-type fallback', async (t) => {
  const { url, received } = await callbackBridge(t);
  const requests = [
    { contentType: 'application/json-seq', body: '{"call_sid":"ignored"}' },
    { contentType: 'text/plain; profile="application/json"', body: '{"call_sid":"ignored"}' },
    { contentType: 'application/x-www-form-urlencoded-extra', body: 'call_sid=ignored' }
  ];
  for (const request of requests) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': request.contentType },
      body: request.body
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ verb: 'hangup' }]);
    assert.deepEqual(received.at(-1), {});
  }
});

test('malformed upstream callback URLs produce a controlled input error', async (t) => {
  const upstream = await listen(
    t,
    http.createServer((req, res) => {
      req.resume();
      res.end('<Response><Redirect>http://[invalid</Redirect></Response>');
    })
  );
  await assert.rejects(
    fetchAndConvertTarget(
      { url: upstream },
      {},
      { allowPrivateTargets: true, publicBaseUrl: 'https://bridge.example.com' }
    ),
    (err) => err instanceof InputError && /Invalid TwiML callback URL/.test(err.message)
  );
});
