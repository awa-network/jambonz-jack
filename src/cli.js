#!/usr/bin/env node
'use strict';

const { readFileSync } = require('node:fs');
const { convertVoiceXml } = require('./converter');
const { readConversionDefaults } = require('./config');

const file = process.argv[2];
const xml = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
const result = convertVoiceXml(xml, {
  defaults: readConversionDefaults()
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
