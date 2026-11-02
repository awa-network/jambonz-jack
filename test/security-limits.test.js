'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { brotliCompressSync, deflateSync, gzipSync } = require('node:zlib');
const { fetchAndConvertTarget } = require('../src');

async function serveResponse(t, contentEncoding, body) {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Encoding': contentEncoding });
    res.end(body);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return { url: `http://127.0.0.1:${server.address().port}` };
}

test('decodes supported double and triple content encodings in reverse order', async (t) => {
  const xml = '<Response><Say>Hello</Say></Response>';
  const cases = [
    ['gzip, gzip', gzipSync(gzipSync(xml))],
    ['gzip, deflate, br', brotliCompressSync(deflateSync(gzipSync(xml)))]
  ];
  for (const [encoding, body] of cases) {
    const target = await serveResponse(t, encoding, body);
    const result = await fetchAndConvertTarget(target, {}, { allowPrivateTargets: true });
    assert.deepEqual(result.jambonz, [{ verb: 'say', text: 'Hello' }]);
  }
});

test('rejects excessive content encodings before trying to decompress the body', async (t) => {
  for (const count of [4, 2000]) {
    const target = await serveResponse(t, Array(count).fill('gzip').join(','), 'not compressed');
    await assert.rejects(fetchAndConvertTarget(target, {}, { allowPrivateTargets: true }), {
      code: 'UPSTREAM_FETCH_FAILED',
      message: /content encoding.*limit|too many.*content encoding/i
    });
  }
});

test('rejects unknown content encodings mixed with supported encodings', async (t) => {
  for (const encoding of ['gzip, unknown', 'unknown, gzip']) {
    const target = await serveResponse(t, encoding, 'not compressed');
    await assert.rejects(fetchAndConvertTarget(target, {}, { allowPrivateTargets: true }), {
      code: 'UPSTREAM_FETCH_FAILED',
      message: /Unsupported upstream content encoding/
    });
  }
});

test('caps compressed wire bytes even when the decoded XML is small', async (t) => {
  const maxXmlBytes = 256;
  const xml = '<Response/>';
  // Gzip allows trailing zero padding, which contributes no decoded XML bytes.
  const body = Buffer.concat([gzipSync(xml), Buffer.alloc(maxXmlBytes * 2)]);
  assert.ok(body.byteLength > maxXmlBytes);
  const target = await serveResponse(t, 'gzip', body);
  await assert.rejects(
    fetchAndConvertTarget(target, {}, { allowPrivateTargets: true, maxXmlBytes }),
    {
      code: 'UPSTREAM_FETCH_FAILED',
      message: /exceeds 256 bytes/
    }
  );
});

test('caps intermediate decompressed bytes even when wire and final XML are small', async (t) => {
  const maxXmlBytes = 256;
  const xml = '<Response/>';
  const intermediate = Buffer.concat([gzipSync(xml), Buffer.alloc(maxXmlBytes * 2)]);
  const body = gzipSync(intermediate);
  assert.ok(body.byteLength < maxXmlBytes);
  assert.ok(intermediate.byteLength > maxXmlBytes);
  const target = await serveResponse(t, 'gzip, gzip', body);
  await assert.rejects(
    fetchAndConvertTarget(target, {}, { allowPrivateTargets: true, maxXmlBytes }),
    {
      code: 'UPSTREAM_FETCH_FAILED',
      message: /exceeds 256 bytes/
    }
  );
});

test('caps final XML bytes after decompression', async (t) => {
  const maxXmlBytes = 256;
  const xml = `<Response><Say>${'x'.repeat(maxXmlBytes * 2)}</Say></Response>`;
  const body = gzipSync(xml);
  assert.ok(body.byteLength < maxXmlBytes);
  const target = await serveResponse(t, 'gzip', body);
  await assert.rejects(
    fetchAndConvertTarget(target, {}, { allowPrivateTargets: true, maxXmlBytes }),
    {
      code: 'UPSTREAM_FETCH_FAILED',
      message: /exceeds 256 bytes/
    }
  );
});
