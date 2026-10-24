'use strict';

const { notFound, pickVault, resolveTarget, schema, targetProperties, text } = require('./common');

function cap(rows, limit) {
  return { rows: rows.slice(0, limit), hidden: Math.max(0, rows.length - limit) };
}

const tools = [
  {
    name: 'get-backlinks',
    description:
      'Which notes link to this one, in both [[wikilink]] and [markdown](link.md) form. This is the graph ' +
      'view of the vault - use it to find the context a note sits in before editing or moving it.',
    inputSchema: schema(
      {
        ...targetProperties,
        includeEmbeds: { type: 'boolean', description: 'Count ![[embeds]] as backlinks. Default true.' },
        limit: { type: 'number', description: 'Maximum linking notes to list. Default 100.' },
      },
      []
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel } = resolveTarget(vault, args);
      await vault.index();
      if (!vault.files.has(rel)) throw notFound(`No such note: ${rel}`);

      let links = vault.backlinks().get(rel) || [];
      if (args.includeEmbeds === false) links = links.filter((l) => !l.embed);

      const byNote = new Map();
      for (const link of links) {
        if (!byNote.has(link.rel)) byNote.set(link.rel, []);
        byNote.get(link.rel).push(link);
      }

      const { rows, hidden } = cap([...byNote.entries()].sort((a, b) => a[0].localeCompare(b[0])), args.limit || 100);
      if (rows.length === 0) return text(`Nothing links to ${rel}.`);

      const lines = [`${byNote.size} note${byNote.size === 1 ? '' : 's'} link to ${rel}:`, ''];
      for (const [noteRel, hits] of rows) {
        lines.push(`  ${noteRel}`);
        for (const hit of hits) lines.push(`      ${hit.embed ? 'embed' : 'link '}  ${hit.raw}`);
      }
      if (hidden) lines.push('', `[${hidden} more; raise "limit" to see them]`);
      return text(lines.join('\n'));
    },
  },

  {
    name: 'get-outgoing-links',
    description:
      'Every link a note points at, with whether it resolves to a real file. Reading this before read-note ' +
      'tells you what else is worth opening.',
    inputSchema: schema({ ...targetProperties }, []),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel } = resolveTarget(vault, args);
      await vault.index();
      const note = vault.notes.get(rel);
      if (!note) throw notFound(`No such note in the index: ${rel}. Only markdown notes have links.`);

      if (note.links.length === 0) return text(`${rel} links to nothing.`);
      const lines = [`${rel} has ${note.links.length} link${note.links.length === 1 ? '' : 's'}:`, ''];
      let broken = 0;
      for (const link of note.links) {
        const target = vault.resolveLink(link.target, rel);
        if (!target) broken += 1;
        const fragment = link.fragment ? `#${link.fragment}` : '';
        lines.push(`  ${link.embed ? 'embed' : 'link '}  ${link.target}${fragment}  ->  ${target || 'BROKEN (no such note)'}`);
      }
      if (broken) lines.push('', `${broken} of them are broken.`);
      return text(lines.join('\n'));
    },
  },

  {
    name: 'find-broken-links',
    description:
      'Links across the vault that point at a note which does not exist. Typically the fallout of a rename done ' +
      'outside this server, or a note deleted with its links left behind.',
    inputSchema: schema(
      {
        folder: { type: 'string', description: 'Only check notes under this folder.' },
        limit: { type: 'number', description: 'Maximum broken links to list. Default 100.' },
      },
      []
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      await vault.index();
      const prefix = args.folder ? `${args.folder.replace(/\/+$/, '')}/` : null;

      const broken = [];
      for (const note of vault.notes.values()) {
        if (prefix && !note.rel.startsWith(prefix)) continue;
        for (const link of note.links) {
          if (!vault.resolveLink(link.target, note.rel)) broken.push({ from: note.rel, target: link.target, raw: link.raw });
        }
      }

      if (broken.length === 0) return text(`No broken links${prefix ? ` under ${args.folder}` : ''} in ${vault.name}.`);
      const { rows, hidden } = cap(broken.sort((a, b) => a.from.localeCompare(b.from)), args.limit || 100);
      const lines = [`${broken.length} broken link${broken.length === 1 ? '' : 's'}:`, ''];
      for (const row of rows) lines.push(`  ${row.from}\n      ${row.raw}`);
      if (hidden) lines.push('', `[${hidden} more; raise "limit" to see them]`);
      return text(lines.join('\n'));
    },
  },

  {
    name: 'find-orphaned-notes',
    description:
      'Notes nothing links to. Useful for finding what fell out of the vault\'s structure, though a note being ' +
      'orphaned is not by itself a problem - inbox and daily notes are orphans by design.',
    inputSchema: schema(
      {
        folder: { type: 'string', description: 'Only consider notes under this folder.' },
        includeUnlinking: { type: 'boolean', description: 'Also require the note to link out to nothing. Default false.' },
        limit: { type: 'number', description: 'Maximum notes to list. Default 100.' },
      },
      []
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      await vault.index();
      const backlinks = vault.backlinks();
      const prefix = args.folder ? `${args.folder.replace(/\/+$/, '')}/` : null;

      const orphans = [...vault.notes.values()]
        .filter((n) => !prefix || n.rel.startsWith(prefix))
        .filter((n) => !(backlinks.get(n.rel) || []).length)
        .filter((n) => (args.includeUnlinking ? n.links.length === 0 : true))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      if (orphans.length === 0) return text(`No orphaned notes${prefix ? ` under ${args.folder}` : ''}.`);
      const { rows, hidden } = cap(orphans, args.limit || 100);
      const lines = [`${orphans.length} note${orphans.length === 1 ? '' : 's'} nothing links to, newest first:`, ''];
      for (const note of rows) lines.push(`  ${note.rel}`);
      if (hidden) lines.push('', `[${hidden} more; raise "limit" to see them]`);
      return text(lines.join('\n'));
    },
  },
];

module.exports = { tools };
