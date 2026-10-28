'use strict';

// Local access policy: paths no tool may touch, paths tools may read but not
// write, and tools that are switched off. The containment in paths.js keeps
// callers inside a vault; this decides what they may do once they are in it.
//
// Loaded from the JSON file named by VAULT_POLICY. Without that variable the
// server behaves exactly as before. With it, a file that cannot be read or
// parsed stops the server from starting, so a typo never serves a vault
// unprotected.
//
//   {
//     "disabledTools": ["delete-directory"],
//     "vaults": {
//       "*":     { "deny": [".git", ".env*"] },
//       "notes": { "deny": ["_private"], "readOnly": ["CLAUDE.md", "**/_index.md"] }
//     }
//   }
//
// Patterns are vault-relative globs, matched case-insensitively. "*" stays
// within one path segment, "**" crosses segments, and a pattern without a "/"
// matches that name at any depth. A pattern covers the path it names and
// everything below it, so "_private" hides the folder and all it holds.
// Rules under "*" apply to every vault on top of the vault's own. A vault named
// in the policy but not served stops startup: its rules would silently apply
// to nothing, for example after the folder behind it was renamed.

const fs = require('fs');
const path = require('path');

let state = null;
const roots = []; // { vault, real } for every registered vault

function globToRegExp(pattern) {
  let p = String(pattern).trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!p) throw new Error('empty pattern');
  if (!p.includes('/')) p = `**/${p}`;
  let re = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}(?:/.*)?$`, 'i');
}

function compileList(list, where) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${where} must be an array`);
  return list.map((p) => {
    if (typeof p !== 'string') throw new Error(`${where} holds a non-string pattern`);
    return globToRegExp(p);
  });
}

function load(file = process.env.VAULT_POLICY) {
  if (!file) {
    state = null;
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const vaults = new Map();
  for (const [name, rules] of Object.entries(raw.vaults || {})) {
    vaults.set(name.toLowerCase(), {
      deny: compileList(rules.deny, `vaults.${name}.deny`),
      readOnly: compileList(rules.readOnly, `vaults.${name}.readOnly`),
    });
  }
  const disabled = raw.disabledTools || [];
  if (!Array.isArray(disabled)) throw new Error('disabledTools must be an array');
  state = { file, vaults, disabledTools: new Set(disabled) };
  return state;
}

function rulesFor(vaultName) {
  if (!state) return [];
  return [state.vaults.get('*'), state.vaults.get(String(vaultName).toLowerCase())].filter(Boolean);
}

function matches(vaultName, rel, key) {
  if (!rel) return false;
  return rulesFor(vaultName).some((rules) => rules[key].some((re) => re.test(rel)));
}

function isDenied(vaultName, rel) {
  return matches(vaultName, rel, 'deny');
}

function isReadOnly(vaultName, rel) {
  return matches(vaultName, rel, 'readOnly');
}

function isToolDisabled(name) {
  return !!state && state.disabledTools.has(name);
}

function vaultNames() {
  return state ? [...state.vaults.keys()].filter((name) => name !== '*') : [];
}

function disabledTools() {
  return state ? [...state.disabledTools] : [];
}

function registerVault(vault) {
  roots.push({ vault, real: vault.realPath });
}

// For writes that arrive with an absolute path only: map it back to its vault
// so the read-only rules still hold when a caller skipped resolveInVault.
function locate(abs) {
  const resolved = path.resolve(abs);
  for (const { vault, real } of roots) {
    for (const root of new Set([vault.path, real])) {
      if (resolved === root || resolved.startsWith(root + path.sep)) {
        return { vault, rel: path.relative(root, resolved).split(path.sep).join('/') };
      }
    }
  }
  return null;
}

module.exports = {
  disabledTools,
  globToRegExp,
  isDenied,
  isReadOnly,
  isToolDisabled,
  load,
  locate,
  registerVault,
  vaultNames,
  get active() {
    return !!state;
  },
};
