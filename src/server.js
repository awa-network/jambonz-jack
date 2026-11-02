'use strict';

const http = require('node:http');
const packageInfo = require('../package.json');
const { decodeTarget, fetchAndConvertTarget } = require('./bridge');
const { convertVoiceXml } = require('./converter');
const { InputError } = require('./errors');
const { XmlParseError } = require('./xml');
const { readListenOptions, readServerConfig } = require('./config');

const CONVERSION_PATHS = ['/convert', '/twiml', '/laml', '/cxml'];
const POST_PATHS = [...CONVERSION_PATHS, '/bridge'];
const KNOWN_PATHS = [...POST_PATHS, '/health', '/healthz'];
const CONNECTION_CHECK_INTERVAL_MS = 1000;

function createServer({ env = process.env, log = logInfo } = {}) {
  const config = readServerConfig(env);
  const { requestTimeoutMs, maxConcurrentRequests, maxXmlBytes } = config;
  let activeRequests = 0;
  const server = http.createServer(
    {
      requestTimeout: requestTimeoutMs,
      headersTimeout: requestTimeoutMs,
      connectionsCheckingInterval: CONNECTION_CHECK_INTERVAL_MS
    },
    async (req, res) => {
      const startedAt = Date.now();
      let counted = false;
      const controller = new AbortController();
      const abortOnDisconnect = () => {
        if (!res.writableFinished) controller.abort();
      };
      res.once('close', abortOnDisconnect);
      try {
        let requestUrl;
        try {
          if (!req.url.startsWith('/') || req.url.startsWith('//')) throw new Error();
          requestUrl = new URL(req.url, 'http://localhost');
        } catch {
          throw new InputError('Invalid request URL');
        }
        const requestLog = requestSummary(req, requestUrl, config.targetSigningSecret);
        log('incoming', requestLog);
        res.on('finish', () =>
          log('completed', {
            ...requestLog,
            status: res.statusCode,
            duration_ms: Date.now() - startedAt,
            warnings: res.getHeader('X-Bridge-Warnings') || undefined
          })
        );

        if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'GET' && requestUrl.pathname === '/health') {
          return sendJson(res, 200, healthPayload());
        }
        if (req.method !== 'POST' || !POST_PATHS.includes(requestUrl.pathname)) {
          return sendJson(res, 404, { error: 'not_found' });
        }
        if (activeRequests >= maxConcurrentRequests) {
          return sendJson(
            res,
            503,
            { error: 'SERVER_BUSY' },
            { Connection: 'close', 'Retry-After': '1' }
          );
        }
        activeRequests++;
        counted = true;

        if (requestUrl.pathname === '/bridge') {
          const rawBody = await readBody(req, maxXmlBytes, requestTimeoutMs);
          const result = await fetchAndConvertTarget(
            requestUrl.searchParams.get('target'),
            {
              body: parseRequestBody(rawBody, req.headers['content-type']),
              query: Object.fromEntries(requestUrl.searchParams)
            },
            { ...bridgeOptions(req, config), signal: controller.signal }
          );

          return sendConversion(res, result);
        }

        const xml = await readBody(req, maxXmlBytes, requestTimeoutMs);
        const result = convertVoiceXml(xml, {
          maxXmlBytes,
          defaults: config.defaults
        });

        return sendConversion(res, result);
      } catch (err) {
        const status = errorStatus(err);
        if (status === 500) log('internal_error', { code: 'INTERNAL_ERROR' });
        if (res.destroyed) return;
        return sendJson(
          res,
          status,
          {
            error: status === 500 ? 'INTERNAL_ERROR' : err.code || err.name,
            message: status === 500 ? 'Internal server error' : err.message,
            details: status === 502 ? err.details : undefined
          },
          { Connection: 'close' }
        );
      } finally {
        res.removeListener('close', abortOnDisconnect);
        if (counted) activeRequests--;
      }
    }
  );
  server.maxConnections = maxConcurrentRequests * 2;
  return server;
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
  if (err.code === 'REQUEST_TIMEOUT') return 408;
  if (err.code === 'UPSTREAM_FETCH_FAILED') return 502;
  if (err.code === 'INVALID_TARGET_SIGNATURE') return 403;
  if (err.code === 'BRIDGE_NOT_CONFIGURED') return 503;
  if (err instanceof InputError || err instanceof XmlParseError) return 400;
  return 500;
}

function bridgeOptions(req, config) {
  if (config.production && (!config.publicBaseUrl || !config.allowedTwimlHosts.length)) {
    throw new InputError(
      'Production bridge requires PUBLIC_BASE_URL and ALLOWED_TWIML_HOSTS',
      'BRIDGE_NOT_CONFIGURED'
    );
  }
  return {
    maxXmlBytes: config.maxXmlBytes,
    fetchTimeoutMs: config.fetchTimeoutMs,
    publicBaseUrl: config.publicBaseUrl || inferPublicBaseUrl(req),
    allowedTwimlHosts: config.allowedTwimlHosts,
    allowPrivateTargets: config.allowPrivateTargets,
    targetSigningSecret: config.targetSigningSecret,
    defaults: config.defaults
  };
}

function inferPublicBaseUrl(req) {
  const proto = req.socket.encrypted ? 'https' : 'http';
  const host = req.headers.host || `localhost:${req.socket.localPort}`;
  try {
    const url = new URL(`${proto}://${host}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error();
    return url.origin;
  } catch {
    throw new InputError('Invalid Host header');
  }
}

function parseRequestBody(rawBody, contentType = '') {
  if (!rawBody) return {};
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'application/json') {
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new InputError('Invalid JSON request body');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InputError('JSON request body must be an object');
    }
    return parsed;
  }
  if (mediaType === 'application/x-www-form-urlencoded') {
    return Object.fromEntries(new URLSearchParams(rawBody));
  }
  return { rawBody };
}

function requestSummary(req, requestUrl, targetSigningSecret) {
  const summary = {
    method: req.method,
    path: KNOWN_PATHS.includes(requestUrl.pathname) ? requestUrl.pathname : '(unmatched)',
    remote: req.socket.remoteAddress
  };

  if (requestUrl.pathname === '/bridge') {
    const target = safeDecodeTarget(requestUrl.searchParams.get('target'), targetSigningSecret);
    if (target) {
      const targetUrl = new URL(target.url);
      summary.target_host = targetUrl.hostname;
      summary.target_method = target.method;
    } else {
      summary.target = 'invalid_or_missing';
    }
  }

  return summary;
}

function safeDecodeTarget(encoded, targetSigningSecret) {
  if (!encoded) return undefined;
  try {
    return decodeTarget(encoded, { targetSigningSecret });
  } catch {
    return undefined;
  }
}

function logInfo(event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...fields
  };
  console.log(JSON.stringify(payload));
}

function readBody(req, limit, timeoutMs) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const timer = setTimeout(
      () => finish(new InputError('Request body timed out', 'REQUEST_TIMEOUT')),
      timeoutMs
    );
    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      if (err) {
        req.pause();
        reject(err);
      } else resolve(Buffer.concat(chunks).toString('utf8'));
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > limit) {
        return finish(new InputError(`Request body exceeds ${limit} bytes`, 'PAYLOAD_TOO_LARGE'));
      }
      chunks.push(chunk);
    }
    const onEnd = () => finish();
    const onError = (err) => finish(err);
    const onAborted = () => finish(new InputError('Request aborted'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.once('close', () => req.removeListener('error', onError));
  });
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendConversion(res, result) {
  const headers = result.warnings.length
    ? { 'X-Bridge-Warnings': String(result.warnings.length) }
    : {};
  return sendJson(res, 200, result.jambonz, headers);
}

if (require.main === module) {
  const server = createServer();
  server.listen(readListenOptions(), () => {
    console.log(`jambonz TwiML bridge listening on :${server.address().port}`);
  });
}

module.exports = {
  createServer,
  healthPayload
};
