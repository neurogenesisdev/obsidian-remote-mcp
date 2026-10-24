'use strict';

const path = require('path');
const ops = require('../fsops');
const { invalid, pickVault, schema, text } = require('./common');

const MAX_FILES_READ = 20000;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Frontmatter filters accept a scalar for equality, true for "the key exists",
// and an array for "any of these". Comparison is loose on purpose: a YAML date
// reads back as a Date and a status reads back as a string, and the caller
// should not have to know which.
function frontmatterMatches(note, filter) {
  for (const [key, expected] of Object.entries(filter)) {
    const actual = note.frontmatter[key];
    if (expected === true) {
      if (actual === undefined || actual === null) return false;
      continue;
    }
    if (expected === false) {
      if (actual !== undefined && actual !== null) return false;
      continue;
    }
    const wanted = Array.isArray(expected) ? expected : [expected];
    const have = Array.isArray(actual) ? actual : [actual];
    const hit = wanted.some((w) => have.some((h) => String(h).toLowerCase() === String(w).toLowerCase()));
    if (!hit) return false;
  }
  return true;
}

function inHierarchy(tag, root) {
  const a = String(tag).toLowerCase();
  const b = String(root).replace(/^#/, '').toLowerCase();
  return a === b || a.startsWith(`${b}/`);
}

const tools = [
  {
    name: 'search-vault',
    description:
      'Search the vault by content, filename, tag, frontmatter property or modification date, in any combination. ' +
      'Filters narrow the candidate set before any file is read, so a tag or folder filter makes a content search ' +
      'much cheaper on a large vault.\n\n' +
      'Examples:\n' +
      '- { "query": "quarterly review" }\n' +
      '- { "query": "deadline", "folder": "Projects", "tags": ["status/active"] }\n' +
      '- { "tags": ["meeting"], "modifiedAfter": "2026-08-01" }  (filters only, no text query)\n' +
      '- { "query": "TODO\\\\(\\\\w+\\\\)", "regex": true }\n' +
      '- { "frontmatter": { "status": "draft" } }',
    inputSchema: schema(
      {
        query: { type: 'string', description: 'Text to look for. Optional when you are filtering by tag, folder, property or date.' },
        searchType: { type: 'string', enum: ['content', 'filename', 'both'], description: 'Where to match "query". Default both.' },
        regex: { type: 'boolean', description: 'Treat "query" as a JavaScript regular expression. Default false.' },
        caseSensitive: { type: 'boolean', description: 'Default false.' },
        folder: { type: 'string', description: 'Only search under this folder, relative to the vault root.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Only notes carrying all of these tags. Parent tags match their children.' },
        frontmatter: { type: 'object', description: 'Property filters: a value to match, true for "key is present", or an array for any-of.' },
        modifiedAfter: { type: 'string', description: 'ISO date, e.g. "2026-08-01". Only notes modified on or after it.' },
        modifiedBefore: { type: 'string', description: 'ISO date. Only notes modified before it.' },
        limit: { type: 'number', description: 'Maximum notes to return. Default 50.' },
        contextLines: { type: 'number', description: 'Lines of context around each content match. Default 0.' },
        maxMatchesPerNote: { type: 'number', description: 'Default 5.' },
      },
      []
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      await vault.index();

      let query = args.query ? String(args.query) : '';
      let searchType = args.searchType || 'both';
      const tagFilters = [...(args.tags || [])];

      // Upstream accepted "tag:foo" inside the query string; keep that working
      // rather than silently searching for the literal text.
      const tagPrefix = /^tag:\s*(\S+)$/i.exec(query);
      if (tagPrefix) {
        tagFilters.push(tagPrefix[1]);
        query = '';
      }

      if (!query && tagFilters.length === 0 && !args.frontmatter && !args.folder && !args.modifiedAfter && !args.modifiedBefore) {
        throw invalid('Give a "query", or at least one filter: tags, frontmatter, folder, modifiedAfter or modifiedBefore.');
      }

      const prefix = args.folder ? `${String(args.folder).replace(/^\/+|\/+$/g, '')}/` : null;
      const after = args.modifiedAfter ? Date.parse(args.modifiedAfter) : null;
      const before = args.modifiedBefore ? Date.parse(args.modifiedBefore) : null;
      if (args.modifiedAfter && Number.isNaN(after)) throw invalid(`"modifiedAfter" is not a date: ${args.modifiedAfter}`);
      if (args.modifiedBefore && Number.isNaN(before)) throw invalid(`"modifiedBefore" is not a date: ${args.modifiedBefore}`);

      let candidates = [...vault.notes.values()];
      if (prefix) candidates = candidates.filter((n) => n.rel.startsWith(prefix));
      if (after !== null) candidates = candidates.filter((n) => n.mtimeMs >= after);
      if (before !== null) candidates = candidates.filter((n) => n.mtimeMs < before);
      for (const tag of tagFilters) candidates = candidates.filter((n) => n.tags.some((t) => inHierarchy(t, tag)));
      if (args.frontmatter && typeof args.frontmatter === 'object') {
        candidates = candidates.filter((n) => frontmatterMatches(n, args.frontmatter));
      }

      const limit = args.limit || 50;
      const results = [];
      let stoppedEarly = false;

      if (!query) {
        for (const note of candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
          results.push({ note, matches: [] });
        }
      } else {
        let pattern;
        try {
          pattern = new RegExp(args.regex ? query : escapeRegex(query), args.caseSensitive ? 'g' : 'gi');
        } catch (err) {
          throw invalid(`Invalid regular expression: ${err.message}`);
        }

        const byName = searchType === 'filename' || searchType === 'both';
        const byContent = searchType === 'content' || searchType === 'both';
        const context = args.contextLines || 0;
        const perNote = args.maxMatchesPerNote || 5;
        let read = 0;

        for (const note of candidates) {
          pattern.lastIndex = 0;
          const nameHit = byName && pattern.test(note.rel);
          let matches = [];

          if (byContent && read < MAX_FILES_READ) {
            read += 1;
            let content;
            try {
              content = await ops.readText(path.join(vault.path, note.rel));
            } catch {
              content = '';
            }
            const lines = content.split('\n');
            for (let i = 0; i < lines.length && matches.length < perNote; i += 1) {
              pattern.lastIndex = 0;
              if (!pattern.test(lines[i])) continue;
              matches.push({
                line: i + 1,
                text: lines.slice(Math.max(0, i - context), i + context + 1).join('\n'),
              });
            }
          }

          if (nameHit || matches.length) results.push({ note, matches, nameHit });
          // Enough to rank a page of results from. Reported as a floor rather
          // than a count, because the rest of the vault went unread.
          if (results.length >= limit * 3) {
            stoppedEarly = true;
            break;
          }
        }

        results.sort((a, b) => (b.nameHit ? 1 : 0) - (a.nameHit ? 1 : 0) || b.matches.length - a.matches.length || b.note.mtimeMs - a.note.mtimeMs);
      }

      const total = results.length;
      const shown = results.slice(0, limit);
      if (total === 0) return text('No matches.');

      const count = `${stoppedEarly ? 'at least ' : ''}${total} matching note${total === 1 ? '' : 's'}`;
      const lines = [`${count}${total > shown.length ? `, showing ${shown.length}` : ''}:`, ''];
      for (const { note, matches, nameHit } of shown) {
        lines.push(`${note.rel}${nameHit && !matches.length ? '   [filename match]' : ''}`);
        for (const match of matches) {
          lines.push(...match.text.split('\n').map((l, i) => `  ${String(match.line + i).padStart(5)}  ${l.trim()}`));
        }
        if (matches.length) lines.push('');
      }
      if (total > shown.length) lines.push(`[${total - shown.length} more; raise "limit" or narrow the filters]`);
      return text(lines.join('\n').trimEnd());
    },
  },
];

module.exports = { tools };
