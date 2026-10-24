'use strict';

const fs = require('fs').promises;
const path = require('path');
const ops = require('../fsops');
const { invalid, notFound, pickVault, resolveRaw, schema, text } = require('./common');

async function isDir(abs) {
  try {
    return (await fs.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

const tools = [
  {
    name: 'create-directory',
    description: 'Create a folder in the vault. Parent folders are created too unless recursive is turned off.',
    inputSchema: schema(
      {
        path: { type: 'string', description: 'Folder path relative to the vault root, e.g. "projects/2026".' },
        recursive: { type: 'boolean', description: 'Create missing parents. Default true.' },
      },
      ['path']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel, abs } = resolveRaw(vault, args.path, { write: true });
      if (await isDir(abs)) return text(`${rel} already exists.`);
      await fs.mkdir(abs, { recursive: args.recursive !== false });
      vault.invalidate();
      return text(`Created folder ${rel}.`);
    },
  },

  {
    name: 'move-directory',
    description:
      'Move or rename a folder with everything inside it, rewriting links to every note that moved. ' +
      'Prefer this over moving notes one at a time, which rewrites the same linking notes repeatedly.',
    inputSchema: schema(
      {
        source: { type: 'string', description: 'Current folder path relative to the vault root.' },
        destination: { type: 'string', description: 'New folder path relative to the vault root.' },
      },
      ['source', 'destination']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const from = resolveRaw(vault, args.source, { write: true });
      const to = resolveRaw(vault, args.destination, { write: true });
      if (!(await isDir(from.abs))) throw notFound(`No such folder: ${from.rel}`);
      if (await ops.exists(to.abs)) throw invalid(`${to.rel} already exists.`);
      if (to.rel === from.rel || to.rel.startsWith(`${from.rel}/`)) {
        throw invalid('A folder cannot be moved inside itself.');
      }

      await vault.index();
      const moves = [...vault.files.keys()]
        .filter((f) => f === from.rel || f.startsWith(`${from.rel}/`))
        .map((f) => ({ from: f, to: `${to.rel}${f.slice(from.rel.length)}` }));

      await ops.ensureDir(path.dirname(to.abs));
      await fs.rename(from.abs, to.abs);
      const result = await ops.updateLinksAfterMoves(vault, moves);
      vault.invalidate();
      return text(
        `Moved ${from.rel} to ${to.rel} (${moves.length} file${moves.length === 1 ? '' : 's'}). ` +
          ops.describeLinkUpdate(result)
      );
    },
  },

  {
    name: 'delete-directory',
    description:
      'Delete a folder and its contents, moving it to the vault\'s .trash by default so it stays recoverable. ' +
      'Links pointing into it are left alone and will show as broken - run find-broken-links afterwards.',
    inputSchema: schema(
      {
        path: { type: 'string', description: 'Folder path relative to the vault root.' },
        permanent: { type: 'boolean', description: 'Delete outright instead of moving to .trash. Default false.' },
      },
      ['path']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel, abs } = resolveRaw(vault, args.path, { write: true });
      if (!(await isDir(abs))) throw notFound(`No such folder: ${rel}`);

      if (args.permanent) {
        await fs.rm(abs, { recursive: true, force: true });
        vault.invalidate();
        return text(`Permanently deleted ${rel} and everything in it.`);
      }
      const trashed = await ops.moveToTrash(vault, rel);
      vault.invalidate();
      return text(`Moved ${rel} to ${trashed}.`);
    },
  },
];

module.exports = { tools };
