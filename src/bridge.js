'use strict';

const http = require('node:http');
const https = require('node:https');
const { createHmac, timingSafeEqual } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { createGunzip, createInflate, createBrotliDecompress } = require('node:zlib');
const { convertVoiceXml } = require('./converter');
const { InputError } = require('./errors');
const { assertAllowedTarget, safeLookup } = require('./targets');
const { DEFAULT_FETCH_TIMEOUT_MS, DEFAULT_MAX_XML_BYTES } = require('./limits');

const MAX_DESCRIPTOR_LENGTH = 8192;
const MAX_REDIRECTS = 5;
const MAX_CONTENT_ENCODINGS = 3;

async function fetchAndConvertTarget(target, callContext = {}, options = {}) {
  const normalized =
    typeof target === 'string' ? decodeTarget(target, options) : normalizeTarget(target);
  assertAllowedTarget(normalized.url, options);

  const response = await fetchTwiml(normalized, callContext, options);
  const currentUrl = response.url || normalized.url;
  return convertVoiceXml(response.body, {
    maxXmlBytes: options.maxXmlBytes || DEFAULT_MAX_XML_BYTES,
    defaults: options.defaults,
    hooks: {
      rewriteCallbackUrl: (nextUrl, meta = {}) =>
        makeBridgeTargetUrl(
          {
            url: resolveCallbackUrl(nextUrl, currentUrl),
            method: meta.method || 'POST'
          },
          options.publicBaseUrl,
          options
        )
    }
  });
}

function resolveCallbackUrl(nextUrl, currentUrl) {
  try {
    return new URL(nextUrl, currentUrl).toString();
  } catch {
    throw new InputError('Invalid TwiML callback URL');
  }
}

class UpstreamFetchError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'UpstreamFetchError';
    this.code = 'UPSTREAM_FETCH_FAILED';
    this.details = details;
  }
}

function normalizeTarget(target) {
  if (typeof target === 'string') return decodeTarget(target);
  if (
    !target ||
    typeof target !== 'object' ||
    Array.isArray(target) ||
    typeof target.url !== 'string'
  ) {
    throw new InputError('Target descriptor must contain a URL string');
  }
  let url;
  try {
    url = new URL(target.url);
  } catch {
    throw new InputError('Invalid TwiML target URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new InputError('TwiML target must use http or https without URL credentials');
  }
  const method = String(target.method || 'POST').toUpperCase();
  if (!['GET', 'POST'].includes(method))
    throw new InputError('TwiML target method must be GET or POST');
  return { url: url.toString(), method };
}

function makeBridgeTargetUrl(target, publicBaseUrl, options = {}) {
  if (!publicBaseUrl) return normalizeTarget(target).url;
  const url = new URL('/bridge', publicBaseUrl);
  url.searchParams.set('target', encodeTarget(target, options));
  return url.toString();
}

function encodeTarget(target, options = {}) {
  const encoded = Buffer.from(JSON.stringify(normalizeTarget(target)), 'utf8').toString(
    'base64url'
  );
  const token = options.targetSigningSecret
    ? `${encoded}.${signTarget(encoded, options.targetSigningSecret).toString('base64url')}`
    : encoded;
  if (token.length > MAX_DESCRIPTOR_LENGTH) {
    throw new InputError(`Target descriptor exceeds ${MAX_DESCRIPTOR_LENGTH} characters`);
  }
  return token;
}

function signTarget(encoded, secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error('TARGET_SIGNING_SECRET must contain at least 32 bytes');
  }
  return createHmac('sha256', secret).update(encoded).digest();
}

function decodeTarget(token, options = {}) {
  if (typeof token !== 'string' || token.length > MAX_DESCRIPTOR_LENGTH) {
    throw new InputError('Invalid base64url target descriptor');
  }
  const [encoded, signature, extra] = token.split('.');
  if (options.targetSigningSecret) {
    const expected = signTarget(encoded, options.targetSigningSecret);
    const supplied =
      typeof signature === 'string' && /^[A-Za-z0-9_-]{43}$/.test(signature)
        ? Buffer.from(signature, 'base64url')
        : Buffer.alloc(0);
    if (
      extra !== undefined ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new InputError('Invalid target signature', 'INVALID_TARGET_SIGNATURE');
    }
  } else if (signature !== undefined) {
    throw new InputError(
      'Signed targets require TARGET_SIGNING_SECRET',
      'INVALID_TARGET_SIGNATURE'
    );
  }
  if (
    typeof encoded !== 'string' ||
    encoded.length > MAX_DESCRIPTOR_LENGTH ||
    !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)
  ) {
    throw new InputError('Invalid base64url target descriptor');
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new InputError('Invalid base64url target descriptor');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new InputError('Target descriptor must be an object');
  }
  return normalizeTarget(decoded);
}

async function fetchTwiml(target, callContext, options = {}) {
  const timeoutMs = options.fetchTimeoutMs || DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const params = toTwilioCompatibleParams(callContext);
    const request = buildRequest(target, params, signal);
    let url = new URL(request.url);
    let init = request.init;
    for (let redirects = 0; ; redirects++) {
      assertAllowedTarget(url, options);
      const res = await requestTarget(url, init, options);
      try {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirects >= MAX_REDIRECTS)
            throw new UpstreamFetchError('Too many TwiML target redirects');
          const nextUrl = new URL(res.headers.location, url);
          if (url.protocol === 'https:' && nextUrl.protocol !== 'https:') {
            throw new InputError('HTTPS TwiML targets cannot redirect to HTTP');
          }
          if (
            res.statusCode === 303 ||
            ([301, 302].includes(res.statusCode) && init.method === 'POST')
          ) {
            init = { method: 'GET', signal };
          }
          url = nextUrl;
          continue;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          throw new UpstreamFetchError(`TwiML target returned HTTP ${res.statusCode}`, {
            status: res.statusCode
          });
        }
        const body = await readLimitedResponse(res, options.maxXmlBytes || DEFAULT_MAX_XML_BYTES);
        return { body, url: url.toString() };
      } finally {
        res.destroy();
      }
    }
  } catch (err) {
    if (err instanceof InputError || err instanceof UpstreamFetchError) throw err;
    throw new UpstreamFetchError('Failed to fetch TwiML target');
  } finally {
    clearTimeout(timeout);
  }
}

function requestTarget(url, init, options) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      url,
      {
        method: init.method,
        headers: init.headers,
        signal: init.signal,
        agent: false,
        lookup: options.allowPrivateTargets ? undefined : safeLookup
      },
      resolve
    );
    req.on('error', reject);
    req.end(init.body?.toString());
  });
}

function buildRequest(target, params, signal) {
  if (target.method === 'GET') {
    const url = new URL(target.url);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return { url, init: { method: 'GET', signal } };
  }

  return {
    url: target.url,
    init: {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params)
    }
  };
}

async function readLimitedResponse(res, limit) {
  const chunks = [];
  const decoders = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress };
  const encodings = (res.headers['content-encoding'] || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value && value !== 'identity');
  // Validate the entire stack before allocating native decompressor buffers.
  if (encodings.length > MAX_CONTENT_ENCODINGS) {
    throw new UpstreamFetchError('Too many upstream content encodings');
  }
  if (encodings.some((encoding) => !Object.hasOwn(decoders, encoding))) {
    throw new UpstreamFetchError('Unsupported upstream content encoding');
  }
  async function* limitBytes(source) {
    let size = 0;
    for await (const value of source) {
      size += value.byteLength;
      if (size > limit) throw new UpstreamFetchError(`TwiML response exceeds ${limit} bytes`);
      yield value;
    }
  }
  const transforms = [];
  try {
    for (const encoding of encodings.reverse()) transforms.push(decoders[encoding]());
    // Bound wire bytes and each decoding stage, including data a later decoder discards.
    await pipeline(
      res,
      limitBytes,
      ...transforms.flatMap((stream) => [stream, limitBytes]),
      async (source) => {
        for await (const value of source) chunks.push(value);
      }
    );
  } finally {
    for (const stream of transforms) stream.destroy();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function toTwilioCompatibleParams(callContext = {}) {
  if (!callContext || typeof callContext !== 'object' || Array.isArray(callContext)) {
    throw new InputError('Call context must be an object');
  }
  const payload = callContext.body && typeof callContext.body === 'object' ? callContext.body : {};
  const query = callContext.query && typeof callContext.query === 'object' ? callContext.query : {};
  const source = { ...query, ...payload };
  const speech = source.speech?.alternatives?.[0]?.transcript;

  return cleanParams({
    AccountSid: firstValue(source.account_sid, source.accountSid, source.AccountSid),
    CallSid: firstValue(source.call_sid, source.callSid, source.CallSid, source.call_id),
    CallStatus: firstValue(source.call_status, source.callStatus, source.CallStatus),
    Direction: firstValue(source.direction, source.Direction),
    From: firstValue(source.from, source.From, source.caller_id),
    To: firstValue(source.to, source.To, source.called_number),
    Digits: firstValue(source.digits, source.Digits),
    SpeechResult: firstValue(source.speech_result, source.SpeechResult, speech),
    RecordingUrl: firstValue(source.recording_url, source.RecordingUrl),
    RecordingDuration: firstValue(source.recording_duration, source.RecordingDuration),
    DialCallStatus: firstValue(source.dial_call_status, source.DialCallStatus),
    DialCallSid: firstValue(source.dial_call_sid, source.DialCallSid)
  });
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function cleanParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null &&
      (!['string', 'number', 'boolean'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value)))
    ) {
      throw new InputError(`Callback parameter ${key} must be a scalar`);
    }
    if (value !== undefined && value !== null && value !== '') out[key] = String(value);
  }
  return out;
}

module.exports = {
  decodeTarget,
  encodeTarget,
  fetchAndConvertTarget,
  makeBridgeTargetUrl,
  toTwilioCompatibleParams,
  UpstreamFetchError
};
