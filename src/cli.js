#!/usr/bin/env node
'use strict';

const { readFileSync } = require('node:fs');
const { convertVoiceXml } = require('./converter');

const file = process.argv[2];
const xml = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
const result = convertVoiceXml(xml, {
  defaults: {
    language: process.env.DEFAULT_TTS_LANGUAGE,
    synthesizerVendor: process.env.DEFAULT_SYNTH_VENDOR,
    recognizerVendor: process.env.DEFAULT_STT_VENDOR,
    recordingWsUrl: process.env.RECORDING_WS_URL
  }
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
