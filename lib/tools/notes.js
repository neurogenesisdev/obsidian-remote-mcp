'use strict';

const path = require('path');
const fs = require('fs').promises;
const { McpError } = require('@modelcontextprotocol/sdk/types.js');
const md = require('../markdown');
const ops = require('../fsops');
const policy = require('../policy');
const {
  bytes, invalid, notFound, pickVault, resolveTarget, schema, targetProperties, text, when,
} = require('./common');

const TARGET_HINT = 'Give either "path", or "filename" with an optional "folder".';

async function mustExist(abs, rel) {
  if (!(await ops.exists(abs))) throw notFound(`No such note: ${rel}`);
}

// What a path names on disk, without following a link, so a broken link still
// counts as present and can be removed.
async function entryKind(abs) {
  try {
    const stat = await fs.lstat(abs);
    if (stat.isSymbolicLink()) return 'link';
    return stat.isDirectory() ? 'folder' : 'file';
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Folders have their own tools, which a policy may switch off. A note tool must
// not stand in for them when a folder's name happens to look like a file's.
function folderRefusal(rel, tool, verb) {
  return invalid(
    policy.isToolDisabled(tool)
      ? `${rel} is a folder, and folders cannot be ${verb} through this server.`
      : `${rel} is a folder. Use ${tool} for folders.`
  );
}

// Shared by delete-note and edit-note's delete. A link is removed outright: it
// holds no content of its own, and in .trash its target would stop resolving.
async function removeEntry(vault, rel, abs, permanent) {
  const kind = await entryKind(abs);
  if (!kind) throw notFound(`No such note: ${rel}`);
  if (kind === 'folder') throw folderRefusal(rel, 'delete-directory', 'deleted');
  if (kind === 'link') {
    await fs.unlink(abs);
    vault.invalidate();
    return text(`Removed the link ${rel}. The file it pointed at is unchanged.`);
  }
  if (permanent) {
    await fs.unlink(abs);
    vault.invalidate();
    return text(`Permanently deleted ${rel}.`);
  }
  const trashed = await ops.moveToTrash(vault, rel);
  vault.invalidate();
  return text(`Moved ${rel} to ${trashed}.`);
}

function headerFor(rel, stat) {
  return `${rel}  (${bytes(stat.size)}, modified ${when(stat.mtimeMs)})`;
}

// Section boundaries for patch-note: a heading owns everything up to the next
// heading at the same level or shallower.
function findSection(content, { heading, level, occurrence }) {
  const headings = md.parseHeadings(content);
  const wanted = String(heading).replace(/^#+\s*/, '').trim().toLowerCase();
  const matches = headings.filter(
    (h) => h.text.trim().toLowerCase() === wanted && (level === undefined || h.level === level)
  );

  if (matches.length === 0) {
    const available = headings.length
      ? headings.map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n  ')
      : '(the note has no headings)';
    throw notFound(`No heading "${heading}" in this note. Headings present:\n  ${available}`);
  }
  if (matches.length > 1 && occurrence === undefined) {
    throw invalid(
      `"${heading}" appears ${matches.length} times (lines ${matches.map((m) => m.line).join(', ')}). ` +
        'Pass "occurrence" (1-based) or "level" to pick one.'
    );
  }

  const target = matches[(occurrence || 1) - 1];
  if (!target) throw invalid(`occurrence ${occurrence} is out of range, "${heading}" appears ${matches.length} times.`);

  const next = headings.find((h) => h.bodyLine > target.bodyLine && h.level <= target.level);
  return { heading: target, endBodyLine: next ? next.bodyLine : null };
}

const tools = [
  {
    name: 'create-note',
    description:
      'Create a new markdown note. Fails if the note already exists unless overwrite is set. ' +
      'Frontmatter can be supplied as an object instead of hand-writing the YAML block.\n\n' +
      'Examples:\n' +
      '- { "path": "journal/2026/note.md", "content": "# Title\\n\\ntext" }\n' +
      '- { "path": "idea.md", "content": "text", "frontmatter": { "tags": ["idea"], "status": "draft" } }',
    inputSchema: schema(
      {
        ...targetProperties,
        content: { type: 'string', description: 'Markdown body of the note. Defaults to empty.' },
        frontmatter: { type: 'object', description: 'YAML frontmatter as key/value pairs, written above the body.' },
        overwrite: { type: 'boolean', description: 'Replace the note if it already exists. Default false.' },
      },
      []
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel, abs } = resolveTarget(vault, args, { write: true });
      if (!args.path && !args.filename) throw invalid(TARGET_HINT);

      if ((await ops.exists(abs)) && !args.overwrite) {
        throw invalid(`${rel} already exists. Pass "overwrite": true to replace it, or use edit-note to change it.`);
      }

      let content = args.content || '';
      if (args.frontmatter && Object.keys(args.frontmatter).length) {
        content = md.setFrontmatter(content, (doc) => {
          for (const [key, value] of Object.entries(args.frontmatter)) doc.set(key, value);
        });
      }

      await ops.writeText(abs, content);
      vault.invalidate();
      return text(`Created ${rel} (${bytes(Buffer.byteLength(content))}).`);
    },
  },

  {
    name: 'read-note',
    description:
      'Read a note. Returns the raw markdown, so frontmatter comes back as written. ' +
      'Set withLineNumbers when you intend to follow up with a line-based edit.',
    inputSchema: schema(
      {
        ...targetProperties,
        withLineNumbers: { type: 'boolean', description: 'Prefix every line with its 1-based number. Default false.' },
        maxBytes: { type: 'number', description: 'Truncate above this size. Default 400000.' },
      },
      []
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel, abs } = resolveTarget(vault, args);
      await mustExist(abs, rel);

      const stat = await fs.stat(abs);
      const limit = args.maxBytes || 400000;
      let content = await ops.readText(abs);
      let truncated = '';
      if (Buffer.byteLength(content) > limit) {
        content = Buffer.from(content).subarray(0, limit).toString('utf8');
        truncated = `\n\n[truncated at ${bytes(limit)} of ${bytes(stat.size)}; raise maxBytes to read the rest]`;
      }
      if (args.withLineNumbers) {
        content = content.split('\n').map((line, i) => `${String(i + 1).padStart(5)}  ${line}`).join('\n');
      }
      return text(`${headerFor(rel, stat)}\n\n${content}${truncated}`);
    },
  },

  {
    name: 'read-notes',
    description:
      'Read several notes in one call. Missing notes are reported rather than failing the whole request. ' +
      'Use this instead of repeated read-note calls when gathering context.',
    inputSchema: schema(
      {
        paths: { type: 'array', items: { type: 'string' }, description: 'Vault-relative paths of the notes to read.' },
        maxBytesEach: { type: 'number', description: 'Truncate each note above this size. Default 100000.' },
      },
      ['paths']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      if (!Array.isArray(args.paths) || args.paths.length === 0) throw invalid('"paths" must be a non-empty array.');
      const limit = args.maxBytesEach || 100000;
      const out = [];

      for (const raw of args.paths) {
        let rel = String(raw);
        try {
          const target = resolveTarget(vault, { path: raw });
          rel = target.rel;
          if (!(await ops.exists(target.abs))) {
            out.push(`===== ${rel} =====\n[not found]`);
            continue;
          }
          let content = await ops.readText(target.abs);
          if (Buffer.byteLength(content) > limit) {
            content = `${Buffer.from(content).subarray(0, limit).toString('utf8')}\n[truncated]`;
          }
          out.push(`===== ${rel} =====\n${content}`);
        } catch (err) {
          // One bad path should not cost the caller the rest of the batch. Only
          // this server's own messages go back: a raw fs error names absolute paths.
          const reason = err instanceof McpError ? err.message.replace(/^MCP error -?\d+:\s*/, '') : 'could not be read';
          out.push(`===== ${rel} =====\n[${reason}]`);
        }
      }
      return text(out.join('\n\n'));
    },
  },

  {
    name: 'edit-note',
    description:
      'Edit a whole note: append or prepend content, replace the entire body, or delete it.\n\n' +
      'For a change inside one section use patch-note, and for a targeted string swap use replace-in-note - ' +
      'both avoid resending the whole note.\n\n' +
      'Examples:\n' +
      '- { "path": "note.md", "operation": "append", "content": "\\n- another item" }\n' +
      '- { "path": "note.md", "operation": "replace", "content": "new body" }',
    inputSchema: schema(
      {
        ...targetProperties,
        operation: {
          type: 'string',
          enum: ['append', 'prepend', 'replace', 'delete'],
          description: 'append adds to the end, prepend to the start, replace overwrites the body, delete removes the note.',
        },
        content: { type: 'string', description: 'Required for every operation except delete.' },
      },
      ['operation']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const operation = args.operation;
      const { rel, abs } = resolveTarget(vault, args, { write: true, entry: operation === 'delete' });

      if (operation === 'delete') return removeEntry(vault, rel, abs, false);
      if (typeof args.content !== 'string') {
        throw invalid(`"content" is required for the ${operation} operation.`);
      }
      await mustExist(abs, rel);

      const before = await ops.readText(abs);
      let after;
      if (operation === 'append') after = before + (before.endsWith('\n') || !before ? '' : '\n') + args.content;
      else if (operation === 'prepend') after = args.content + (args.content.endsWith('\n') ? '' : '\n') + before;
      else after = args.content;

      await ops.writeText(abs, after);
      vault.invalidate();
      return text(`${operation === 'replace' ? 'Replaced' : `${operation}ed to`} ${rel} (now ${bytes(Buffer.byteLength(after))}).`);
    },
  },

  {
    name: 'patch-note',
    description:
      'Edit one section of a note, addressed by its heading. The section runs from the heading to the next ' +
      'heading of the same or a higher level.\n\n' +
      'Operations: append (end of the section), prepend (straight after the heading), replace (the section body, ' +
      'heading kept), remove (heading and body).\n\n' +
      'Example: { "path": "note.md", "heading": "Tasks", "operation": "append", "content": "- [ ] new task" }',
    inputSchema: schema(
      {
        ...targetProperties,
        heading: { type: 'string', description: 'Heading text without the leading #.' },
        level: { type: 'number', description: 'Only match headings at this level (1-6). Use when the same text appears at different levels.' },
        occurrence: { type: 'number', description: '1-based, when the same heading text appears more than once.' },
        operation: { type: 'string', enum: ['append', 'prepend', 'replace', 'remove'], description: 'What to do with the section.' },
        content: { type: 'string', description: 'Required for every operation except remove.' },
      },
      ['heading', 'operation']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel, abs } = resolveTarget(vault, args, { write: true });
      await mustExist(abs, rel);
      if (args.operation !== 'remove' && typeof args.content !== 'string') {
        throw invalid(`"content" is required for the ${args.operation} operation.`);
      }

      const content = await ops.readText(abs);
      const { body, offset } = md.splitFrontmatter(content);
      const { heading, endBodyLine } = findSection(content, args);
      const lines = body.split('\n');
      const end = endBodyLine === null ? lines.length : endBodyLine;
      const addition = args.content ? args.content.split('\n') : [];

      let next;
      if (args.operation === 'remove') {
        next = [...lines.slice(0, heading.bodyLine), ...lines.slice(end)];
      } else if (args.operation === 'prepend') {
        next = [...lines.slice(0, heading.bodyLine + 1), ...addition, ...lines.slice(heading.bodyLine + 1)];
      } else if (args.operation === 'replace') {
        next = [...lines.slice(0, heading.bodyLine + 1), ...addition, ...lines.slice(end)];
      } else {
        // Trailing blank lines belong to the gap before the next heading, not
        // to the section, so append lands after the last real line.
        let insert = end;
        while (insert > heading.bodyLine + 1 && lines[insert - 1].trim() === '') insert -= 1;
        next = [...lines.slice(0, insert), ...addition, ...lines.slice(insert)];
      }

      await ops.writeText(abs, content.slice(0, offset) + next.join('\n'));
      vault.invalidate();
      return text(`Patched "${heading.text}" in ${rel} (${args.operation}).`);
    },
  },

  {
    name: 'replace-in-note',
    description:
      'Find and replace text inside one note. Literal by default; set regex for a JavaScript regular expression, ' +
      'where $1 style backreferences work in the replacement.',
    inputSchema: schema(
      {
        ...targetProperties,
        find: { type: 'string', description: 'Text or pattern to look for.' },
        replace: { type: 'string', description: 'Replacement text. Use an empty string to delete.' },
        regex: { type: 'boolean', description: 'Treat "find" as a regular expression. Default false.' },
        all: { type: 'boolean', description: 'Replace every occurrence. Default true.' },
        caseSensitive: { type: 'boolean', description: 'Default true.' },
      },
      ['find', 'replace']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel, abs } = resolveTarget(vault, args, { write: true });
      await mustExist(abs, rel);

      const before = await ops.readText(abs);
      const flags = `${args.all === false ? '' : 'g'}${args.caseSensitive === false ? 'i' : ''}`;
      let pattern;
      try {
        pattern = new RegExp(args.regex ? args.find : args.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      } catch (err) {
        throw invalid(`Invalid regular expression: ${err.message}`);
      }

      const count = (before.match(new RegExp(pattern.source, `g${pattern.flags.includes('i') ? 'i' : ''}`)) || []).length;
      if (count === 0) return text(`No match for ${args.regex ? 'pattern' : '"' + args.find + '"'} in ${rel}. Nothing changed.`);

      const after = before.replace(pattern, args.regex ? args.replace : () => args.replace);
      await ops.writeText(abs, after);
      vault.invalidate();
      const applied = args.all === false ? 1 : count;
      return text(`Replaced ${applied} occurrence${applied === 1 ? '' : 's'} in ${rel}.`);
    },
  },

  {
    name: 'move-note',
    description:
      'Move or rename a note and rewrite every link that pointed at it, in both [[wikilink]] and ' +
      '[markdown](link.md) form. Works for any vault file, including .canvas.',
    inputSchema: schema(
      {
        source: { type: 'string', description: 'Current path relative to the vault root.' },
        destination: { type: 'string', description: 'New path relative to the vault root.' },
        overwrite: { type: 'boolean', description: 'Replace the destination if it exists. Default false.' },
      },
      ['source', 'destination']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const from = resolveTarget(vault, { path: args.source }, { write: true, entry: true });
      const to = resolveTarget(vault, { path: args.destination }, { write: true });
      const kind = await entryKind(from.abs);
      if (!kind) throw notFound(`No such note: ${from.rel}`);
      if (kind === 'folder') throw folderRefusal(from.rel, 'move-directory', 'moved');
      // A relative link would point somewhere else from its new folder.
      if (kind === 'link') throw invalid(`${from.rel} is a link, and links cannot be moved through this server.`);
      if (from.rel === to.rel) return text(`${from.rel} is already at that path.`);
      if ((await ops.exists(to.abs)) && !args.overwrite) {
        throw invalid(`${to.rel} already exists. Pass "overwrite": true to replace it.`);
      }

      // Indexed before the move so the backlink map still knows the old path.
      await vault.index();
      await ops.ensureDir(path.dirname(to.abs));
      await fs.rename(from.abs, to.abs);
      const result = await ops.updateLinksAfterMove(vault, from.rel, to.rel);
      vault.invalidate();
      return text(`Moved ${from.rel} to ${to.rel}. ${ops.describeLinkUpdate(result)}`);
    },
  },

  {
    name: 'copy-note',
    description: 'Copy a note to another path. Links inside the copy are left exactly as they were.',
    inputSchema: schema(
      {
        source: { type: 'string', description: 'Path to copy from, relative to the vault root.' },
        destination: { type: 'string', description: 'Path to copy to, relative to the vault root.' },
        overwrite: { type: 'boolean', description: 'Replace the destination if it exists. Default false.' },
      },
      ['source', 'destination']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const from = resolveTarget(vault, { path: args.source });
      const to = resolveTarget(vault, { path: args.destination }, { write: true });
      await mustExist(from.abs, from.rel);
      if ((await ops.exists(to.abs)) && !args.overwrite) {
        throw invalid(`${to.rel} already exists. Pass "overwrite": true to replace it.`);
      }
      await ops.ensureDir(path.dirname(to.abs));
      await fs.copyFile(from.abs, to.abs);
      vault.invalidate();
      return text(`Copied ${from.rel} to ${to.rel}.`);
    },
  },

  {
    name: 'delete-note',
    description:
      'Delete a note. Moves it to the vault\'s .trash by default, where Obsidian shows it under deleted files, ' +
      'so the deletion stays recoverable. Works for any vault file, including .canvas.',
    inputSchema: schema(
      {
        ...targetProperties,
        permanent: { type: 'boolean', description: 'Delete outright instead of moving to .trash. Default false.' },
      },
      []
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel, abs } = resolveTarget(vault, args, { write: true, entry: true });
      return removeEntry(vault, rel, abs, !!args.permanent);
    },
  },

  {
    name: 'get-note-outline',
    description:
      'List a note\'s headings with their levels and line numbers. Cheaper than reading a long note when you only ' +
      'need to know its structure, and it gives you the exact heading text patch-note expects.',
    inputSchema: schema({ ...targetProperties }, []),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel, abs } = resolveTarget(vault, args);
      await mustExist(abs, rel);

      const content = await ops.readText(abs);
      const headings = md.parseHeadings(content);
      const { frontmatter } = md.splitFrontmatter(content);
      const lines = [`${rel}  (${md.wordCount(content)} words, ${content.split('\n').length} lines)`];
      if (frontmatter && Object.keys(frontmatter).length) {
        lines.push(`Frontmatter keys: ${Object.keys(frontmatter).join(', ')}`);
      }
      lines.push('');
      if (headings.length === 0) lines.push('(no headings)');
      for (const h of headings) {
        lines.push(`${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text}   [line ${h.line}]`);
      }
      return text(lines.join('\n'));
    },
  },
];

// findSection is shared with append-to-daily-note, which appends under a
// heading the same way patch-note does.
module.exports = { tools, findSection };
