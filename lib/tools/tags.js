'use strict';

const path = require('path');
const md = require('../markdown');
const ops = require('../fsops');
const policy = require('../policy');
const { invalid, pickVault, resolveTarget, schema, text } = require('./common');

const TAG_SHAPE = /^[\p{L}\p{N}_/-]+$/u;

function cleanTags(input, normalize) {
  if (!Array.isArray(input) || input.length === 0) throw invalid('"tags" must be a non-empty array.');
  return input.map((raw) => {
    const tag = String(raw).replace(/^#/, '').replace(/\/+$/, '');
    if (!TAG_SHAPE.test(tag)) {
      throw invalid(`"${raw}" is not a usable tag. Use letters, numbers, hyphens, underscores and / for hierarchy, without the # symbol.`);
    }
    return normalize === false ? tag : md.normalizeTag(tag);
  });
}

// A tag matches its own hierarchy: removing or renaming "work" also covers
// "work/active", which is how Obsidian treats nested tags.
function inHierarchy(tag, root) {
  const a = tag.toLowerCase();
  const b = root.toLowerCase();
  return a === b || a.startsWith(`${b}/`);
}

function frontmatterList(doc) {
  const existing = doc.get('tags');
  if (existing && existing.items) return existing.items.map((i) => String(i.value ?? i));
  if (typeof existing === 'string') return existing.split(/[,\s]+/).filter(Boolean);
  if (Array.isArray(existing)) return existing.map(String);
  return [];
}

async function eachFile(vault, files, fn) {
  if (!Array.isArray(files) || files.length === 0) throw invalid('"files" must be a non-empty array of vault-relative paths.');
  const done = [];
  const failed = [];
  for (const file of files) {
    try {
      const { rel, abs } = resolveTarget(vault, { path: file }, { write: true });
      if (!(await ops.exists(abs))) throw new Error('not found');
      const before = await ops.readText(abs);
      const after = fn(before, rel);
      if (after !== null && after !== before) {
        await ops.writeText(abs, after);
        done.push(rel);
      }
    } catch (err) {
      failed.push(`${file}: ${err.message}`);
    }
  }
  vault.invalidate();
  return { done, failed };
}

function report(verb, { done, failed }) {
  const lines = [`${verb} ${done.length} note${done.length === 1 ? '' : 's'}.`];
  if (done.length) lines.push(...done.map((d) => `  ${d}`));
  if (failed.length) lines.push('', `${failed.length} failed:`, ...failed.map((f) => `  ${f}`));
  return text(lines.join('\n'));
}

const tools = [
  {
    name: 'add-tags',
    description:
      'Add tags to one or more notes, in the frontmatter, inline in the body, or both. ' +
      'Pass tags without the # symbol; use / for hierarchy.\n\n' +
      'Example: { "files": ["note.md"], "tags": ["project/dude", "status/active"] }',
    inputSchema: schema(
      {
        files: { type: 'array', items: { type: 'string' }, description: 'Vault-relative paths of the notes to tag.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags without #, e.g. ["work/active"].' },
        location: { type: 'string', enum: ['frontmatter', 'content', 'both'], description: 'Where to add them. Default frontmatter.' },
        position: { type: 'string', enum: ['start', 'end'], description: 'For inline tags, which end of the body. Default end.' },
        normalize: { type: 'boolean', description: 'Lower-case and hyphenate the tags. Default true.' },
      },
      ['files', 'tags']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const tags = cleanTags(args.tags, args.normalize);
      const location = args.location || 'frontmatter';

      const result = await eachFile(vault, args.files, (content) => {
        let out = content;
        if (location === 'frontmatter' || location === 'both') {
          out = md.setFrontmatter(out, (doc) => {
            const current = frontmatterList(doc);
            const merged = [...current];
            for (const tag of tags) if (!current.some((c) => c.toLowerCase() === tag.toLowerCase())) merged.push(tag);
            doc.set('tags', merged);
          });
        }
        if (location === 'content' || location === 'both') {
          const { body, offset } = md.splitFrontmatter(out);
          const present = new Set(md.inlineTags(body).map((t) => t.toLowerCase()));
          const missing = tags.filter((t) => !present.has(t.toLowerCase()));
          if (missing.length) {
            const line = missing.map((t) => `#${t}`).join(' ');
            const newBody =
              args.position === 'start'
                ? `${line}\n\n${body.replace(/^\n+/, '')}`
                : `${body.replace(/\n+$/, '')}\n\n${line}\n`;
            out = out.slice(0, offset) + newBody;
          }
        }
        return out;
      });

      return report(`Added ${tags.map((t) => `#${t}`).join(' ')} to`, result);
    },
  },

  {
    name: 'remove-tags',
    description:
      'Remove tags from one or more notes. Removing a parent tag removes its children too, so removing "work" ' +
      'also removes "work/active".',
    inputSchema: schema(
      {
        files: { type: 'array', items: { type: 'string' }, description: 'Vault-relative paths of the notes to change.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to remove, without #.' },
        location: { type: 'string', enum: ['frontmatter', 'content', 'both'], description: 'Where to remove from. Default both.' },
        normalize: { type: 'boolean', description: 'Match against normalised tag forms. Default true.' },
      },
      ['files', 'tags']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const tags = cleanTags(args.tags, args.normalize);
      const location = args.location || 'both';
      const matches = (tag) => tags.some((t) => inHierarchy(tag, t));

      const result = await eachFile(vault, args.files, (content) => {
        let out = content;
        if (location === 'frontmatter' || location === 'both') {
          out = md.setFrontmatter(out, (doc) => {
            const kept = frontmatterList(doc).filter((t) => !matches(t.replace(/^#/, '')));
            if (kept.length) doc.set('tags', kept);
            else doc.delete('tags');
          });
        }
        if (location === 'content' || location === 'both') {
          const { body, offset } = md.splitFrontmatter(out);
          const edits = md.inlineTagMatches(body)
            .filter((m) => matches(m.tag))
            .map((m) => ({ start: m.index, end: m.index + m.length, replacement: '' }));
          if (edits.length) {
            // Collapse the whitespace the removed tag leaves behind rather than
            // stranding double spaces or an empty tag line.
            const stripped = ops.spliceAll(body, edits).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
            out = out.slice(0, offset) + stripped;
          }
        }
        return out;
      });

      return report(`Removed ${tags.map((t) => `#${t}`).join(' ')} from`, result);
    },
  },

  {
    name: 'rename-tag',
    description:
      'Rename a tag across the whole vault, in frontmatter and inline, keeping the hierarchy underneath it. ' +
      'Renaming "work" to "projects" turns "work/active" into "projects/active".',
    inputSchema: schema(
      {
        oldTag: { type: 'string', description: 'Current tag, without #.' },
        newTag: { type: 'string', description: 'Replacement tag, without #.' },
        normalize: { type: 'boolean', description: 'Normalise the new tag. Default true.' },
      },
      ['oldTag', 'newTag']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const [oldTag] = cleanTags([args.oldTag], false);
      const [newTag] = cleanTags([args.newTag], args.normalize);
      if (oldTag.toLowerCase() === newTag.toLowerCase()) throw invalid('The old and new tag are the same.');

      await vault.index();
      const rename = (tag) => (inHierarchy(tag, oldTag) ? newTag + tag.slice(oldTag.length) : null);
      const candidates = [...vault.notes.values()].filter((n) => n.tags.some((t) => inHierarchy(t, oldTag)));

      let changed = 0;
      let skipped = 0;
      for (const note of candidates) {
        if (policy.isReadOnly(vault.name, note.rel)) {
          skipped += 1;
          continue;
        }
        const abs = path.join(vault.path, note.rel);
        let content;
        try {
          content = await ops.readText(abs);
        } catch {
          continue;
        }

        let out = md.setFrontmatter(content, (doc) => {
          const list = frontmatterList(doc);
          if (!list.some((t) => inHierarchy(t.replace(/^#/, ''), oldTag))) return;
          doc.set('tags', list.map((t) => rename(t.replace(/^#/, '')) || t));
        });

        const { body, offset } = md.splitFrontmatter(out);
        const edits = [];
        for (const match of md.inlineTagMatches(body)) {
          const next = rename(match.tag);
          if (next) edits.push({ start: match.index, end: match.index + match.length, replacement: `#${next}` });
        }
        if (edits.length) out = out.slice(0, offset) + ops.spliceAll(body, edits);

        if (out !== content) {
          await ops.writeText(abs, out);
          changed += 1;
        }
      }

      vault.invalidate();
      const left = skipped ? ` ${skipped} read-only note${skipped === 1 ? '' : 's'} left unchanged.` : '';
      return text(`Renamed #${oldTag} to #${newTag} in ${changed} note${changed === 1 ? '' : 's'}.${left}`);
    },
  },

  {
    name: 'list-tags',
    description:
      'Every tag in the vault with how many notes use it. Use this before tagging, so new notes reuse the ' +
      'vocabulary already in the vault instead of inventing near-duplicates.',
    inputSchema: schema(
      {
        prefix: { type: 'string', description: 'Only tags starting with this, e.g. "project" for the whole project/ hierarchy.' },
        minCount: { type: 'number', description: 'Hide tags used fewer times than this. Default 1.' },
        sort: { type: 'string', enum: ['count', 'name'], description: 'Default count.' },
        limit: { type: 'number', description: 'Maximum tags to return. Default 200.' },
      },
      []
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      await vault.index();
      const counts = new Map();
      for (const note of vault.notes.values()) {
        for (const tag of new Set(note.tags.map((t) => t.toLowerCase()))) {
          counts.set(tag, (counts.get(tag) || 0) + 1);
        }
      }

      const prefix = args.prefix ? args.prefix.replace(/^#/, '').toLowerCase() : null;
      const min = args.minCount || 1;
      let rows = [...counts.entries()]
        .filter(([tag, count]) => count >= min && (!prefix || inHierarchy(tag, prefix)))
        .sort((a, b) => (args.sort === 'name' ? a[0].localeCompare(b[0]) : b[1] - a[1] || a[0].localeCompare(b[0])));

      const total = rows.length;
      const limit = args.limit || 200;
      rows = rows.slice(0, limit);

      const lines = [`${total} distinct tag${total === 1 ? '' : 's'}${prefix ? ` under #${prefix}` : ''} in ${vault.name}.`, ''];
      lines.push(...rows.map(([tag, count]) => `  ${String(count).padStart(5)}  #${tag}`));
      if (total > rows.length) lines.push('', `[showing ${rows.length} of ${total}; raise "limit" for more]`);
      return text(lines.join('\n'));
    },
  },
];

module.exports = { tools };
