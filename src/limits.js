'use strict';

const DEFAULT_MAX_XML_BYTES = 256 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 64;
const MAX_TIMER_DELAY_MS = 2147483647;

function positiveInteger(value, fallback, name = 'Limits') {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} must be positive integers at most ${MAX_TIMER_DELAY_MS}`);
  }
  return number;
}

module.exports = {
  DEFAULT_MAX_XML_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  positiveInteger
};
