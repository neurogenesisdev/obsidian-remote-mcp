'use strict';

const path = require('path');
const { McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js');
const { joinTarget, resolveInVault, ensureExtension, VaultPathError } = require('../paths');
const { CanvasError } = require('../canvas');
const { FrontmatterError } = require('../markdown');

function text(body) {
  return { content: [{ type: 'text', text: String(body) }] };
}

function invalid(message) {
  return new McpError(ErrorCode.InvalidParams, message);
}

function notFound(message) {
  return new McpError(ErrorCode.InvalidParams, message);
}

// What a caller may see of an error. This server's own messages are written for
// the caller; anything else, a raw filesystem error above all, names absolute
// paths on the host, so only its code goes back and the rest goes to the log.
function callerMessage(err) {
  if (err instanceof McpError) return err.message.replace(/^MCP error -?\d+:\s*/, '');
  if (err instanceof VaultPathError || err instanceof CanvasError || err instanceof FrontmatterError) return err.message;
  const code = err && /^E[A-Z]+$/.test(err.code) ? ` (${err.code})` : '';
  return `The server could not complete this${code}.`;
}

// Every tool advertises `vault`, because the auth server strips it from the
// required list and injects DEFAULT_VAULT when one is configured. With a single
// vault the argument is redundant, so it is inferred rather than demanded.
const vaultProperty = {
  vault: { type: 'string', description: 'Name of the vault. Run list-available-vaults to see the options.' },
};

function pickVault(vaults, args) {
  const name = args && args.vault;
  if (!name) {
    if (vaults.size === 1) return [...vaults.values()][0];
    throw invalid(`This server serves several vaults, so "vault" is required. Available: ${[...vaults.keys()].join(', ')}.`);
  }
  const vault = vaults.get(name) || vaults.get(String(name).toLowerCase());
  if (!vault) {
    throw invalid(`Unknown vault "${name}". Available: ${[...vaults.keys()].join(', ')}.`);
  }
  return vault;
}

// Note tools take either `path` or upstream's `filename` + `folder` pair. The
// markdown extension is only appended when the name carries no extension at
// all, so the same tools work on a .canvas file.
const targetProperties = {
  path: { type: 'string', description: 'Path relative to the vault root, e.g. "journal/2026/note.md". Preferred over filename + folder.' },
  filename: { type: 'string', description: 'Note name on its own. Use with "folder" if you are not passing "path".' },
  folder: { type: 'string', description: 'Folder relative to the vault root, used with "filename".' },
};

function resolveTarget(vault, args, { write = false, entry = false, ext = '.md' } = {}) {
  try {
    const rel = ensureExtension(joinTarget(args), ext);
    return resolveInVault(vault, rel, { write, entry });
  } catch (err) {
    if (err instanceof VaultPathError) throw invalid(err.message);
    throw err;
  }
}

function resolveRaw(vault, relative, { write = false } = {}) {
  try {
    return resolveInVault(vault, relative, { write });
  } catch (err) {
    if (err instanceof VaultPathError) throw invalid(err.message);
    throw err;
  }
}

function schema(properties, required = []) {
  return { type: 'object', properties: { ...vaultProperty, ...properties }, required };
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function when(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function relOf(vault, abs) {
  return path.relative(vault.path, abs).split(path.sep).join('/');
}

module.exports = {
  bytes,
  callerMessage,
  invalid,
  notFound,
  pickVault,
  relOf,
  resolveRaw,
  resolveTarget,
  schema,
  targetProperties,
  text,
  vaultProperty,
  when,
};
