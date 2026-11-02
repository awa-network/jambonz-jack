'use strict';

const { convertVoiceXml } = require('./converter');
const {
  decodeTarget,
  encodeTarget,
  fetchAndConvertTarget,
  makeBridgeTargetUrl
} = require('./bridge');
const { XmlParseError } = require('./xml');

module.exports = {
  XmlParseError,
  convertVoiceXml,
  decodeTarget,
  encodeTarget,
  fetchAndConvertTarget,
  makeBridgeTargetUrl
};
