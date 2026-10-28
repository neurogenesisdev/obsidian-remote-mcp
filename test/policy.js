#!/usr/bin/env node
//
// End-to-end test of the VAULT_POLICY rules: starts vault-mcp.js over stdio
// with a policy file against two throwaway vaults and checks that denied paths
// stay invisible, read-only paths stay unchanged and disabled tools are gone.
//
// Run with: npm test

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const SERVER = path.join(__dirname, '..', 'vault-mcp.js');
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

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

function textOf(result) {
  return (result.content || []).map((c) => c.text || '').join('\n');
}

function expectError(result, fragment) {
  assert.ok(result.isError, `expected an error, got: ${textOf(result).slice(0, 120)}`);
  if (fragment) assert.ok(textOf(result).includes(fragment), `message lacks "${fragment}": ${textOf(result)}`);
}

function expectOk(result) {
  assert.ok(!result.isError, `unexpected error: ${textOf(result)}`);
  return textOf(result);
}

function startFails(policyFile, vault) {
  const run = spawnSync(process.execPath, [SERVER, vault], {
    env: { ...process.env, VAULT_POLICY: policyFile },
    input: '',
    timeout: 10000,
  });
  return { code: run.status, stderr: String(run.stderr) };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mcp-policy-'));
  const notes = path.join(root, 'notes');
  const code = path.join(root, 'code');

  writeTree(notes, {
    '.obsidian/app.json': '{}',
    'CLAUDE.md': '# rules\n',
    'areas/x/_index.md': '# x\n\n[[notes/Target]] #topic\n',
    'areas/box/state/facts.md': 'measured\n',
    'notes/Target.md': '# Target\n\nkeyword-target\n',
    'notes/Other.md': '# Other\n\n[target](Target.md) #topic\n',
    '_generated/out.md': 'keyword-generated\n',
    '_meta/scratch/s.md': 'keyword-scratch\n',
    '.claude/settings.json': '{}',
    '.env': 'SECRET=1\n',
  });
  fs.symlinkSync('../_generated/out.md', path.join(notes, 'notes/link.md'));
  fs.writeFileSync(path.join(root, 'outside.md'), 'keyword-outside\n');
  fs.symlinkSync('../../outside.md', path.join(notes, 'notes/outside.md'));
  fs.symlinkSync('../areas/box/state/planted.md', path.join(notes, 'notes/dangling.md'));
  fs.symlinkSync('../_generated', path.join(notes, 'notes/gen'));
  fs.symlinkSync('Target.md', path.join(notes, 'notes/alias.md'));
  writeTree(code, {
    'src/a.md': '# a\n',
    'node_modules/pkg/readme.md': 'dependency\n',
    'dist/build.md': 'built\n',
  });

  const policyFile = path.join(root, 'policy.json');
  fs.writeFileSync(
    policyFile,
    JSON.stringify({
      disabledTools: ['move-directory', 'delete-directory'],
      vaults: {
        '*': { deny: ['.git', '.env*'] },
        notes: {
          deny: ['.obsidian', '.claude', '_generated', '_meta/scratch'],
          readOnly: ['CLAUDE.md', '_index.md', 'areas/*/state'],
        },
        code: { deny: ['node_modules', 'dist'], readOnly: ['**'] },
      },
    })
  );

  const client = new Client({ name: 'vault-mcp-policy-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER, notes, code],
      env: { ...process.env, VAULT_POLICY: policyFile },
      stderr: 'pipe',
    })
  );
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const read = (rel) => fs.readFileSync(path.join(notes, rel), 'utf8');
  const index = read('areas/x/_index.md');

  await test('disabled tools are not listed', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes('move-directory') && !names.includes('delete-directory'), names.join(','));
    assert.ok(names.includes('move-note'), 'move-note missing');
  });
  await test('a disabled tool cannot be called', async () => {
    await assert.rejects(() => call('delete-directory', { vault: 'notes', path: 'notes' }), /Unknown tool/);
  });
  await test('a denied file cannot be read', async () => {
    expectError(await call('read-note', { vault: 'notes', path: '_generated/out.md' }), 'not available');
  });
  await test('a denied file cannot be read through ..', async () => {
    expectError(await call('read-note', { vault: 'notes', path: 'notes/../_meta/scratch/s.md' }), 'not available');
  });
  await test('a denied file cannot be read through a symlink', async () => {
    expectError(await call('read-note', { vault: 'notes', path: 'notes/link.md' }), 'not available');
  });
  await test('a dot-path on the deny list cannot be read', async () => {
    expectError(await call('read-attachment', { vault: 'notes', path: '.claude/settings.json' }), 'not available');
    expectError(await call('read-attachment', { vault: 'notes', path: '.env' }), 'not available');
  });
  await test('denied folders are not listed', async () => {
    const top = expectOk(await call('list-directory', { vault: 'notes' }));
    assert.ok(!top.includes('_generated'), top);
    const all = expectOk(await call('list-directory', { vault: 'notes', recursive: true }));
    assert.ok(!all.includes('_generated') && !all.includes('_meta/scratch'), all);
  });
  await test('denied files are not searched, not even through a link', async () => {
    const hits = expectOk(await call('search-vault', { vault: 'notes', query: 'keyword-generated' }));
    assert.ok(!hits.includes('keyword-generated'), hits);
    const found = expectOk(await call('search-vault', { vault: 'notes', query: 'keyword-target' }));
    assert.ok(found.includes('Target'), found);
  });
  await test('a link out of the vault is neither indexed nor read', async () => {
    const hits = expectOk(await call('search-vault', { vault: 'notes', query: 'keyword-outside' }));
    assert.ok(!hits.includes('keyword-outside'), hits);
    expectError(await call('read-note', { vault: 'notes', path: 'notes/outside.md' }), 'escapes');
  });
  await test('links to denied or outside targets are not listed', async () => {
    const list = expectOk(await call('list-directory', { vault: 'notes', path: 'notes' }));
    for (const name of ['gen', 'outside.md', 'link.md', 'dangling.md']) {
      assert.ok(!list.includes(name), `${name} listed: ${list}`);
    }
    assert.ok(list.includes('alias.md'), list);
  });
  await test('a link to an allowed note still reads', async () => {
    assert.ok(expectOk(await call('read-note', { vault: 'notes', path: 'notes/alias.md' })).includes('# Target'));
  });
  await test('nothing is written through a link, broken or not', async () => {
    expectError(await call('copy-note', { vault: 'notes', source: 'notes/Other.md', destination: 'notes/dangling.md' }), 'link');
    expectError(await call('create-note', { vault: 'notes', path: 'notes/dangling.md', content: 'x', overwrite: true }), 'link');
    expectError(await call('create-note', { vault: 'notes', path: 'notes/alias.md', content: 'x', overwrite: true }), 'link');
    assert.ok(!fs.existsSync(path.join(notes, 'areas/box/state/planted.md')));
    assert.ok(read('notes/Target.md').includes('# Target'));
  });
  await test('nothing can be created in a denied folder', async () => {
    expectError(await call('create-note', { vault: 'notes', path: '_generated/new.md', content: 'x' }), 'not available');
    assert.ok(!fs.existsSync(path.join(notes, '_generated/new.md')));
  });
  await test('a read-only file can be read', async () => {
    assert.ok(expectOk(await call('read-note', { vault: 'notes', path: 'CLAUDE.md' })).includes('# rules'));
  });
  await test('read-only files cannot be written, at any depth', async () => {
    expectError(await call('edit-note', { vault: 'notes', path: 'CLAUDE.md', operation: 'append', content: 'x' }), 'read-only');
    expectError(await call('create-note', { vault: 'notes', path: 'areas/x/_index.md', content: 'x', overwrite: true }), 'read-only');
    expectError(await call('create-note', { vault: 'notes', path: 'areas/box/state/new.md', content: 'x' }), 'read-only');
    expectError(await call('delete-note', { vault: 'notes', path: 'CLAUDE.md' }), 'read-only');
    expectError(await call('move-note', { vault: 'notes', source: 'CLAUDE.md', destination: 'rules.md' }), 'read-only');
    expectError(await call('move-note', { vault: 'notes', source: 'notes/Other.md', destination: 'areas/y/_index.md' }), 'read-only');
    assert.strictEqual(read('CLAUDE.md'), '# rules\n');
  });
  await test('a move leaves links in read-only notes alone and says so', async () => {
    const msg = expectOk(await call('move-note', { vault: 'notes', source: 'notes/Target.md', destination: 'notes/Moved.md' }));
    assert.ok(msg.includes('read-only'), msg);
    assert.strictEqual(read('areas/x/_index.md'), index);
    assert.ok(read('notes/Other.md').includes('Moved.md'), read('notes/Other.md'));
  });
  await test('a tag rename leaves read-only notes alone and says so', async () => {
    const msg = expectOk(await call('rename-tag', { vault: 'notes', oldTag: 'topic', newTag: 'subject' }));
    assert.ok(msg.includes('read-only'), msg);
    assert.strictEqual(read('areas/x/_index.md'), index);
    assert.ok(read('notes/Other.md').includes('#subject'));
  });
  await test('a read-only vault serves reads and refuses writes', async () => {
    expectOk(await call('read-note', { vault: 'code', path: 'src/a.md' }));
    expectError(await call('create-note', { vault: 'code', path: 'src/b.md', content: 'x' }), 'read-only');
    expectError(await call('read-note', { vault: 'code', path: 'node_modules/pkg/readme.md' }), 'not available');
    expectError(await call('read-note', { vault: 'code', path: 'dist/build.md' }), 'not available');
  });
  await test('ordinary notes stay writable', async () => {
    expectOk(await call('create-note', { vault: 'notes', path: 'notes/New.md', content: 'hello' }));
    assert.strictEqual(read('notes/New.md'), 'hello');
  });

  await client.close();

  await test('a policy naming an unknown tool stops startup', async () => {
    const bad = path.join(root, 'bad-tool.json');
    fs.writeFileSync(bad, JSON.stringify({ disabledTools: ['delete-folder'] }));
    const run = startFails(bad, notes);
    assert.notStrictEqual(run.code, 0);
    assert.ok(run.stderr.includes('unknown tool'), run.stderr);
  });
  await test('a policy naming a vault that is not served stops startup', async () => {
    const bad = path.join(root, 'bad-vault.json');
    fs.writeFileSync(bad, JSON.stringify({ vaults: { repos: { deny: ['dist'] } } }));
    const run = startFails(bad, notes);
    assert.notStrictEqual(run.code, 0);
    assert.ok(run.stderr.includes('not being served'), run.stderr);
  });
  await test('an unreadable policy stops startup', async () => {
    const run = startFails(path.join(root, 'missing.json'), notes);
    assert.notStrictEqual(run.code, 0);
    assert.ok(run.stderr.includes('cannot start'), run.stderr);
  });

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed) {
    process.stdout.write(`\nVaults kept for inspection: ${root}\n`);
    process.exit(1);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
