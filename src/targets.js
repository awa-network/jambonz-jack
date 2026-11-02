'use strict';

const dns = require('node:dns');
const { BlockList, isIP } = require('node:net');
const { InputError } = require('./errors');

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
])
  blocked.addSubnet(address, prefix, 'ipv4');

const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20]
])
  blocked.addSubnet(address, prefix, 'ipv6');

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // Restrict IPv6 to global unicast; exclude mapped, translation and tunnel ranges.
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

function parseList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return items.map((item) => String(item).trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
}

function assertAllowedTarget(targetUrl, options = {}) {
  const url = new URL(targetUrl);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new InputError('TwiML target must use http or https');
  if (url.username || url.password)
    throw new InputError('Credentials in TwiML target URLs are not allowed');

  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  const allowedHosts = parseList(options.allowedTwimlHosts);
  if (allowedHosts.length && !allowedHosts.includes(host)) {
    throw new InputError('TwiML target host is not allowed');
  }
  if (
    !options.allowPrivateTargets &&
    (host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === 'metadata.google.internal' ||
      (isIP(host) && !isPublicAddress(host)))
  )
    throw new InputError('Private TwiML target host is not allowed');
}

function safeLookup(hostname, options, callback) {
  // Return the checked records to the socket itself, avoiding a second DNS lookup.
  dns.lookup(hostname, { all: true, verbatim: true }, (err, records) => {
    if (err) return callback(err);
    if (!records.length || records.some(({ address }) => !isPublicAddress(address))) {
      return callback(new InputError('Private TwiML target host is not allowed'));
    }
    const candidates = options.family
      ? records.filter(({ family }) => family === options.family)
      : records;
    if (!candidates.length) return callback(new InputError('TwiML target has no usable address'));
    if (options.all) return callback(null, candidates);
    return callback(null, candidates[0].address, candidates[0].family);
  });
}

module.exports = { assertAllowedTarget, isPublicAddress, parseList, safeLookup };
