'use strict';

// Path resolution and containment for vault-relative paths. Everything a tool
// receives is untrusted, so nothing reaches the filesystem without passing
// through resolveInVault first.

const path = require('path');
const fs = require('fs');

// Writing into .obsidian can corrupt the vault for every Obsidian client that
// syncs it, and this server is reachable from the internet. Reads are allowed
// so daily-note and attachment settings can be honoured.
const READ_ONLY_DIRS = ['.obsidian'];
const HIDDEN_DIRS = new Set(['.obsidian', '.trash', '.git', '.stfolder', '.stversions']);

function toPosix(p) {
  return p.split(path.sep).join('/');
}

// Vault-relative, no leading slash, no . or .. segments left in it.
function normalizeRelative(input) {
  const posix = toPosix(String(input || '')).replace(/^\/+/, '');
  const normalized = path.posix.normalize(posix);
  if (normalized === '.' || normalized === './') return '';
  return normalized.replace(/^\/+/, '').replace(/\/+$/, '');
}

function hasExtension(name) {
  return /\.[A-Za-z0-9]{1,12}$/.test(name);
}

function ensureExtension(name, ext) {
  return hasExtension(name) ? name : `${name}${ext}`;
}

class VaultPathError extends Error {}

// Accepts either `path` (preferred, may contain folders) or upstream's
// `filename` + `folder` pair, so callers written against obsidian-mcp keep
// working unchanged.
function joinTarget({ path: p, filename, folder }) {
  if (p) return normalizeRelative(p);
  if (!filename) {
    throw new VaultPathError('Provide "path" (relative to the vault root), or "filename" with an optional "folder".');
  }
  if (path.isAbsolute(filename)) {
    throw new VaultPathError('"filename" must not be an absolute path.');
  }
  const dir = folder ? normalizeRelative(folder) : '';
  return normalizeRelative(dir ? `${dir}/${filename}` : filename);
}

// Resolves a vault-relative path to an absolute one and proves it stays inside
// the vault. Symlinks are resolved on the deepest existing ancestor, so a link
// planted inside the vault cannot be used to write outside it.
function resolveInVault(vault, relative, { write = false } = {}) {
  const rel = normalizeRelative(relative);
  if (!rel) throw new VaultPathError('Path cannot be empty or the vault root.');
  if (rel === '..' || rel.startsWith('../')) {
    throw new VaultPathError(`Path escapes the vault: ${relative}`);
  }

  const abs = path.resolve(vault.path, rel);
  const real = realpathOfNearestParent(abs);
  const rootReal = vault.realPath;
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new VaultPathError(`Path escapes the vault: ${relative}`);
  }

  if (write) {
    const first = rel.split('/')[0];
    if (READ_ONLY_DIRS.includes(first)) {
      throw new VaultPathError(`${first}/ is read-only. Writing there would corrupt the vault configuration.`);
    }
  }

  return { rel, abs };
}

// The target may not exist yet, and realpath fails on missing paths. Walk up to
// the nearest ancestor that does exist, resolve that, then re-attach the tail.
function realpathOfNearestParent(abs) {
  let current = abs;
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) return abs;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function isHiddenDir(name) {
  return HIDDEN_DIRS.has(name) || name.startsWith('.');
}

function parentDir(rel) {
  const dir = path.posix.dirname(rel);
  return dir === '.' ? '' : dir;
}

function basenameNoExt(rel) {
  return path.posix.basename(rel).replace(/\.[^.]+$/, '');
}

module.exports = {
  VaultPathError,
  basenameNoExt,
  ensureExtension,
  hasExtension,
  isHiddenDir,
  joinTarget,
  normalizeRelative,
  parentDir,
  resolveInVault,
  toPosix,
};
