'use strict';

// Vault registry and the in-memory index every listing, tag, link and search
// tool reads from.
//
// A vault of several thousand notes is too slow to re-read on every call and
// too small to justify a database. The index stats the tree on demand and only
// re-parses files whose size or mtime moved, so a warm call costs a directory
// walk and nothing else.

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const md = require('./markdown');
const { isHiddenDir, toPosix, basenameNoExt, parentDir } = require('./paths');
const policy = require('./policy');

const WALK_TTL_MS = 2000;
const MARKDOWN = new Set(['.md', '.markdown']);

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

class Vault {
  constructor(name, vaultPath) {
    this.name = name;
    this.path = vaultPath;
    this.realPath = fsSync.realpathSync(vaultPath);
    this.notes = new Map(); // rel -> parsed entry
    this.files = new Map(); // rel -> { size, mtimeMs, ext }
    this.walkedAt = 0;
    this.walking = null;
    this.resolver = null;
  }

  // Callers always await this before reading `notes`/`files`. Concurrent tool
  // calls share one walk rather than each starting their own.
  async index() {
    if (this.walking) return this.walking;
    if (Date.now() - this.walkedAt < WALK_TTL_MS) return this;
    this.walking = this.#walk()
      .then(() => {
        this.walkedAt = Date.now();
        this.walking = null;
        return this;
      })
      .catch((err) => {
        this.walking = null;
        throw err;
      });
    return this.walking;
  }

  // Forces the next index() to do real work. Called after every write so a
  // tool never reads its own change back as stale.
  invalidate() {
    this.walkedAt = 0;
    this.resolver = null;
  }

  async #walk() {
    const seen = new Set();
    const stack = [''];

    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = await fs.readdir(path.join(this.path, dir), { withFileTypes: true });
      } catch {
        continue; // removed mid-walk, or unreadable
      }

      for (const entry of entries) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!isHiddenDir(entry.name) && !policy.isDenied(this.name, rel)) stack.push(rel);
          continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (entry.name.startsWith('.')) continue;
        if (policy.isDenied(this.name, rel)) continue;

        let stat;
        try {
          stat = await fs.stat(path.join(this.path, rel));
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;

        seen.add(rel);
        const ext = path.extname(entry.name).toLowerCase();
        const known = this.files.get(rel);
        const meta = { size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs, ext };
        this.files.set(rel, meta);

        if (!MARKDOWN.has(ext)) continue;
        if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs && this.notes.has(rel)) {
          continue;
        }
        const parsed = await this.#parse(rel, meta);
        if (parsed) this.notes.set(rel, parsed);
      }
    }

    for (const rel of [...this.files.keys()]) if (!seen.has(rel)) this.files.delete(rel);
    for (const rel of [...this.notes.keys()]) if (!seen.has(rel)) this.notes.delete(rel);
    this.resolver = null;
  }

  async #parse(rel, meta) {
    let content;
    try {
      content = await fs.readFile(path.join(this.path, rel), 'utf8');
    } catch {
      return null;
    }
    const { frontmatter, body, present } = md.splitFrontmatter(content);
    const tags = new Set([...md.frontmatterTags(frontmatter), ...md.inlineTags(body)]);
    const aliases = [];
    if (frontmatter) {
      const raw = frontmatter.aliases ?? frontmatter.alias;
      if (Array.isArray(raw)) aliases.push(...raw.filter((a) => typeof a === 'string'));
      else if (typeof raw === 'string') aliases.push(raw);
    }

    return {
      rel,
      name: basenameNoExt(rel),
      folder: parentDir(rel),
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      birthtimeMs: meta.birthtimeMs,
      title: (frontmatter && typeof frontmatter.title === 'string' && frontmatter.title) || basenameNoExt(rel),
      frontmatter: frontmatter || {},
      frontmatterBroken: present && frontmatter === null,
      aliases,
      tags: [...tags],
      links: md.parseLinks(body),
      headings: md.parseHeadings(content).length,
    };
  }

  // Lookup tables for link resolution, rebuilt whenever the walk changed
  // anything. Keys are lower-cased because Obsidian matches case-insensitively.
  #buildResolver() {
    const byPath = new Map();
    const byName = new Map();
    const byAlias = new Map();

    for (const rel of this.files.keys()) {
      byPath.set(rel.toLowerCase(), rel);
      const noExt = rel.replace(/\.[^./]+$/, '').toLowerCase();
      if (!byPath.has(noExt)) byPath.set(noExt, rel);
      const base = path.posix.basename(rel).toLowerCase();
      push(byName, base, rel);
      const baseNoExt = basenameNoExt(rel).toLowerCase();
      if (baseNoExt !== base) push(byName, baseNoExt, rel);
    }
    for (const note of this.notes.values()) {
      for (const alias of note.aliases) push(byAlias, alias.toLowerCase(), note.rel);
    }

    this.resolver = { byPath, byName, byAlias };
    return this.resolver;
  }

  // Obsidian's own resolution order: an explicit path wins, then a unique
  // basename, then an alias. When a basename is ambiguous it prefers the note
  // in the linking note's own folder, then the shallowest path.
  resolveLink(target, fromRel = '') {
    const { byPath, byName, byAlias } = this.resolver || this.#buildResolver();
    const key = target.toLowerCase().replace(/^\.\//, '');

    const direct = byPath.get(key) || byPath.get(`${key}.md`);
    if (direct) return direct;

    if (fromRel) {
      const sibling = parentDir(fromRel) ? `${parentDir(fromRel)}/${key}` : key;
      const near = byPath.get(sibling) || byPath.get(`${sibling}.md`);
      if (near) return near;
    }

    const candidates = byName.get(key) || byName.get(`${key}.md`) || byAlias.get(key);
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const fromFolder = parentDir(fromRel);
    const sameFolder = candidates.filter((c) => parentDir(c) === fromFolder);
    const pool = sameFolder.length ? sameFolder : candidates;
    return [...pool].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
  }

  // Reverse link map, built on demand. Only the tools that need it pay for it.
  backlinks() {
    const map = new Map();
    for (const note of this.notes.values()) {
      for (const link of note.links) {
        const target = this.resolveLink(link.target, note.rel);
        if (!target) continue;
        if (!map.has(target)) map.set(target, []);
        const list = map.get(target);
        if (!list.some((b) => b.rel === note.rel && b.raw === link.raw)) {
          list.push({ rel: note.rel, raw: link.raw, embed: link.embed, fragment: link.fragment });
        }
      }
    }
    return map;
  }
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

// Duplicate slugs get a numeric suffix, matching how obsidian-mcp named vaults,
// so an existing DEFAULT_VAULT keeps pointing at the same directory.
function createRegistry(paths) {
  const vaults = new Map();
  for (const raw of paths) {
    const resolved = path.resolve(raw.replace(/^~(?=$|\/)/, process.env.HOME || ''));
    const stat = fsSync.statSync(resolved);
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);

    let name = slugify(path.basename(resolved)) || 'vault';
    if (vaults.has(name)) {
      let n = 1;
      while (vaults.has(`${name}-${n}`)) n += 1;
      name = `${name}-${n}`;
    }
    const vault = new Vault(name, resolved);
    vaults.set(name, vault);
    policy.registerVault(vault);
  }
  return vaults;
}

module.exports = { Vault, createRegistry, slugify, toPosix, MARKDOWN };
