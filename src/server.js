'use strict';

const http = require('node:http');
const packageInfo = require('../package.json');
const { decodeTarget, fetchAndConvertTarget } = require('./bridge');
const { convertVoiceXml } = require('./converter');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const MAX_XML_BYTES = Number.parseInt(process.env.MAX_XML_BYTES || String(256 * 1024), 10);
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.FETCH_TIMEOUT_MS || '5000', 10);

function createServer() {
  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestUrl = new URL(req.url, 'http://localhost');
    const requestLog = requestSummary(req, requestUrl);
    logInfo('incoming', requestLog);
    res.on('finish', () => {
      logInfo('completed', {
        ...requestLog,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
        warnings: res.getHeader('X-Bridge-Warnings') || undefined
      });
    });

    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, healthPayload());
      }
      if (req.method === 'POST' && requestUrl.pathname === '/bridge') {
        const rawBody = await readBody(req, MAX_XML_BYTES);
        const result = await fetchAndConvertTarget(requestUrl.searchParams.get('target'), {
          body: parseRequestBody(rawBody, req.headers['content-type']),
          query: Object.fromEntries(requestUrl.searchParams)
        }, bridgeOptions(req));

        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        return sendJson(res, 200, result.jambonz, result.warnings.length ? { 'X-Bridge-Warnings': String(result.warnings.length) } : {});
      }

      if (req.method !== 'POST' || !['/convert', '/twiml', '/laml', '/cxml'].includes(requestUrl.pathname)) {
        return sendJson(res, 404, { error: 'not_found' });
      }

      const xml = await readBody(req, MAX_XML_BYTES);
      const result = convertVoiceXml(xml, {
        maxXmlBytes: MAX_XML_BYTES,
        defaults: {
          language: process.env.DEFAULT_TTS_LANGUAGE,
          synthesizerVendor: process.env.DEFAULT_SYNTH_VENDOR,
          recognizerVendor: process.env.DEFAULT_STT_VENDOR,
          recordingWsUrl: process.env.RECORDING_WS_URL
        }
      });

      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      return sendJson(res, 200, result.jambonz, result.warnings.length ? { 'X-Bridge-Warnings': String(result.warnings.length) } : {});
    } catch (err) {
      const status = errorStatus(err);
      return sendJson(res, status, {
        error: err.code || err.name || 'ConversionError',
        message: err.message,
        details: err.details
      });
    }
  });
}

function healthPayload() {
  return {
    ok: true,
    status: 'ok',
    service: packageInfo.name,
    version: packageInfo.version,
    uptimeSeconds: Math.floor(process.uptime()),
    node: process.version
  };
}

function errorStatus(err) {
  if (err.code === 'PAYLOAD_TOO_LARGE') return 413;
  if (err.code === 'UPSTREAM_FETCH_FAILED') return 502;
  return 400;
}

function bridgeOptions(req) {
  return {
    maxXmlBytes: MAX_XML_BYTES,
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || inferPublicBaseUrl(req),
    allowedTwimlHosts: process.env.ALLOWED_TWIML_HOSTS,
    allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === 'true',
    defaults: {
      language: process.env.DEFAULT_TTS_LANGUAGE,
      synthesizerVendor: process.env.DEFAULT_SYNTH_VENDOR,
      recognizerVendor: process.env.DEFAULT_STT_VENDOR,
      recordingWsUrl: process.env.RECORDING_WS_URL
    }
  };
}

function inferPublicBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${String(proto).split(',')[0]}://${String(host).split(',')[0]}`;
}

function parseRequestBody(rawBody, contentType = '') {
  if (!rawBody) return {};
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(rawBody);
    } catch {
      return {};
    }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(rawBody));
  }
  return { rawBody };
}

function requestSummary(req, requestUrl) {
  const summary = {
    method: req.method,
    path: requestUrl.pathname,
    remote: remoteAddress(req)
  };

  if (requestUrl.pathname === '/bridge') {
    const target = safeDecodeTarget(requestUrl.searchParams.get('target'));
    if (target) {
      const targetUrl = new URL(target.url);
      summary.target_host = targetUrl.hostname;
      summary.target_path = targetUrl.pathname;
      summary.target_method = target.method;
    } else {
      summary.target = 'invalid_or_missing';
    }
  }

  return summary;
}

function safeDecodeTarget(encoded) {
  if (!encoded) return undefined;
  try {
    return decodeTarget(encoded);
  } catch {
    return undefined;
  }
}

function remoteAddress(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress;
}

function logInfo(event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...fields
  };
  console.log(JSON.stringify(payload));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error(`Request body exceeds ${limit} bytes`);
        err.code = 'PAYLOAD_TOO_LARGE';
        req.destroy(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log(`jambonz TwiML bridge listening on :${PORT}`);
  });
}

module.exports = {
  createServer,
  healthPayload
};
