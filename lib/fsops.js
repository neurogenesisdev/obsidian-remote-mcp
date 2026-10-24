'use strict';

// Filesystem side effects: writes, trash, and keeping links pointing at the
// right note after a move.

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const md = require('./markdown');
const { basenameNoExt, parentDir } = require('./paths');

async function readText(abs) {
  return fs.readFile(abs, 'utf8');
}

async function exists(abs) {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(abs) {
  await fs.mkdir(abs, { recursive: true });
}

// Written to a sibling temp file and renamed, so a crash or a sync client
// reading mid-write never sees a half-truncated note. The temp name is hidden
// so the vault walk and Obsidian's own indexer skip it.
async function writeText(abs, content) {
  await ensureDir(path.dirname(abs));
  const tmp = path.join(path.dirname(abs), `.tmp-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Obsidian's own trash, so anything deleted here shows up under "Deleted files"
// in the app rather than being gone. The folder structure is preserved and a
// name collision gets a timestamp rather than overwriting an older deletion.
async function moveToTrash(vault, rel) {
  const target = path.join(vault.path, '.trash', rel);
  await ensureDir(path.dirname(target));
  let dest = target;
  if (await exists(dest)) {
    const ext = path.extname(rel);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    dest = path.join(path.dirname(target), `${path.basename(rel, ext)} ${stamp}${ext}`);
  }
  await fs.rename(path.join(vault.path, rel), dest);
  return path.posix.join('.trash', path.relative(path.join(vault.path, '.trash'), dest));
}

// Replaces byte ranges from the end so earlier indices stay valid.
function spliceAll(text, edits) {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  }
  return out;
}

// Obsidian's default link style is "shortest path when possible": a bare
// basename while it is unique, the full path once it is not. Rewriting a link
// to the full path when the short form still works would churn every note.
function shortestLinkForm(vault, rel) {
  const base = basenameNoExt(rel);
  const clashes = [...vault.files.keys()].filter((f) => basenameNoExt(f).toLowerCase() === base.toLowerCase());
  if (clashes.length <= 1) return base;
  return rel.replace(/\.md$/i, '');
}

// Called after the files have already moved, with a vault index that still
// describes the old layout - which is exactly what is needed to find the notes
// that pointed at the old paths. Takes a list so moving a folder rewrites every
// affected note once instead of once per file inside it.
async function updateLinksAfterMoves(vault, moves) {
  const renamed = new Map(moves.map((m) => [m.from, m.to]));
  const backlinks = vault.backlinks();

  const notes = new Set();
  for (const from of renamed.keys()) {
    for (const back of backlinks.get(from) || []) notes.add(back.rel);
  }
  if (notes.size === 0) return { linking: 0, changed: 0 };

  // The index predates the move, so decide the short form against the vault as
  // it will be: sources gone, destinations present.
  const projected = new Set(vault.files.keys());
  for (const { from, to } of moves) {
    projected.delete(from);
    projected.add(to);
  }
  const baseCount = new Map();
  for (const file of projected) {
    const base = basenameNoExt(file).toLowerCase();
    baseCount.set(base, (baseCount.get(base) || 0) + 1);
  }
  const wikiTargetFor = (to) =>
    (baseCount.get(basenameNoExt(to).toLowerCase()) || 0) <= 1 ? basenameNoExt(to) : to.replace(/\.md$/i, '');

  let changed = 0;
  for (const noteRel of notes) {
    // A note inside a moved folder has itself moved; read and write it where it
    // is now, but resolve its links against where it was.
    const abs = path.join(vault.path, renamed.get(noteRel) || noteRel);
    let content;
    try {
      content = await readText(abs);
    } catch {
      continue;
    }
    const { body, offset } = md.splitFrontmatter(content);
    const edits = [];

    for (const link of md.parseLinks(body)) {
      const resolved = vault.resolveLink(link.target, noteRel);
      const to = resolved && renamed.get(resolved);
      if (!to) continue;
      const fragment = link.fragment ? `#${link.fragment}` : '';
      let replacement;
      if (link.type === 'wikilink') {
        const alias = link.alias ? `|${link.alias}` : '';
        replacement = `${link.embed ? '!' : ''}[[${wikiTargetFor(to)}${fragment}${alias}]]`;
      } else {
        const href = encodeURI(to).replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'));
        replacement = `${link.embed ? '!' : ''}[${link.alias || ''}](${href}${fragment})`;
      }
      if (replacement !== link.raw) {
        edits.push({ start: link.index, end: link.index + link.raw.length, replacement });
      }
    }

    if (!edits.length) continue;
    await writeText(abs, content.slice(0, offset) + spliceAll(body, edits));
    changed += 1;
  }

  return { linking: notes.size, changed };
}

// A bare [[Note]] keeps resolving after the note moves, so a move often needs
// no rewriting at all. Saying which happened is more useful than a count that
// reads as a failure.
function describeLinkUpdate({ linking, changed }) {
  if (linking === 0) return 'Nothing linked to it.';
  if (changed === 0) {
    return `${linking} note${linking === 1 ? '' : 's'} link to it; every link still resolves, so none needed rewriting.`;
  }
  const rest = linking - changed;
  return (
    `Rewrote links in ${changed} of ${linking} linking note${linking === 1 ? '' : 's'}` +
    `${rest ? `; the other ${rest} still resolved as written` : ''}.`
  );
}

function updateLinksAfterMove(vault, fromRel, toRel) {
  return updateLinksAfterMoves(vault, [{ from: fromRel, to: toRel }]);
}

module.exports = {
  describeLinkUpdate,
  ensureDir,
  exists,
  moveToTrash,
  readText,
  shortestLinkForm,
  spliceAll,
  updateLinksAfterMove,
  updateLinksAfterMoves,
  writeText,
  parentDir,
};
