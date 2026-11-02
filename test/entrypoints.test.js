'use strict';

const assert = require('node:assert/strict');
const { fork, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { resolve } = require('node:path');
const { test } = require('node:test');

const projectRoot = resolve(__dirname, '..');
const cliPath = resolve(projectRoot, 'src/cli.js');

test('CLI converts stdin and example files and fails on invalid input', () => {
  const stdin = spawnSync(process.execPath, [cliPath], {
    input: '<Response><Hangup/></Response>',
    encoding: 'utf8',
    env: {}
  });
  assert.equal(stdin.status, 0, stdin.stderr);
  assert.deepEqual(JSON.parse(stdin.stdout), { jambonz: [{ verb: 'hangup' }], warnings: [] });
  const file = spawnSync(process.execPath, [cliPath, resolve(projectRoot, 'examples/dial.xml')], {
    encoding: 'utf8',
    env: {}
  });
  assert.equal(file.status, 0, file.stderr);
  assert.equal(JSON.parse(file.stdout).jambonz[0].verb, 'dial');
  const invalid = spawnSync(process.execPath, [cliPath], {
    input: '<Response>',
    encoding: 'utf8',
    env: {}
  });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /XmlParseError/);
});

test(
  'server entrypoint binds HOST and supports an ephemeral PORT',
  { timeout: 10000 },
  async (t) => {
    // Report the real socket address through IPC while running the production entrypoint.
    const preload = `import http from 'node:http';
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
      this.once('listening', () => process.send(this.address()));
      return listen.apply(this, args);
    };`;
    const child = fork(resolve(projectRoot, 'src/server.js'), [], {
      env: { HOST: '127.0.0.1', PORT: '0' },
      execArgv: ['--import', `data:text/javascript,${encodeURIComponent(preload)}`],
      silent: true
    });
    const exited = once(child, 'exit');
    t.after(async () => {
      child.kill();
      await exited;
    });
    const [address] = await Promise.race([
      once(child, 'message'),
      exited.then(([code]) => {
        throw new Error(`Server exited before listening: ${code}`);
      })
    ]);
    assert.equal(address.address, '127.0.0.1');
    assert.ok(address.port > 0);
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.deepEqual(await response.json(), { ok: true });
  }
);
