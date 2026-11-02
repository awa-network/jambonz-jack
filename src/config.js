'use strict';

const { parseList } = require('./targets');
const {
  DEFAULT_MAX_XML_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  positiveInteger
} = require('./limits');

function readConversionDefaults(env = process.env) {
  return {
    language: env.DEFAULT_TTS_LANGUAGE,
    synthesizerVendor: env.DEFAULT_SYNTH_VENDOR,
    recognizerVendor: env.DEFAULT_STT_VENDOR,
    recordingWsUrl: env.RECORDING_WS_URL
  };
}

function readListenOptions(env = process.env) {
  const value = env.PORT === undefined || env.PORT === '' ? '3000' : String(env.PORT);
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  return { port, host: env.HOST || undefined };
}

function readServerConfig(env = process.env) {
  const targetSigningSecret = env.TARGET_SIGNING_SECRET;
  if (
    targetSigningSecret &&
    (typeof targetSigningSecret !== 'string' || Buffer.byteLength(targetSigningSecret) < 32)
  ) {
    throw new Error('TARGET_SIGNING_SECRET must contain at least 32 bytes');
  }
  if (env.PUBLIC_BASE_URL) {
    try {
      const url = new URL(env.PUBLIC_BASE_URL);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error();
    } catch {
      throw new Error('PUBLIC_BASE_URL must be an absolute HTTP or HTTPS URL without credentials');
    }
  }
  return {
    maxXmlBytes: positiveInteger(env.MAX_XML_BYTES, DEFAULT_MAX_XML_BYTES, 'MAX_XML_BYTES'),
    fetchTimeoutMs: positiveInteger(
      env.FETCH_TIMEOUT_MS,
      DEFAULT_FETCH_TIMEOUT_MS,
      'FETCH_TIMEOUT_MS'
    ),
    requestTimeoutMs: positiveInteger(
      env.REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      'REQUEST_TIMEOUT_MS'
    ),
    maxConcurrentRequests: positiveInteger(
      env.MAX_CONCURRENT_REQUESTS,
      DEFAULT_MAX_CONCURRENT_REQUESTS,
      'MAX_CONCURRENT_REQUESTS'
    ),
    publicBaseUrl: env.PUBLIC_BASE_URL,
    allowedTwimlHosts: parseList(env.ALLOWED_TWIML_HOSTS),
    allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === 'true',
    production: env.NODE_ENV === 'production',
    targetSigningSecret,
    defaults: readConversionDefaults(env)
  };
}

module.exports = { readConversionDefaults, readListenOptions, readServerConfig };
