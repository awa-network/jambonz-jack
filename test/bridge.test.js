'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, test } = require('node:test');
const { decodeTarget, encodeTarget, fetchAndConvertTarget, makeBridgeTargetUrl } = require('../src');
const { createServer } = require('../src/server');

const servers = [];

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

test('encodes bridge target descriptors as base64url JSON', () => {
  const encoded = encodeTarget({ url: 'https://example.com/voice', method: 'GET' });
  assert.deepEqual(decodeTarget(encoded), { url: 'https://example.com/voice', method: 'GET' });
  assert.equal(
    makeBridgeTargetUrl({ url: 'https://example.com/voice', method: 'GET' }, 'https://bridge.example.com'),
    `https://bridge.example.com/bridge?target=${encoded}`
  );
});

test('fetches TwiML target, forwards call params, and rewrites callbacks', async () => {
  let receivedBody = '';
  const server = http.createServer((req, res) => {
    req.on('data', (chunk) => {
      receivedBody += chunk.toString('utf8');
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(`
        <Response>
          <Gather action="/menu" method="POST" input="dtmf"><Say>Hello</Say></Gather>
          <Redirect method="GET">/fallback</Redirect>
        </Response>
      `);
    });
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const result = await fetchAndConvertTarget(
    { url: `http://127.0.0.1:${port}/voice`, method: 'POST' },
    { body: { call_sid: 'call-123', from: '+14155550100', digits: '7' } },
    {
      allowPrivateTargets: true,
      publicBaseUrl: 'https://bridge.example.com'
    }
  );

  const forwarded = new URLSearchParams(receivedBody);
  assert.equal(forwarded.get('CallSid'), 'call-123');
  assert.equal(forwarded.get('From'), '+14155550100');
  assert.equal(forwarded.get('Digits'), '7');

  assert.equal(result.jambonz[0].verb, 'gather');
  assert.match(result.jambonz[0].actionHook, /^https:\/\/bridge\.example\.com\/bridge\?target=/);
  assert.deepEqual(decodeTarget(new URL(result.jambonz[0].actionHook).searchParams.get('target')), {
    url: `http://127.0.0.1:${port}/menu`,
    method: 'POST'
  });
  assert.deepEqual(decodeTarget(new URL(result.jambonz[1].actionHook).searchParams.get('target')), {
    url: `http://127.0.0.1:${port}/fallback`,
    method: 'GET'
  });
});

test('blocks private targets unless explicitly allowed', async () => {
  await assert.rejects(
    () => fetchAndConvertTarget({ url: 'http://127.0.0.1/voice', method: 'POST' }, {}, {}),
    /Private TwiML target host is not allowed/
  );
});

test('server returns 502 when upstream TwiML fetch fails', async () => {
  const previousAllowPrivateTargets = process.env.ALLOW_PRIVATE_TARGETS;
  process.env.ALLOW_PRIVATE_TARGETS = 'true';
  const server = createServer();
  servers.push(server);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const target = encodeTarget({ url: 'https://127.0.0.1:1/voice', method: 'POST' });

    const res = await fetch(`http://127.0.0.1:${port}/bridge?target=${target}`, {
      method: 'POST'
    });
    const body = await res.json();

    assert.equal(res.status, 502);
    assert.equal(body.error, 'UPSTREAM_FETCH_FAILED');
    assert.equal(body.message, 'Failed to fetch TwiML target');
  } finally {
    if (previousAllowPrivateTargets === undefined) delete process.env.ALLOW_PRIVATE_TARGETS;
    else process.env.ALLOW_PRIVATE_TARGETS = previousAllowPrivateTargets;
  }
});
