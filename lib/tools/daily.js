'use strict';

const daily = require('../daily');
const ops = require('../fsops');
const { findSection } = require('./notes');
const md = require('../markdown');
const { invalid, notFound, pickVault, resolveRaw, schema, text } = require('./common');

const DATE_HELP =
  'ISO date like "2026-08-20", or "today", "yesterday", "tomorrow", or a day offset like "-3". Default today.';

function resolveDaily(vault, dateInput) {
  try {
    return daily.dailyNotePath(vault, dateInput);
  } catch (err) {
    throw invalid(err.message);
  }
}

const tools = [
  {
    name: 'get-daily-note',
    description:
      'Read the daily note for a date. The folder and filename format come from the vault\'s own daily-notes ' +
      'settings, so the note lands where Obsidian expects it rather than somewhere this server invented.',
    inputSchema: schema(
      {
        date: { type: 'string', description: DATE_HELP },
        create: { type: 'boolean', description: 'Create the note if it does not exist. Default false.' },
      },
      []
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel, config } = await resolveDaily(vault, args.date);
      const { abs } = resolveRaw(vault, rel, { write: !!args.create });

      if (!(await ops.exists(abs))) {
        if (!args.create) {
          throw notFound(
            `No daily note at ${rel}. The vault formats them as "${config.format}"` +
              `${config.folder ? ` in ${config.folder}/` : ' in the vault root'}. Pass "create": true to make it.`
          );
        }
        await ops.writeText(abs, '');
        vault.invalidate();
        return text(`Created empty daily note ${rel}.`);
      }

      return text(`${rel}\n\n${await ops.readText(abs)}`);
    },
  },

  {
    name: 'append-to-daily-note',
    description:
      'Append to the daily note, creating it if it is not there yet. Give a heading to append inside that ' +
      'section instead of at the end of the note; the heading is created if missing.',
    inputSchema: schema(
      {
        content: { type: 'string', description: 'Markdown to add.' },
        date: { type: 'string', description: DATE_HELP },
        heading: { type: 'string', description: 'Append under this heading rather than at the end of the note.' },
        headingLevel: { type: 'number', description: 'Level to use if the heading has to be created. Default 2.' },
      },
      ['content']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      if (typeof args.content !== 'string' || !args.content) throw invalid('"content" is required.');
      const { rel } = await resolveDaily(vault, args.date);
      const { abs } = resolveRaw(vault, rel, { write: true });

      const existed = await ops.exists(abs);
      const before = existed ? await ops.readText(abs) : '';
      let after;

      if (!args.heading) {
        after = before.replace(/\n*$/, before.trim() ? '\n\n' : '') + args.content.replace(/\n*$/, '\n');
      } else {
        const hasHeading = md
          .parseHeadings(before)
          .some((h) => h.text.trim().toLowerCase() === args.heading.trim().toLowerCase());

        if (!hasHeading) {
          const marker = '#'.repeat(Math.min(6, Math.max(1, args.headingLevel || 2)));
          after =
            before.replace(/\n*$/, before.trim() ? '\n\n' : '') +
            `${marker} ${args.heading}\n\n${args.content.replace(/\n*$/, '\n')}`;
        } else {
          const { body, offset } = md.splitFrontmatter(before);
          const { heading, endBodyLine } = findSection(before, { heading: args.heading });
          const lines = body.split('\n');
          let insert = endBodyLine === null ? lines.length : endBodyLine;
          while (insert > heading.bodyLine + 1 && lines[insert - 1].trim() === '') insert -= 1;
          after =
            before.slice(0, offset) +
            [...lines.slice(0, insert), ...args.content.split('\n'), ...lines.slice(insert)].join('\n');
        }
      }

      await ops.writeText(abs, after);
      vault.invalidate();
      const where = args.heading ? ` under "${args.heading}"` : '';
      return text(`${existed ? 'Appended to' : 'Created'} ${rel}${where}.`);
    },
  },
];

module.exports = { tools };
