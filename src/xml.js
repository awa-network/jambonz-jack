'use strict';

const { DEFAULT_MAX_XML_BYTES } = require('./limits');
const MAX_XML_DEPTH = 64;

class XmlParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmlParseError';
  }
}

function parseXml(xml, options = {}) {
  const maxBytes = options.maxXmlBytes || DEFAULT_MAX_XML_BYTES;
  if (typeof xml !== 'string') throw new XmlParseError('XML input must be a string');
  if (Buffer.byteLength(xml, 'utf8') > maxBytes) {
    throw new XmlParseError(`XML input exceeds ${maxBytes} bytes`);
  }
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new XmlParseError('DOCTYPE and ENTITY declarations are not allowed');
  }

  const source = xml.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (const char of source) {
    if (!isXmlCharacter(char.codePointAt(0))) throw new XmlParseError('Invalid XML character');
  }
  const root = { name: '#document', attributes: {}, children: [], text: '' };
  const stack = [root];
  const tokenRe =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(?:"[^"]*"|'[^']*'|[^'"<>])*>|[^<]+/gy;
  let match;
  let lastIndex = 0;

  while ((match = tokenRe.exec(source)) !== null) {
    // The sticky tokenizer cannot skip malformed input; check any tail after the loop.
    lastIndex = tokenRe.lastIndex;
    const token = match[0];
    const current = stack[stack.length - 1];

    if (token.startsWith('<!--')) {
      if (token.slice(4, -3).includes('--') || token.slice(4, -3).endsWith('-')) {
        throw new XmlParseError('Malformed XML comment');
      }
      continue;
    }
    if (token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) {
      current.children.push({
        name: '#text',
        text: token.slice(9, -3),
        attributes: {},
        children: []
      });
      continue;
    }
    if (!token.startsWith('<')) {
      if (token.includes(']]>')) throw new XmlParseError('Unexpected CDATA terminator');
      current.children.push({
        name: '#text',
        text: decodeEntities(token),
        attributes: {},
        children: []
      });
      continue;
    }
    if (token.startsWith('</')) {
      const closing = /^<\/([A-Za-z_][\w:.-]*)\s*>$/.exec(token);
      if (!closing || stack.length === 1) throw new XmlParseError('Malformed XML closing tag');
      const name = closing[1];
      const node = stack.pop();
      if (node.rawName !== name) {
        throw new XmlParseError(`Mismatched closing tag: ${name}`);
      }
      continue;
    }

    const selfClosing = token.endsWith('/>');
    const inner = token.slice(1, selfClosing ? -2 : -1).trim();
    const firstSpace = inner.search(/\s/);
    const rawName = firstSpace === -1 ? inner : inner.slice(0, firstSpace);
    if (!/^[A-Za-z_][\w:.-]*$/.test(rawName)) throw new XmlParseError('Malformed XML tag');
    const attrSource = firstSpace === -1 ? '' : inner.slice(firstSpace + 1);
    if (stack.length > MAX_XML_DEPTH) throw new XmlParseError('XML nesting limit exceeded');
    const node = {
      name: localName(rawName),
      rawName,
      attributes: parseAttributes(attrSource),
      children: [],
      text: ''
    };
    current.children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (lastIndex !== source.length && source.slice(lastIndex).trim()) {
    throw new XmlParseError('Malformed XML after final token');
  }
  if (stack.length !== 1) {
    throw new XmlParseError(`Unclosed tag: ${stack[stack.length - 1].name}`);
  }

  const elements = root.children.filter((child) => child.name !== '#text' || child.text.trim());
  if (elements.length !== 1 || elements[0].name !== 'Response') {
    throw new XmlParseError('Expected a single <Response> root element');
  }
  return elements[0];
}

function parseAttributes(input) {
  const attrs = Object.create(null);
  const attrRe = /\s*([A-Za-z_][\w:.-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/gy;
  let end = 0;
  let match;
  while ((match = attrRe.exec(input)) !== null) {
    if (end && !/^\s/.test(match[0])) throw new XmlParseError('XML attributes require whitespace');
    const name = localName(match[1]);
    if (Object.hasOwn(attrs, name)) throw new XmlParseError('Duplicate XML attribute');
    attrs[name] = decodeEntities((match[3] ?? match[4]).replace(/[\t\n\r]/g, ' '));
    end = attrRe.lastIndex;
  }
  const remainder = input.slice(end).trim();
  if (remainder) throw new XmlParseError('Malformed XML attributes');
  return attrs;
}

function localName(name) {
  return String(name).split(':').pop();
}

function decodeEntities(value) {
  return value.replace(/&(?:#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);|&/g, (reference) => {
    if (reference === '&') throw new XmlParseError('Invalid XML entity reference');
    const entity = reference.slice(1, -1);
    const predefined = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, entity)) return predefined[entity];
    const code = entity.startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    if (!isXmlCharacter(code)) throw new XmlParseError('Invalid XML character reference');
    return String.fromCodePoint(code);
  });
}

function isXmlCharacter(code) {
  return (
    code === 9 ||
    code === 10 ||
    code === 13 ||
    (code >= 32 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

function textContent(node) {
  return node.children
    .map((child) => (child.name === '#text' ? child.text : textContent(child)))
    .join('')
    .trim();
}

function elementChildren(node) {
  return node.children.filter((child) => child.name !== '#text');
}

module.exports = {
  DEFAULT_MAX_XML_BYTES,
  XmlParseError,
  elementChildren,
  parseXml,
  textContent
};
