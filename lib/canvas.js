'use strict';

// JSON Canvas (jsoncanvas.org), the open format behind Obsidian's .canvas files.
//
// Obsidian writes fields the spec does not define - styleAttributes on every
// node and edge, a top-level metadata object - and drops a canvas it cannot
// parse. Every read/modify/write here therefore keeps unknown keys instead of
// rebuilding objects from the fields this code happens to know about.

const crypto = require('crypto');

const NODE_TYPES = new Set(['text', 'file', 'link', 'group']);
const SIDES = new Set(['top', 'right', 'bottom', 'left']);
const ENDS = new Set(['none', 'arrow']);
const COLORS = new Set(['1', '2', '3', '4', '5', '6']); // preset red..purple; hex also allowed

const DEFAULT_SIZE = { text: [400, 200], file: [400, 400], link: [400, 400], group: [600, 400] };
const GRID_GAP = 80;

class CanvasError extends Error {}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function parse(raw, rel) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new CanvasError(`${rel} is not valid JSON: ${err.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new CanvasError(`${rel} is not a canvas: expected a JSON object.`);
  }
  data.nodes = Array.isArray(data.nodes) ? data.nodes : [];
  data.edges = Array.isArray(data.edges) ? data.edges : [];
  return data;
}

function stringify(canvas) {
  return `${JSON.stringify(canvas, null, 2)}\n`;
}

function validateColor(color, where) {
  if (color === undefined || color === null) return;
  const value = String(color);
  if (COLORS.has(value) || /^#[0-9a-fA-F]{3,8}$/.test(value)) return;
  throw new CanvasError(`${where}: color must be a preset "1"-"6" or a hex value like "#ff8000", got "${value}".`);
}

// Fills in what the caller left out. A model asked to place nodes by hand tends
// to overlap them or invent coordinates far off-canvas, so x/y are optional
// everywhere and filled from a grid that packs to the right of what exists.
function buildNode(spec, existing) {
  if (!spec || typeof spec !== 'object') throw new CanvasError('Each node must be an object.');
  const type = spec.type || (spec.file ? 'file' : spec.url ? 'link' : spec.label ? 'group' : 'text');
  if (!NODE_TYPES.has(type)) {
    throw new CanvasError(`Unknown node type "${type}". Use one of: ${[...NODE_TYPES].join(', ')}.`);
  }
  if (type === 'text' && typeof spec.text !== 'string') throw new CanvasError('A text node needs "text".');
  if (type === 'file' && typeof spec.file !== 'string') throw new CanvasError('A file node needs "file" (a vault-relative path).');
  if (type === 'link' && typeof spec.url !== 'string') throw new CanvasError('A link node needs "url".');
  validateColor(spec.color, `node ${spec.id || '(new)'}`);

  const [w, h] = DEFAULT_SIZE[type];
  const { x, y } = spec.x === undefined || spec.y === undefined ? nextSlot(existing) : spec;

  const node = {
    ...spec,
    id: spec.id || newId(),
    type,
    x: Math.round(spec.x ?? x),
    y: Math.round(spec.y ?? y),
    width: Math.round(spec.width ?? w),
    height: Math.round(spec.height ?? h),
  };
  if (node.color === undefined) delete node.color;
  return node;
}

// Places the next node to the right of the current bounding box, wrapping to a
// new row every four columns so a generated canvas stays roughly square.
function nextSlot(existing) {
  const placed = existing.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
  if (placed.length === 0) return { x: 0, y: 0 };
  const cols = 4;
  const index = placed.length;
  const width = Math.max(...placed.map((n) => n.width || 400));
  const height = Math.max(...placed.map((n) => n.height || 400));
  const minX = Math.min(...placed.map((n) => n.x));
  const minY = Math.min(...placed.map((n) => n.y));
  return {
    x: minX + (index % cols) * (width + GRID_GAP),
    y: minY + Math.floor(index / cols) * (height + GRID_GAP),
  };
}

function buildEdge(spec, nodes) {
  if (!spec || typeof spec !== 'object') throw new CanvasError('Each edge must be an object.');
  const ids = new Set(nodes.map((n) => n.id));
  for (const key of ['fromNode', 'toNode']) {
    if (typeof spec[key] !== 'string') throw new CanvasError(`An edge needs "${key}".`);
    if (!ids.has(spec[key])) {
      throw new CanvasError(`Edge ${key} "${spec[key]}" does not match any node id on this canvas.`);
    }
  }
  for (const key of ['fromSide', 'toSide']) {
    if (spec[key] !== undefined && !SIDES.has(spec[key])) {
      throw new CanvasError(`Edge ${key} must be one of: ${[...SIDES].join(', ')}.`);
    }
  }
  for (const key of ['fromEnd', 'toEnd']) {
    if (spec[key] !== undefined && !ENDS.has(spec[key])) {
      throw new CanvasError(`Edge ${key} must be "none" or "arrow".`);
    }
  }
  validateColor(spec.color, `edge ${spec.id || '(new)'}`);

  // Sides are optional in the spec but Obsidian renders a much tidier graph
  // when they are set, and it never writes an edge without them.
  const from = nodes.find((n) => n.id === spec.fromNode);
  const to = nodes.find((n) => n.id === spec.toNode);
  const [fromSide, toSide] = facingSides(from, to);

  return {
    ...spec,
    id: spec.id || newId(),
    fromSide: spec.fromSide || fromSide,
    toSide: spec.toSide || toSide,
  };
}

function facingSides(from, to) {
  if (!from || !to) return ['right', 'left'];
  const dx = (to.x + (to.width || 0) / 2) - (from.x + (from.width || 0) / 2);
  const dy = (to.y + (to.height || 0) / 2) - (from.y + (from.height || 0) / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

// Re-flows every node into a grid or a single column/row. Coordinates are the
// one part of a canvas a language model cannot reason about well, so this
// exists to be called instead of hand-placing nodes.
function layout(canvas, { mode = 'grid', columns = 4, gap = GRID_GAP, startX = 0, startY = 0 } = {}) {
  const nodes = canvas.nodes.filter((n) => n.type !== 'group');
  if (nodes.length === 0) return canvas;

  const cols = mode === 'column' ? 1 : mode === 'row' ? nodes.length : Math.max(1, Math.min(columns, nodes.length));
  const colWidth = Math.max(...nodes.map((n) => n.width || 400)) + gap;
  const rowHeight = Math.max(...nodes.map((n) => n.height || 400)) + gap;

  nodes.forEach((node, i) => {
    node.x = startX + (i % cols) * colWidth;
    node.y = startY + Math.floor(i / cols) * rowHeight;
  });
  return canvas;
}

// A compact, id-first view. The raw JSON is mostly coordinates, which cost a
// lot of context and tell the reader nothing about the structure.
function summarize(canvas, rel) {
  const lines = [`Canvas: ${rel}`, `${canvas.nodes.length} nodes, ${canvas.edges.length} edges`, ''];

  for (const node of canvas.nodes) {
    const at = `(${node.x}, ${node.y}) ${node.width}x${node.height}`;
    let what;
    if (node.type === 'text') what = firstLine(node.text);
    else if (node.type === 'file') what = node.file + (node.subpath ? `#${node.subpath.replace(/^#/, '')}` : '');
    else if (node.type === 'link') what = node.url;
    else what = node.label || '(unlabelled group)';
    lines.push(`  ${node.id}  ${node.type.padEnd(5)}  ${at}${node.color ? `  color ${node.color}` : ''}`);
    lines.push(`      ${what}`);
  }

  if (canvas.edges.length) {
    lines.push('', 'Edges:');
    for (const edge of canvas.edges) {
      const label = edge.label ? `  "${edge.label}"` : '';
      lines.push(`  ${edge.id}  ${edge.fromNode} (${edge.fromSide}) -> ${edge.toNode} (${edge.toSide})${label}`);
    }
  }

  return lines.join('\n');
}

function firstLine(text) {
  const line = String(text || '').split('\n').find((l) => l.trim()) || '';
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

module.exports = { CanvasError, buildEdge, buildNode, layout, newId, parse, stringify, summarize, NODE_TYPES, SIDES };
