#!/usr/bin/env node
//
// Unit test of the login and registration limiter in lib/limiter.js.
//
// Run with: npm test

'use strict';

const assert = require('assert');
const { makeLimiter } = require('../lib/limiter');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}\n`);
  }
}

const WINDOW = 60 * 1000;
const times = (n, fn) => { for (let i = 0; i < n; i += 1) fn(); };

test('an address is blocked at its own limit, others are not', () => {
  const limiter = makeLimiter(3, 100, WINDOW);
  times(3, () => limiter.record('a'));
  assert.ok(limiter.retryAfter('a') > 0);
  assert.strictEqual(limiter.retryAfter('b'), 0);
});
test('the global limit blocks every address', () => {
  const limiter = makeLimiter(10, 4, WINDOW);
  times(2, () => limiter.record('a'));
  times(2, () => limiter.record('b'));
  assert.ok(limiter.retryAfter('c') > 0);
});
test('a reset clears the address window', () => {
  const limiter = makeLimiter(3, 100, WINDOW);
  times(3, () => limiter.record('a'));
  limiter.reset('a');
  assert.strictEqual(limiter.retryAfter('a'), 0);
});
test('a reset keeps the global count', () => {
  const limiter = makeLimiter(10, 3, WINDOW);
  times(2, () => limiter.record('a'));
  limiter.reset('a');
  limiter.record('a');
  assert.ok(limiter.retryAfter('b') > 0, 'a sign-in handed out a fresh global budget');
});
test('the wait never exceeds the window', () => {
  const limiter = makeLimiter(1, 100, WINDOW);
  limiter.record('a');
  const wait = limiter.retryAfter('a');
  assert.ok(wait > 0 && wait <= WINDOW / 1000, String(wait));
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
