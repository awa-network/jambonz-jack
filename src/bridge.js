'use strict';

const { convertVoiceXml } = require('./converter');

const DEFAULT_FETCH_TIMEOUT_MS = 5000;
const DEFAULT_MAX_XML_BYTES = 256 * 1024;

async function fetchAndConvertTarget(target, callContext = {}, options = {}) {
  const normalized = normalizeTarget(target);
  assertAllowedTarget(normalized.url, options);

  const response = await fetchTwiml(normalized, callContext, options);
  const currentUrl = response.url || normalized.url;
  return convertVoiceXml(response.body, {
    maxXmlBytes: options.maxXmlBytes || DEFAULT_MAX_XML_BYTES,
    defaults: options.defaults,
    hooks: {
      rewriteCallbackUrl: (nextUrl, meta = {}) => makeBridgeTargetUrl(
        {
          url: new URL(nextUrl, currentUrl).toString(),
          method: meta.method || 'POST'
        },
        options.publicBaseUrl
      )
    }
  });
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
  const url = new URL(target.url);
  const method = String(target.method || 'POST').toUpperCase();
  if (!['GET', 'POST'].includes(method)) throw new Error(`Unsupported TwiML target method: ${method}`);
  return { url: url.toString(), method };
}

function makeBridgeTargetUrl(target, publicBaseUrl) {
  if (!publicBaseUrl) return normalizeTarget(target).url;
  const url = new URL('/bridge', publicBaseUrl);
  url.searchParams.set('target', encodeTarget(target));
  return url.toString();
}

function encodeTarget(target) {
  return Buffer.from(JSON.stringify(normalizeTarget(target)), 'utf8').toString('base64url');
}

function decodeTarget(encoded) {
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (err) {
    throw new Error('Invalid base64url target descriptor');
  }
  return normalizeTarget(decoded);
}

async function fetchTwiml(target, callContext, options = {}) {
  const timeoutMs = options.fetchTimeoutMs || DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const params = toTwilioCompatibleParams(callContext);

  try {
    const request = buildRequest(target, params, controller.signal);
    let res;
    try {
      res = await fetch(request.url, request.init);
    } catch (err) {
      throw new UpstreamFetchError('Failed to fetch TwiML target', {
        target: target.url,
        cause: summarizeCause(err)
      });
    }
    if (!res.ok) {
      throw new UpstreamFetchError(`TwiML target returned HTTP ${res.status}`, {
        target: target.url,
        status: res.status
      });
    }
    try {
      const body = await readLimitedResponse(res, options.maxXmlBytes || DEFAULT_MAX_XML_BYTES);
      return { body, url: res.url };
    } catch (err) {
      throw new UpstreamFetchError(err.message, { target: target.url });
    }
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeCause(err) {
  const cause = err.cause || err;
  if (cause?.errors && Array.isArray(cause.errors)) {
    return cause.errors.map((item) => ({
      code: item.code,
      address: item.address,
      port: item.port,
      syscall: item.syscall
    }));
  }
  return {
    code: cause?.code,
    address: cause?.address,
    port: cause?.port,
    syscall: cause?.syscall
  };
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
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) throw new Error(`TwiML response exceeds ${limit} bytes`);
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function toTwilioCompatibleParams(callContext = {}) {
  const payload = callContext.body && typeof callContext.body === 'object' ? callContext.body : {};
  const query = callContext.query && typeof callContext.query === 'object' ? callContext.query : {};
  const source = { ...query, ...payload };
  const speech = source.speech?.alternatives?.[0]?.transcript || source.speech?.alternatives?.[0]?.transcript;

  return cleanParams({
    AccountSid: source.account_sid || source.accountSid || source.AccountSid,
    CallSid: source.call_sid || source.callSid || source.CallSid || source.call_id,
    CallStatus: source.call_status || source.callStatus || source.CallStatus,
    Direction: source.direction || source.Direction,
    From: source.from || source.From || source.caller_id,
    To: source.to || source.To || source.called_number,
    Digits: source.digits || source.Digits,
    SpeechResult: source.speech_result || source.SpeechResult || speech,
    RecordingUrl: source.recording_url || source.RecordingUrl,
    RecordingDuration: source.recording_duration || source.RecordingDuration,
    DialCallStatus: source.dial_call_status || source.DialCallStatus,
    DialCallSid: source.dial_call_sid || source.DialCallSid
  });
}

function cleanParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') out[key] = String(value);
  }
  return out;
}

function assertAllowedTarget(targetUrl, options = {}) {
  const url = new URL(targetUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('TwiML target must use http or https');

  const allowedHosts = parseList(options.allowedTwimlHosts);
  if (allowedHosts.length && !allowedHosts.includes(url.hostname)) {
    throw new Error(`TwiML target host is not allowed: ${url.hostname}`);
  }

  if (!options.allowPrivateTargets && isPrivateHostname(url.hostname)) {
    throw new Error(`Private TwiML target host is not allowed: ${url.hostname}`);
  }
}

function parseList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === 'metadata.google.internal') return true;
  if (host === '::1' || host.startsWith('fe80:')) return true;

  const parts = host.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

module.exports = {
  decodeTarget,
  encodeTarget,
  fetchAndConvertTarget,
  makeBridgeTargetUrl,
  toTwilioCompatibleParams,
  UpstreamFetchError
};
