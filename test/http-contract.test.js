'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { test } = require('node:test');
const { decodeTarget, encodeTarget } = require('../src');
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

function startUpload(t, url, bodyLength) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(
      url,
      {
        method: 'POST',
        agent: false,
        headers: { 'Content-Length': bodyLength },
        signal: t.signal
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    request.on('error', reject);
  });
  t.after(() => request.destroy());
  return { request, response };
}

test(
  'signed bridge routes survive a complete callback round trip',
  { timeout: 5000 },
  async (t) => {
    const received = [];
    const upstream = await listen(
      t,
      http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          received.push({
            path: req.url,
            method: req.method,
            params: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
          });
          res.end(
            req.url === '/start'
              ? '<Response><Gather action="/next"><Say>Press a key</Say></Gather></Response>'
              : '<Response><Say>Done</Say><Hangup/></Response>'
          );
        });
      })
    );
    const signingOptions = { targetSigningSecret: 'test-signing-key-'.repeat(2) };
    const base = await listen(
      t,
      createServer({
        env: {
          TARGET_SIGNING_SECRET: signingOptions.targetSigningSecret,
          ALLOW_PRIVATE_TARGETS: 'true'
        },
        log() {}
      })
    );
    const target = { url: `${upstream}/start`, method: 'POST' };
    const unsigned = await fetch(`${base}/bridge?target=${encodeTarget(target)}`, {
      method: 'POST',
      signal: t.signal
    });
    assert.equal(unsigned.status, 403);
    assert.equal((await unsigned.json()).error, 'INVALID_TARGET_SIGNATURE');
    assert.deepEqual(received, []);

    const initial = await fetch(`${base}/bridge?target=${encodeTarget(target, signingOptions)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_sid: 'signed-call' }),
      signal: t.signal
    });
    assert.equal(initial.status, 200);
    const [gather] = await initial.json();
    assert.equal(gather.verb, 'gather');
    const callback = new URL(gather.actionHook);
    assert.equal(callback.origin, base);
    assert.equal(callback.pathname, '/bridge');
    assert.deepEqual(decodeTarget(callback.searchParams.get('target'), signingOptions), {
      url: `${upstream}/next`,
      method: 'POST'
    });

    const next = await fetch(callback, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_sid: 'signed-call', digits: '7' }),
      signal: t.signal
    });
    assert.equal(next.status, 200);
    assert.deepEqual(await next.json(), [{ verb: 'say', text: 'Done' }, { verb: 'hangup' }]);
    assert.deepEqual(received, [
      { path: '/start', method: 'POST', params: { CallSid: 'signed-call' } },
      { path: '/next', method: 'POST', params: { CallSid: 'signed-call', Digits: '7' } }
    ]);
  }
);

test(
  'production routing requirements leave health and direct conversion available',
  { timeout: 5000 },
  async (t) => {
    const configurations = [
      {},
      { PUBLIC_BASE_URL: 'https://bridge.example.com' },
      { ALLOWED_TWIML_HOSTS: 'example.com' }
    ];
    for (const routing of configurations) {
      const base = await listen(
        t,
        createServer({ env: { NODE_ENV: 'production', ...routing }, log() {} })
      );
      const target = encodeTarget({ url: 'http://127.0.0.1:1/voice' });
      const bridge = await fetch(`${base}/bridge?target=${target}`, {
        method: 'POST',
        signal: t.signal
      });
      assert.equal(bridge.status, 503);
      assert.equal((await bridge.json()).error, 'BRIDGE_NOT_CONFIGURED');
      for (const path of ['/health', '/healthz']) {
        const health = await fetch(`${base}${path}`, { signal: t.signal });
        assert.equal(health.status, 200);
        assert.equal((await health.json()).ok, true);
      }
      for (const path of ['/convert', '/twiml', '/laml', '/cxml']) {
        const converted = await fetch(`${base}${path}`, {
          method: 'POST',
          body: '<Response><Hangup/></Response>',
          signal: t.signal
        });
        assert.equal(converted.status, 200);
        assert.deepEqual(await converted.json(), [{ verb: 'hangup' }]);
      }
    }
  }
);

test(
  'incomplete uploads receive a deadline response and release capacity',
  { timeout: 5000 },
  async (t) => {
    const base = await listen(
      t,
      createServer({ env: { REQUEST_TIMEOUT_MS: '50', MAX_CONCURRENT_REQUESTS: '1' }, log() {} })
    );
    const xml = '<Response><Hangup/></Response>';
    const upload = startUpload(t, `${base}/convert`, Buffer.byteLength(xml));
    upload.request.write('<Response>');
    const response = await upload.response;
    assert.equal(response.status, 408);
    assert.equal(JSON.parse(response.body).error, 'REQUEST_TIMEOUT');

    const recovered = await fetch(`${base}/convert`, {
      method: 'POST',
      body: xml,
      signal: t.signal
    });
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), [{ verb: 'hangup' }]);
  }
);

test(
  'busy conversion requests return 503 and recover when the active upload finishes',
  { timeout: 5000 },
  async (t) => {
    const server = createServer({ env: { MAX_CONCURRENT_REQUESTS: '1' }, log() {} });
    const base = await listen(t, server);
    const xml = '<Response><Hangup/></Response>';
    const requestArrived = once(server, 'request', { signal: t.signal });
    const upload = startUpload(t, `${base}/convert`, Buffer.byteLength(xml));
    upload.request.write('<Response>');
    // The request event follows the server handler's admission and wait for its body.
    await requestArrived;

    const busy = await fetch(`${base}/convert`, {
      method: 'POST',
      body: xml,
      signal: t.signal
    });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '1');
    assert.equal((await busy.json()).error, 'SERVER_BUSY');

    upload.request.end('<Hangup/></Response>');
    const completed = await upload.response;
    assert.equal(completed.status, 200);
    assert.deepEqual(JSON.parse(completed.body), [{ verb: 'hangup' }]);

    const recovered = await fetch(`${base}/convert`, {
      method: 'POST',
      body: xml,
      signal: t.signal
    });
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), [{ verb: 'hangup' }]);
  }
);
