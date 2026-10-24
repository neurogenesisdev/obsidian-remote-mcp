'use strict';

const fs = require('fs').promises;
const path = require('path');
const { bytes, invalid, notFound, pickVault, resolveRaw, schema, text, when } = require('./common');

const IMAGE = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};
const TEXTUAL = new Set(['.txt', '.csv', '.json', '.yaml', '.yml', '.xml', '.svg', '.log', '.js', '.ts', '.py', '.sh', '.css', '.html']);

// Above this an inline attachment costs more context than it is worth, and the
// caller is better told the path so a human can open it.
const INLINE_LIMIT = 4 * 1024 * 1024;

const tools = [
  {
    name: 'list-attachments',
    description:
      'Every non-markdown file in the vault - images, PDFs, audio, whatever was dropped in. Canvases are ' +
      'excluded; list-canvases covers those.',
    inputSchema: schema(
      {
        folder: { type: 'string', description: 'Only files under this folder. Defaults to the whole vault.' },
        extension: { type: 'string', description: 'Filter by extension, with or without the dot, e.g. "png".' },
        sort: { type: 'string', enum: ['modified', 'size', 'name'], description: 'Default modified.' },
        limit: { type: 'number', description: 'Maximum files. Default 100.' },
      },
      []
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      await vault.index();
      const prefix = args.folder ? `${String(args.folder).replace(/^\/+|\/+$/g, '')}/` : null;
      const ext = args.extension ? `.${String(args.extension).replace(/^\./, '').toLowerCase()}` : null;

      let files = [...vault.files.entries()]
        .filter(([rel]) => !/\.(md|markdown|canvas)$/i.test(rel))
        .filter(([rel]) => !prefix || rel.startsWith(prefix))
        .filter(([rel]) => !ext || rel.toLowerCase().endsWith(ext));

      const sorters = {
        modified: (a, b) => b[1].mtimeMs - a[1].mtimeMs,
        size: (a, b) => b[1].size - a[1].size,
        name: (a, b) => a[0].localeCompare(b[0]),
      };
      files.sort(sorters[args.sort] || sorters.modified);

      const total = files.length;
      const totalBytes = files.reduce((sum, [, meta]) => sum + meta.size, 0);
      files = files.slice(0, args.limit || 100);
      if (total === 0) return text('No attachments match those filters.');

      const lines = [`${total} attachment${total === 1 ? '' : 's'}, ${bytes(totalBytes)} in total:`, ''];
      for (const [rel, meta] of files) lines.push(`  ${when(meta.mtimeMs)}  ${bytes(meta.size).padStart(9)}  ${rel}`);
      if (total > files.length) lines.push('', `[${total - files.length} more; raise "limit" to see them]`);
      return text(lines.join('\n'));
    },
  },

  {
    name: 'read-attachment',
    description:
      'Read a non-markdown file from the vault. Images come back as images you can actually look at, text-like ' +
      'files as text, and anything else as its metadata only.',
    inputSchema: schema(
      {
        path: { type: 'string', description: 'File path relative to the vault root.' },
        maxBytes: { type: 'number', description: `Refuse above this size. Default ${INLINE_LIMIT}.` },
      },
      ['path']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel, abs } = resolveRaw(vault, args.path);
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        throw notFound(`No such file: ${rel}`);
      }
      if (!stat.isFile()) throw invalid(`${rel} is not a file.`);

      const ext = path.extname(rel).toLowerCase();
      const limit = args.maxBytes || INLINE_LIMIT;
      const header = `${rel}  (${bytes(stat.size)}, modified ${when(stat.mtimeMs)})`;

      if (stat.size > limit) {
        return text(`${header}\n\nToo large to return inline (limit ${bytes(limit)}). Raise "maxBytes" if you really need it.`);
      }

      if (IMAGE[ext] && ext !== '.svg') {
        const data = await fs.readFile(abs);
        return {
          content: [
            { type: 'text', text: header },
            { type: 'image', data: data.toString('base64'), mimeType: IMAGE[ext] },
          ],
        };
      }

      if (TEXTUAL.has(ext)) {
        return text(`${header}\n\n${await fs.readFile(abs, 'utf8')}`);
      }

      return text(`${header}\n\nBinary ${ext || 'file'} with no inline representation. Its path is above.`);
    },
  },
];

module.exports = { tools };
