'use strict';

const assert = require('node:assert/strict');
const dns = require('node:dns');
const http = require('node:http');
const { test } = require('node:test');
const { decodeTarget, encodeTarget, fetchAndConvertTarget, convertVoiceXml } = require('../src');
const { isPublicAddress, safeLookup } = require('../src/targets');
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

test('rejects non-object and malformed target descriptors without recursion', () => {
  for (const value of [null, [], 42, 'e30', true]) {
    const target = Buffer.from(JSON.stringify(value)).toString('base64url');
    assert.throws(() => decodeTarget(target), /descriptor must be an object/);
  }
  for (const value of ['', '!!!', 'a'.repeat(8193)]) {
    assert.throws(() => decodeTarget(value), /Invalid base64url/);
  }
  for (const url of ['file:///etc/passwd', 'https://user:password@example.com', 'not a url']) {
    assert.throws(() => encodeTarget({ url }), /TwiML target/);
  }
});

test('signed descriptors reject changed targets, changed methods, unsigned input and wrong keys', () => {
  const options = { targetSigningSecret: 'a'.repeat(32) };
  const target = { url: 'https://voice.example.com/start', method: 'POST' };
  const signed = encodeTarget(target, options);
  assert.deepEqual(decodeTarget(signed, options), target);
  const signature = signed.split('.')[1];
  for (const altered of [
    encodeTarget(target),
    `${encodeTarget({ ...target, method: 'GET' })}.${signature}`,
    `${encodeTarget({ url: 'https://other.example.com' })}.${signature}`,
    `${signed}.extra`
  ]) {
    assert.throws(() => decodeTarget(altered, options), /Invalid target signature/);
  }
  assert.throws(
    () => decodeTarget(signed, { targetSigningSecret: 'b'.repeat(32) }),
    /Invalid target signature/
  );
  assert.throws(() => decodeTarget(signed), /Signed targets require/);
});

test('classifies non-public IPv4 and IPv6 addresses defensively', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '0.0.0.0',
    '169.254.169.254',
    '100.88.13.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    'not-an-ip'
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('blocks private and alternative-format literal targets', async () => {
  for (const host of [
    '[::1]',
    '[::ffff:127.0.0.1]',
    '[fc00::1]',
    '2130706433',
    '0x7f000001',
    'localhost.'
  ]) {
    await assert.rejects(fetchAndConvertTarget({ url: `http://${host}/` }), /Private TwiML target/);
  }
});

test('DNS checks reject any private answer and return the checked public records', async (t) => {
  const records = [
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 }
  ];
  let lookups = 0;
  t.mock.method(dns, 'lookup', (host, options, callback) => {
    lookups++;
    assert.equal(options.all, true);
    callback(null, records);
  });
  const lookup = () =>
    new Promise((resolve, reject) =>
      safeLookup('voice.example.com', { all: true }, (err, addresses) =>
        err ? reject(err) : resolve(addresses)
      )
    );
  await assert.rejects(lookup(), /Private TwiML target/);
  records.pop();
  assert.deepEqual(await lookup(), records);
  assert.equal(lookups, 2);
});

test('the outbound socket rejects a hostname resolving to loopback', async (t) => {
  t.mock.method(dns, 'lookup', (host, options, callback) => {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  });
  await assert.rejects(
    fetchAndConvertTarget({ url: 'http://voice.example.com/' }),
    /Private TwiML target/
  );
});

test('HTTP redirects cannot escape the hostname allowlist', async (t) => {
  const upstream = await listen(
    t,
    http.createServer((req, res) => {
      res.writeHead(307, { Location: 'http://localhost/forbidden' });
      res.end();
    })
  );
  await assert.rejects(
    fetchAndConvertTarget(
      { url: upstream },
      {},
      {
        allowPrivateTargets: true,
        allowedTwimlHosts: '127.0.0.1'
      }
    ),
    /host is not allowed/
  );
});

test('bounds XML nesting before recursive conversion', () => {
  assert.throws(
    () =>
      convertVoiceXml(`<Response>${'<Say>'.repeat(1000)}hello${'</Say>'.repeat(1000)}</Response>`),
    /XML nesting limit exceeded/
  );
});

test('malformed request URLs return 400 and leave the server alive', async (t) => {
  const base = await listen(t, createServer({ env: {}, log() {} }));
  const status = await new Promise((resolve, reject) => {
    const req = http.request(base, { method: 'POST', path: '//[' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 400);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('oversized uploads return 413 and malformed JSON returns 400', async (t) => {
  const base = await listen(t, createServer({ env: { MAX_XML_BYTES: '32' }, log() {} }));
  const large = await fetch(`${base}/convert`, { method: 'POST', body: 'x'.repeat(100) });
  assert.equal(large.status, 413);
  const malformed = await fetch(`${base}/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{invalid'
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).message, 'Invalid JSON request body');
});

test('logs and upstream errors omit URL secrets and ignore forged forwarding headers', async (t) => {
  const logs = [];
  const base = await listen(
    t,
    createServer({
      env: { ALLOW_PRIVATE_TARGETS: 'true' },
      log: (event, fields) => logs.push({ event, ...fields })
    })
  );
  const target = encodeTarget({ url: 'https://127.0.0.1:1/private-secret?token=query-secret' });
  const response = await fetch(`${base}/bridge?target=${target}`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': 'spoofed-client' }
  });
  assert.equal(response.status, 502);
  const output = JSON.stringify(logs) + (await response.text());
  for (const secret of ['private-secret', 'query-secret', 'spoofed-client', target]) {
    assert.equal(output.includes(secret), false);
  }
});
