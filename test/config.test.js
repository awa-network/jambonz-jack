'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { readConversionDefaults, readListenOptions, readServerConfig } = require('../src/config');
const { encodeTarget } = require('../src');
const { createServer } = require('../src/server');

async function listen(t, server) {
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
  return `http://127.0.0.1:${server.address().port}`;
}

test('server configuration preserves documented default limits and reads overrides', () => {
  const defaults = readServerConfig({});
  assert.equal(defaults.maxXmlBytes, 262144);
  assert.equal(defaults.fetchTimeoutMs, 5000);
  assert.equal(defaults.requestTimeoutMs, 10000);
  assert.equal(defaults.maxConcurrentRequests, 64);
  const config = readServerConfig({
    MAX_XML_BYTES: '4096',
    FETCH_TIMEOUT_MS: '800',
    REQUEST_TIMEOUT_MS: '1200',
    MAX_CONCURRENT_REQUESTS: '8'
  });
  assert.equal(config.maxXmlBytes, 4096);
  assert.equal(config.fetchTimeoutMs, 800);
  assert.equal(config.requestTimeoutMs, 1200);
  assert.equal(config.maxConcurrentRequests, 8);
});

test('invalid server limits fail during construction and identify only the setting', () => {
  for (const name of [
    'MAX_XML_BYTES',
    'FETCH_TIMEOUT_MS',
    'REQUEST_TIMEOUT_MS',
    'MAX_CONCURRENT_REQUESTS'
  ]) {
    for (const value of ['0', '-1', '1.5', '2147483648', 'private-setting-value']) {
      assert.throws(
        () => createServer({ env: { [name]: value }, log() {} }),
        (err) => {
          assert.match(err.message, new RegExp(name));
          assert.equal(err.message.includes('private-setting-value'), false);
          return true;
        }
      );
    }
  }
});

test('listen configuration preserves defaults and supports explicit hosts and boundary ports', () => {
  assert.deepEqual(readListenOptions({}), { port: 3000, host: undefined });
  assert.deepEqual(readListenOptions({ PORT: '', HOST: '' }), { port: 3000, host: undefined });
  assert.deepEqual(readListenOptions({ PORT: '0', HOST: '127.0.0.1' }), {
    port: 0,
    host: '127.0.0.1'
  });
  assert.deepEqual(readListenOptions({ PORT: '65535', HOST: '::1' }), { port: 65535, host: '::1' });
});

test('listen configuration rejects malformed and out-of-range ports without echoing input', () => {
  for (const value of [
    '3000suffix',
    '3000.5',
    '-1',
    '65536',
    ' ',
    '0x10',
    '1e3',
    'private-port-value'
  ]) {
    assert.throws(
      () => readListenOptions({ PORT: value }),
      (err) => {
        assert.match(err.message, /PORT/);
        assert.equal(err.message.includes('private-port-value'), false);
        return true;
      }
    );
  }
});

test('public callback bases must be absolute HTTP URLs without credentials', () => {
  for (const value of [
    '/relative',
    'not a URL',
    'file:///private-path',
    'https://user:private-password@bridge.example.com'
  ]) {
    assert.throws(
      () => createServer({ env: { PUBLIC_BASE_URL: value }, log() {} }),
      (err) => {
        assert.match(err.message, /PUBLIC_BASE_URL/);
        assert.equal(err.message.includes('private-password'), false);
        assert.equal(err.message.includes('private-path'), false);
        return true;
      }
    );
  }
  for (const value of ['', 'http://bridge.example.com', 'https://bridge.example.com/path']) {
    assert.doesNotThrow(() => readServerConfig({ PUBLIC_BASE_URL: value }));
  }
});

test('signing secrets are validated by UTF-8 byte length without appearing in errors', () => {
  for (const secret of ['short-private-secret', 'a'.repeat(31), 'é'.repeat(15)]) {
    assert.throws(
      () => createServer({ env: { TARGET_SIGNING_SECRET: secret }, log() {} }),
      (err) => {
        assert.match(err.message, /TARGET_SIGNING_SECRET/);
        assert.equal(err.message.includes(secret), false);
        return true;
      }
    );
  }
  for (const secret of ['', 'a'.repeat(32), 'é'.repeat(16)]) {
    assert.doesNotThrow(() => readServerConfig({ TARGET_SIGNING_SECRET: secret }));
  }
});

test('conversion defaults read all supported environment settings', () => {
  assert.deepEqual(
    readConversionDefaults({
      DEFAULT_TTS_LANGUAGE: 'de-DE',
      DEFAULT_SYNTH_VENDOR: 'synth-provider',
      DEFAULT_STT_VENDOR: 'speech-provider',
      RECORDING_WS_URL: 'wss://record.example.com/audio'
    }),
    {
      language: 'de-DE',
      synthesizerVendor: 'synth-provider',
      recognizerVendor: 'speech-provider',
      recordingWsUrl: 'wss://record.example.com/audio'
    }
  );
});

test('direct and bridge requests use the configuration captured at server construction', async (t) => {
  const xml = '<Response><Gather input="speech" action="/next"/><Record/></Response>';
  const upstream = await listen(
    t,
    http.createServer((req, res) => {
      req.resume();
      res.end(xml);
    })
  );
  const env = {
    NODE_ENV: 'production',
    ALLOW_PRIVATE_TARGETS: 'true',
    ALLOWED_TWIML_HOSTS: '127.0.0.1',
    PUBLIC_BASE_URL: 'https://bridge.example.com',
    DEFAULT_TTS_LANGUAGE: 'de-DE',
    DEFAULT_STT_VENDOR: 'original-provider',
    RECORDING_WS_URL: 'wss://record.example.com/audio'
  };
  const server = createServer({ env, log() {} });
  Object.assign(env, {
    ALLOW_PRIVATE_TARGETS: 'false',
    ALLOWED_TWIML_HOSTS: 'other.example.com',
    PUBLIC_BASE_URL: 'https://other.example.com',
    MAX_XML_BYTES: '1',
    DEFAULT_TTS_LANGUAGE: 'en-US',
    DEFAULT_STT_VENDOR: 'changed-provider',
    RECORDING_WS_URL: 'wss://other.example.com/audio'
  });
  const base = await listen(t, server);
  const directResponse = await fetch(`${base}/convert`, { method: 'POST', body: xml });
  assert.equal(directResponse.status, 200);
  const direct = await directResponse.json();
  assert.deepEqual(direct[0].recognizer, { vendor: 'original-provider', language: 'de-DE' });
  assert.equal(direct[1].url, 'wss://record.example.com/audio');

  const target = encodeTarget({ url: upstream });
  const bridgeResponse = await fetch(`${base}/bridge?target=${target}`, { method: 'POST' });
  assert.equal(bridgeResponse.status, 200);
  const bridge = await bridgeResponse.json();
  assert.deepEqual(bridge[0].recognizer, direct[0].recognizer);
  assert.equal(bridge[1].url, direct[1].url);
  assert.equal(new URL(bridge[0].actionHook).origin, 'https://bridge.example.com');
});
