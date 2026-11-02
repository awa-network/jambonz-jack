'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { gzipSync } = require('node:zlib');
const { test } = require('node:test');
const { convertVoiceXml, fetchAndConvertTarget, XmlParseError } = require('../src');
const { toTwilioCompatibleParams } = require('../src/bridge');
const { createServer } = require('../src/server');

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test('parses quoted delimiters, CDATA, entities and XML namespaces', () => {
  const result = convertVoiceXml(
    '<v:Response xmlns:v="urn:test"><v:Say unused="a > b"><![CDATA[A < B]]> &amp; &#x1F600;</v:Say></v:Response>'
  );
  assert.deepEqual(result.jambonz, [{ verb: 'say', text: 'A < B & \u{1f600}' }]);
});

test('rejects malformed attributes, entities, nesting and forbidden code points', () => {
  const invalid = [
    '<Response><Say loop="1" loop="2">text</Say></Response>',
    '<Response><Say loop="1"voice="x">text</Say></Response>',
    '<Response><Say a="<">text</Say></Response>',
    '<Response><Say>&unknown;</Say></Response>',
    '<Response><Say>&AMP;</Say></Response>',
    '<Response><Say>&#x110000;</Say></Response>',
    '<Response><Say>&#0;</Say></Response>',
    '<Response><Say>&#xD800;</Say></Response>',
    '<Response><Say>\u0000</Say></Response>',
    '<Response><Say>\ud800</Say></Response>',
    '<Response><Say>A & B</Say></Response>',
    '<Response><Say>]]></Say></Response>',
    '<Response><a:Say>text</b:Say></Response>',
    '<Response><!-- a -- b --></Response>',
    '<Response></Response></Response>',
    '<Response><Say>unfinished</Response>'
  ];
  for (const xml of invalid) assert.throws(() => convertVoiceXml(xml), XmlParseError, xml);
});

test('preserves numeric zero callback values and rejects structured scalar fields', () => {
  assert.deepEqual(toTwilioCompatibleParams({ body: { digits: 0, recording_duration: 0 } }), {
    Digits: '0',
    RecordingDuration: '0'
  });
  assert.throws(
    () => toTwilioCompatibleParams({ body: { from: { toString: 'invalid' } } }),
    /must be a scalar/
  );
  assert.throws(() => toTwilioCompatibleParams(null), /Call context must be an object/);
});

test('handles compressed XML and caps the decompressed body', async (t) => {
  const upstream = await listen(
    t,
    http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Encoding': 'gzip' });
      res.end(gzipSync('<Response><Say>Hello</Say></Response>'));
    })
  );
  const target = { url: upstream };
  const options = { allowPrivateTargets: true };
  assert.deepEqual((await fetchAndConvertTarget(target, {}, options)).jambonz, [
    { verb: 'say', text: 'Hello' }
  ]);
  await assert.rejects(
    fetchAndConvertTarget(target, {}, { ...options, maxXmlBytes: 16 }),
    /response exceeds 16/
  );
});

test('redirects preserve POST on 307 and use GET on 302', async (t) => {
  const methods = [];
  const upstream = await listen(
    t,
    http.createServer((req, res) => {
      methods.push(req.method);
      req.resume();
      if (req.url === '/start') res.writeHead(307, { Location: '/post' });
      else if (req.url === '/post') res.writeHead(302, { Location: '/get' });
      res.end(req.url === '/get' ? '<Response><Redirect>/next</Redirect></Response>' : '');
    })
  );
  const result = await fetchAndConvertTarget(
    { url: `${upstream}/start` },
    {},
    { allowPrivateTargets: true }
  );
  assert.deepEqual(methods, ['POST', 'POST', 'GET']);
  assert.equal(result.jambonz[0].actionHook, `${upstream}/next`);
});

test('upstream deadlines abort a stalled response body', async (t) => {
  let closed;
  const didClose = new Promise((resolve) => {
    closed = resolve;
  });
  const upstream = await listen(
    t,
    http.createServer((req, res) => {
      res.writeHead(200);
      res.write('<Response>');
      res.on('close', closed);
    })
  );
  await assert.rejects(
    fetchAndConvertTarget(
      { url: upstream },
      {},
      {
        allowPrivateTargets: true,
        fetchTimeoutMs: 50
      }
    ),
    /Failed to fetch TwiML target/
  );
  await didClose;
});

test('aborted inbound uploads do not produce uncaught stream errors', async (t) => {
  const base = await listen(t, createServer({ env: {}, log() {} }));
  await new Promise((resolve) => {
    const req = http.request(`${base}/convert`, {
      method: 'POST',
      headers: { 'Content-Length': '1000' }
    });
    req.on('error', resolve);
    req.write('<Response>');
    setTimeout(() => req.destroy(new Error('test disconnect')), 20);
  });
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
});
