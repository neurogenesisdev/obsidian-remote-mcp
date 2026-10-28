#!/usr/bin/env node
//
// End-to-end test of the limiters as auth-server.js wires them: starts the
// server on a free loopback port with small limits and drives /register and
// /authorize over HTTP.
//
// Run with: npm test

'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'auth-server.js');
const PASSWORD = 'correct horse';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}\n`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

async function waitFor(url) {
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('auth server did not start');
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-server-test-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir, 'password-hash'), `${salt}:${crypto.scryptSync(PASSWORD, salt, 64).toString('hex')}\n`);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      ISSUER: 'https://auth.test.invalid',
      CONFIG_DIR: dir,
      MAX_REGISTRATIONS_PER_ADDRESS: '3',
      MAX_LOGIN_ATTEMPTS_GLOBAL: '3',
    },
    stdio: 'ignore',
  });

  try {
    await waitFor(`${base}/.well-known/oauth-authorization-server`);
    const register = () =>
      fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'test', token_endpoint_auth_method: 'none' }),
      });

    let clientId;
    await test('registration is limited per address', async () => {
      const statuses = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await register();
        statuses.push(res.status);
        if (res.ok && !clientId) clientId = (await res.json()).client_id;
      }
      assert.deepStrictEqual(statuses, [201, 201, 201, 429]);
    });

    const login = (password) =>
      fetch(`${base}/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: 'x'.repeat(43),
          code_challenge_method: 'S256',
          password,
        }),
      }).then((res) => res.status);

    await test('a successful sign-in keeps the global login count', async () => {
      assert.ok(clientId, 'no client registered');
      assert.strictEqual(await login('wrong'), 401);
      assert.strictEqual(await login('wrong'), 401);
      assert.strictEqual(await login(PASSWORD), 302);
      assert.strictEqual(await login('wrong'), 429, 'the sign-in handed out a fresh global budget');
    });
  } finally {
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
