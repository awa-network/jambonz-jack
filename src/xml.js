'use strict';

const DEFAULT_MAX_XML_BYTES = 256 * 1024;

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

  const source = xml.replace(/^\uFEFF/, '');
  const root = { name: '#document', attributes: {}, children: [], text: '' };
  const stack = [root];
  const tokenRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][\w:.-]*(?:\s+[^<>]*?)?\/?>|[^<]+/g;
  let match;
  let lastIndex = 0;

  while ((match = tokenRe.exec(source)) !== null) {
    if (match.index !== lastIndex && source.slice(lastIndex, match.index).trim()) {
      throw new XmlParseError('Malformed XML near unexpected text');
    }
    lastIndex = tokenRe.lastIndex;
    const token = match[0];
    const current = stack[stack.length - 1];

    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) {
      current.children.push({ name: '#text', text: token.slice(9, -3), attributes: {}, children: [] });
      continue;
    }
    if (!token.startsWith('<')) {
      current.children.push({ name: '#text', text: decodeEntities(token), attributes: {}, children: [] });
      continue;
    }
    if (token.startsWith('</')) {
      const name = localName(token.slice(2, -1).trim());
      const node = stack.pop();
      if (!node || node.name !== name) {
        throw new XmlParseError(`Mismatched closing tag: ${name}`);
      }
      continue;
    }

    const selfClosing = token.endsWith('/>');
    const inner = token.slice(1, selfClosing ? -2 : -1).trim();
    const firstSpace = inner.search(/\s/);
    const rawName = firstSpace === -1 ? inner : inner.slice(0, firstSpace);
    const attrSource = firstSpace === -1 ? '' : inner.slice(firstSpace + 1);
    const node = {
      name: localName(rawName),
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
  const attrs = {};
  const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let consumed = '';
  let match;
  while ((match = attrRe.exec(input)) !== null) {
    consumed += match[0];
    attrs[localName(match[1])] = decodeEntities(match[3] ?? match[4] ?? '');
  }
  const remainder = input.replace(attrRe, '').trim();
  if (remainder) throw new XmlParseError(`Malformed XML attributes: ${remainder}`);
  return attrs;
}

function localName(name) {
  return String(name).split(':').pop();
}

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return _;
  });
}

function textContent(node) {
  return node.children.map((child) => (child.name === '#text' ? child.text : textContent(child))).join('').trim();
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
