'use strict';

const fs = require('fs').promises;
const path = require('path');
const { isHiddenDir } = require('../paths');
const { bytes, notFound, pickVault, resolveRaw, schema, text, when } = require('./common');

function inHierarchy(tag, root) {
  const a = String(tag).toLowerCase();
  const b = String(root).replace(/^#/, '').toLowerCase();
  return a === b || a.startsWith(`${b}/`);
}

const tools = [
  {
    name: 'list-available-vaults',
    description: 'The vaults this server exposes, with how many notes and files each holds.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async handler(_args, { vaults }) {
      if (vaults.size === 0) return text('No vaults are configured.');
      const lines = ['Available vaults:', ''];
      for (const vault of vaults.values()) {
        await vault.index();
        lines.push(`  ${vault.name}  -  ${vault.notes.size} notes, ${vault.files.size} files total`);
      }
      if (vaults.size === 1) lines.push('', 'Only one vault, so the "vault" argument can be left out.');
      return text(lines.join('\n'));
    },
  },

  {
    name: 'get-vault-stats',
    description:
      'A summary of the vault: note and file counts, total words, tag and link totals, biggest folders, and how ' +
      'recently it changed. Worth reading once before working in an unfamiliar vault.',
    inputSchema: schema({}, []),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      await vault.index();

      const notes = [...vault.notes.values()];
      const tags = new Set();
      let links = 0;
      let noteBytes = 0;
      const folders = new Map();
      for (const note of notes) {
        note.tags.forEach((t) => tags.add(t.toLowerCase()));
        links += note.links.length;
        noteBytes += note.size;
        const folder = note.folder || '(root)';
        folders.set(folder, (folders.get(folder) || 0) + 1);
      }

      const attachments = [...vault.files.entries()].filter(([rel]) => !/\.(md|markdown)$/i.test(rel));
      const attachmentBytes = attachments.reduce((sum, [, meta]) => sum + meta.size, 0);
      const newest = notes.reduce((max, n) => Math.max(max, n.mtimeMs), 0);
      const top = [...folders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      const broken = notes.reduce(
        (sum, n) => sum + n.links.filter((l) => !vault.resolveLink(l.target, n.rel)).length,
        0
      );

      return text(
        [
          `Vault: ${vault.name}`,
          '',
          `  Notes            ${notes.length} (${bytes(noteBytes)})`,
          `  Other files      ${attachments.length} (${bytes(attachmentBytes)})`,
          `  Folders          ${folders.size}`,
          `  Distinct tags    ${tags.size}`,
          `  Links            ${links}, of which ${broken} broken`,
          `  Last change      ${newest ? when(newest) : 'unknown'}`,
          '',
          'Largest folders:',
          ...top.map(([folder, count]) => `  ${String(count).padStart(6)}  ${folder}`),
        ].join('\n')
      );
    },
  },

  {
    name: 'list-directory',
    description:
      'List one folder: its subfolders and files, without descending into them. Use this to explore a vault ' +
      'whose structure you do not know yet, rather than listing every note at once.',
    inputSchema: schema(
      {
        path: { type: 'string', description: 'Folder relative to the vault root. Omit for the root.' },
        recursive: { type: 'boolean', description: 'Descend into subfolders. Default false.' },
        limit: { type: 'number', description: 'Maximum entries. Default 500.' },
      },
      []
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const rel = args.path ? resolveRaw(vault, args.path).rel : '';
      const abs = rel ? path.join(vault.path, rel) : vault.path;

      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        throw notFound(`No such folder: ${rel || '(vault root)'}`);
      }

      const limit = args.limit || 500;
      const folders = [];
      const files = [];

      if (args.recursive) {
        await vault.index();
        const prefix = rel ? `${rel}/` : '';
        for (const [file, meta] of vault.files) {
          if (!file.startsWith(prefix)) continue;
          files.push({ rel: file, size: meta.size, mtimeMs: meta.mtimeMs });
        }
        files.sort((a, b) => a.rel.localeCompare(b.rel));
      } else {
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          if (entry.isDirectory()) {
            if (!isHiddenDir(entry.name)) folders.push(entry.name);
            continue;
          }
          const stat = await fs.stat(path.join(abs, entry.name)).catch(() => null);
          if (stat) files.push({ rel: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
        }
        folders.sort((a, b) => a.localeCompare(b));
        files.sort((a, b) => a.rel.localeCompare(b.rel));
      }

      const lines = [`${rel || '(vault root)'} in ${vault.name}: ${folders.length} folders, ${files.length} files`, ''];
      for (const folder of folders.slice(0, limit)) lines.push(`  ${folder}/`);
      for (const file of files.slice(0, Math.max(0, limit - folders.length))) {
        lines.push(`  ${file.rel}   ${bytes(file.size)}, ${when(file.mtimeMs)}`);
      }
      const shown = Math.min(folders.length, limit) + Math.max(0, Math.min(files.length, limit - folders.length));
      if (folders.length + files.length > shown) {
        lines.push('', `[${folders.length + files.length - shown} more; raise "limit" to see them]`);
      }
      return text(lines.join('\n'));
    },
  },

  {
    name: 'list-notes',
    description:
      'List notes across the vault with optional filters, newest first by default. For finding notes by their ' +
      'text use search-vault; this is for enumerating by folder, tag or date.',
    inputSchema: schema(
      {
        folder: { type: 'string', description: 'Only notes under this folder.' },
        tag: { type: 'string', description: 'Only notes carrying this tag. Parent tags match their children.' },
        modifiedAfter: { type: 'string', description: 'ISO date. Only notes modified on or after it.' },
        sort: { type: 'string', enum: ['modified', 'created', 'name', 'size'], description: 'Default modified.' },
        limit: { type: 'number', description: 'Maximum notes. Default 100.' },
      },
      []
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      await vault.index();
      const prefix = args.folder ? `${String(args.folder).replace(/^\/+|\/+$/g, '')}/` : null;
      const after = args.modifiedAfter ? Date.parse(args.modifiedAfter) : null;

      let notes = [...vault.notes.values()];
      if (prefix) notes = notes.filter((n) => n.rel.startsWith(prefix));
      if (args.tag) notes = notes.filter((n) => n.tags.some((t) => inHierarchy(t, args.tag)));
      if (after !== null && !Number.isNaN(after)) notes = notes.filter((n) => n.mtimeMs >= after);

      const sorters = {
        modified: (a, b) => b.mtimeMs - a.mtimeMs,
        created: (a, b) => b.birthtimeMs - a.birthtimeMs,
        name: (a, b) => a.rel.localeCompare(b.rel),
        size: (a, b) => b.size - a.size,
      };
      notes.sort(sorters[args.sort] || sorters.modified);

      const limit = args.limit || 100;
      const shown = notes.slice(0, limit);
      if (notes.length === 0) return text('No notes match those filters.');

      const lines = [`${notes.length} note${notes.length === 1 ? '' : 's'}${notes.length > shown.length ? `, showing ${shown.length}` : ''}:`, ''];
      for (const note of shown) lines.push(`  ${when(note.mtimeMs)}  ${bytes(note.size).padStart(9)}  ${note.rel}`);
      if (notes.length > shown.length) lines.push('', `[${notes.length - shown.length} more; raise "limit" to see them]`);
      return text(lines.join('\n'));
    },
  },

  {
    name: 'get-recent-notes',
    description:
      'The notes changed most recently, with their tags. The fastest way to pick up where the vault was left off.',
    inputSchema: schema(
      {
        limit: { type: 'number', description: 'How many notes. Default 20.' },
        days: { type: 'number', description: 'Only notes changed within this many days.' },
        folder: { type: 'string', description: 'Only notes under this folder.' },
      },
      []
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      await vault.index();
      const cutoff = args.days ? Date.now() - args.days * 86400000 : null;
      const prefix = args.folder ? `${String(args.folder).replace(/^\/+|\/+$/g, '')}/` : null;

      const notes = [...vault.notes.values()]
        .filter((n) => (cutoff === null || n.mtimeMs >= cutoff) && (!prefix || n.rel.startsWith(prefix)))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, args.limit || 20);

      if (notes.length === 0) return text(cutoff ? `No notes changed in the last ${args.days} days.` : 'The vault has no notes.');
      const lines = [`${notes.length} most recently changed note${notes.length === 1 ? '' : 's'}:`, ''];
      for (const note of notes) {
        const tags = note.tags.length ? `   ${note.tags.slice(0, 6).map((t) => `#${t}`).join(' ')}` : '';
        lines.push(`  ${when(note.mtimeMs)}  ${note.rel}${tags}`);
      }
      return text(lines.join('\n'));
    },
  },
];

module.exports = { tools };
