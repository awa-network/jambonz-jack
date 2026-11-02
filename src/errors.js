'use strict';

class InputError extends Error {
  constructor(message, code = 'INVALID_INPUT') {
    super(message);
    this.name = 'InputError';
    this.code = code;
  }
}

module.exports = { InputError };
