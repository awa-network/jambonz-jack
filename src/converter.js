'use strict';

const { elementChildren, parseXml, textContent } = require('./xml');
const { DEFAULT_MAX_XML_BYTES } = require('./limits');

const DEFAULT_OPTIONS = {
  maxXmlBytes: DEFAULT_MAX_XML_BYTES,
  includeWarnings: true,
  defaults: {},
  hooks: {}
};

function convertVoiceXml(xml, options = {}) {
  const config = {
    ...DEFAULT_OPTIONS,
    ...options,
    defaults: { ...DEFAULT_OPTIONS.defaults, ...options.defaults },
    hooks: { ...DEFAULT_OPTIONS.hooks, ...options.hooks }
  };
  const root = parseXml(xml, { maxXmlBytes: config.maxXmlBytes });
  const context = { warnings: [], config };
  const verbs = convertChildren(root, context);
  return {
    jambonz: verbs,
    warnings: config.includeWarnings ? context.warnings : []
  };
}

function convertChildren(node, context) {
  const verbs = [];
  for (const child of elementChildren(node)) {
    const converted = convertNode(child, context);
    for (const verb of converted) verbs.push(verb);
  }
  return verbs;
}

function convertNode(node, context) {
  const attrs = node.attributes || {};
  switch (node.name) {
    case 'Say':
      return [
        compact({
          verb: 'say',
          text: textContent(node),
          loop: integer(attrs.loop)
        })
      ];
    case 'Play':
      return [
        compact({
          verb: 'play',
          url: textContent(node),
          loop: integer(attrs.loop),
          timeoutSecs: integer(attrs.timeout)
        })
      ];
    case 'Pause':
      return [compact({ verb: 'pause', length: integer(attrs.length) })];
    case 'Hangup':
      return [{ verb: 'hangup' }];
    case 'Reject':
      return [
        compact({
          verb: 'sip:decline',
          status: attrs.reason === 'busy' ? 486 : 603,
          reason: attrs.reason
        })
      ];
    case 'Redirect':
      return [
        compact({
          verb: 'redirect',
          actionHook: callbackUrl(context, textContent(node), attrs.method || 'POST'),
          method: attrs.method
        })
      ];
    case 'Gather':
      return [convertGather(node, context)];
    case 'Dial':
      return [convertDial(node, context)];
    case 'Record':
      return [convertRecord(node, context)];
    case 'Enqueue':
      return [
        compact({
          verb: 'enqueue',
          name: textContent(node),
          actionHook: callbackUrl(context, attrs.action, attrs.method || 'POST'),
          waitHook: callbackUrl(context, attrs.waitUrl, attrs.waitUrlMethod || 'POST')
        })
      ];
    case 'Leave':
      return [{ verb: 'leave' }];
    case 'Connect':
      return convertConnect(node, context);
    default:
      warn(context, node.name, `No direct jambonz mapping implemented for <${node.name}>`);
      return [];
  }
}

function convertGather(node, context) {
  const attrs = node.attributes || {};
  const nested = convertChildren(node, context).filter((verb) =>
    ['say', 'play', 'pause'].includes(verb.verb)
  );
  const gather = compact({
    verb: 'gather',
    actionHook: callbackUrl(context, attrs.action, attrs.method || 'POST'),
    input: gatherInput(attrs.input) || ['digits'],
    timeout: integer(attrs.timeout),
    finishOnKey: attrs.finishOnKey,
    numDigits: integer(attrs.numDigits),
    minDigits: integer(attrs.minDigits),
    maxDigits: integer(attrs.maxDigits),
    bargein: boolean(attrs.bargeIn),
    dtmfBargein: boolean(attrs.bargeIn),
    recognizer: recognizer(attrs, context)
  });

  for (const prompt of nested) {
    if (prompt.verb === 'say' && !gather.say) gather.say = withoutVerb(prompt);
    else if (prompt.verb === 'play' && !gather.play) gather.play = withoutVerb(prompt);
    else
      warn(
        context,
        'Gather',
        `Nested <${prompt.verb}> after first prompt cannot be represented exactly`
      );
  }

  return gather;
}

function convertDial(node, context) {
  const attrs = node.attributes || {};
  const targets = [];
  const directText = directTextContent(node);
  if (directText) targets.push({ type: 'phone', number: directText });

  for (const child of elementChildren(node)) {
    const value = textContent(child);
    if (child.name === 'Number')
      targets.push(compact({ type: 'phone', number: value, callerId: child.attributes.callerId }));
    else if (child.name === 'Sip') targets.push(compact({ type: 'sip', sipUri: value }));
    else if (child.name === 'Client') targets.push(compact({ type: 'user', name: value }));
    else if (child.name === 'Conference') {
      warn(
        context,
        'Conference',
        '<Dial><Conference> maps to jambonz conference, not dial target semantics'
      );
      return compact({
        verb: 'conference',
        name: value,
        beep: boolean(child.attributes.beep),
        startConferenceOnEnter: boolean(child.attributes.startConferenceOnEnter),
        endConferenceOnExit: boolean(child.attributes.endConferenceOnExit)
      });
    } else {
      warn(context, child.name, `Nested <Dial><${child.name}> is not mapped`);
    }
  }

  return compact({
    verb: 'dial',
    actionHook: callbackUrl(context, attrs.action, attrs.method || 'POST'),
    callerId: attrs.callerId,
    answerOnBridge: boolean(attrs.answerOnBridge),
    timeout: integer(attrs.timeout),
    timeLimit: integer(attrs.timeLimit),
    target: targets
  });
}

function convertRecord(node, context) {
  const attrs = node.attributes || {};
  warn(
    context,
    'Record',
    '<Record> is approximated with jambonz listen; provide a recorder websocket URL via defaults.recordingWsUrl'
  );
  return compact({
    verb: 'listen',
    url: attrs.recordingStatusCallback || context.config.defaults.recordingWsUrl,
    actionHook: callbackUrl(context, attrs.action, attrs.method || 'POST'),
    finishOnKey: attrs.finishOnKey,
    maxLength: integer(attrs.maxLength),
    playBeep: boolean(attrs.playBeep)
  });
}

function convertConnect(node, context) {
  const out = [];
  for (const child of elementChildren(node)) {
    if (child.name === 'Stream') {
      out.push(
        compact({
          verb: 'listen',
          url: child.attributes.url,
          mixType: 'mono',
          bidirectionalAudio: { enabled: true }
        })
      );
    } else {
      warn(context, child.name, `<Connect><${child.name}> is not mapped`);
    }
  }
  if (!out.length)
    warn(context, 'Connect', '<Connect> requires a supported nested noun such as <Stream>');
  return out;
}

function gatherInput(input) {
  if (!input) return undefined;
  const parts = input.split(/\s+/).filter(Boolean);
  return parts.map((part) => (part === 'dtmf' ? 'digits' : part));
}

function recognizer(attrs, context) {
  const input = gatherInput(attrs.input) || [];
  if (!input.includes('speech')) return undefined;
  return compact({
    vendor: context.config.defaults.recognizerVendor,
    language: attrs.language || context.config.defaults.language,
    hints: attrs.hints
      ? attrs.hints
          .split(',')
          .map((hint) => hint.trim())
          .filter(Boolean)
      : undefined,
    speechTimeout: attrs.speechTimeout
  });
}

function callbackUrl(context, value, method) {
  if (!value) return undefined;
  if (typeof context.config.hooks.rewriteCallbackUrl !== 'function') return value;
  return context.config.hooks.rewriteCallbackUrl(value, { method });
}

function directTextContent(node) {
  return node.children
    .filter((child) => child.name === '#text')
    .map((child) => child.text)
    .join('')
    .trim();
}

function withoutVerb(obj) {
  const copy = { ...obj };
  delete copy.verb;
  return copy;
}

function compact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = compact(value);
      if (Object.keys(nested).length === 0) continue;
      out[key] = nested;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function integer(value) {
  if (value === undefined || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolean(value) {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes'].includes(String(value).toLowerCase());
}

function warn(context, verb, message) {
  context.warnings.push({ verb, message });
}

module.exports = {
  convertVoiceXml
};
