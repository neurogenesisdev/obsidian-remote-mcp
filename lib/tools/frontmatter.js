'use strict';

const md = require('../markdown');
const ops = require('../fsops');
const { invalid, notFound, pickVault, resolveTarget, schema, targetProperties, text } = require('./common');

const tools = [
  {
    name: 'update-frontmatter',
    description:
      'Change a note\'s YAML frontmatter (Obsidian properties) without touching the body. Keys in "set" are ' +
      'written, keys in "remove" are deleted, everything else is left as it was - including comments and key order.\n\n' +
      'Example: { "path": "note.md", "set": { "status": "done", "reviewed": "2026-08-20" }, "remove": ["draft"] }',
    inputSchema: schema(
      {
        ...targetProperties,
        set: { type: 'object', description: 'Properties to write. Values may be strings, numbers, booleans, arrays or objects.' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Property names to delete.' },
        replace: { type: 'boolean', description: 'Discard the existing frontmatter and write only "set". Default false.' },
      },
      []
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel, abs } = resolveTarget(vault, args, { write: true });
      if (!(await ops.exists(abs))) throw notFound(`No such note: ${rel}`);

      const set = args.set && typeof args.set === 'object' && !Array.isArray(args.set) ? args.set : null;
      const remove = Array.isArray(args.remove) ? args.remove : [];
      if (!set && remove.length === 0 && !args.replace) {
        throw invalid('Nothing to do: pass "set", "remove", or "replace" with "set".');
      }

      const before = await ops.readText(abs);
      const current = md.splitFrontmatter(before);
      if (current.present && current.frontmatter === null) {
        throw invalid(`${rel} has frontmatter that is not valid YAML. Fix it by hand before editing properties through this tool.`);
      }

      const after = md.setFrontmatter(before, (doc) => {
        if (args.replace) doc.contents = doc.createNode({});
        for (const key of remove) doc.delete(key);
        for (const [key, value] of Object.entries(set || {})) doc.set(key, value);
      });

      if (after === before) return text(`No change to ${rel}.`);
      await ops.writeText(abs, after);
      vault.invalidate();

      const wrote = Object.keys(set || {});
      const parts = [];
      if (wrote.length) parts.push(`set ${wrote.join(', ')}`);
      if (remove.length) parts.push(`removed ${remove.join(', ')}`);
      return text(`Updated frontmatter of ${rel}: ${parts.join('; ') || 'replaced'}.`);
    },
  },
];

module.exports = { tools };
