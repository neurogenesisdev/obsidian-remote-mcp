'use strict';

const path = require('path');
const canvasLib = require('../canvas');
const ops = require('../fsops');
const { normalizeRelative } = require('../paths');
const { bytes, invalid, notFound, pickVault, resolveTarget, schema, text, when } = require('./common');

const NODE_SCHEMA = {
  type: 'object',
  description:
    'A canvas node. "type" is text, file, link or group. Give "id" if you want to reference it from an edge. ' +
    'x/y/width/height are optional and filled in automatically.',
  properties: {
    id: { type: 'string', description: 'Your own identifier, reused by edges. Generated when omitted.' },
    type: { type: 'string', enum: ['text', 'file', 'link', 'group'] },
    text: { type: 'string', description: 'Markdown, for a text node.' },
    file: { type: 'string', description: 'Vault-relative path, for a file node.' },
    subpath: { type: 'string', description: 'Heading or block inside the file, e.g. "#Summary".' },
    url: { type: 'string', description: 'For a link node.' },
    label: { type: 'string', description: 'For a group node.' },
    color: { type: 'string', description: 'Preset "1"-"6" (red, orange, yellow, green, cyan, purple) or a hex value.' },
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
  },
};

const EDGE_SCHEMA = {
  type: 'object',
  description: 'An arrow between two nodes, referencing their ids.',
  properties: {
    id: { type: 'string' },
    from: { type: 'string', description: 'Source node id. "fromNode" also accepted.' },
    to: { type: 'string', description: 'Target node id. "toNode" also accepted.' },
    fromNode: { type: 'string' },
    toNode: { type: 'string' },
    fromSide: { type: 'string', enum: ['top', 'right', 'bottom', 'left'], description: 'Chosen from the node positions when omitted.' },
    toSide: { type: 'string', enum: ['top', 'right', 'bottom', 'left'] },
    fromEnd: { type: 'string', enum: ['none', 'arrow'] },
    toEnd: { type: 'string', enum: ['none', 'arrow'] },
    label: { type: 'string' },
    color: { type: 'string' },
  },
};

// Accepts the short from/to spelling as well as the spec's fromNode/toNode.
// Absent keys are dropped rather than set to undefined, so merging a partial
// edge into an existing one does not blank out what it left unmentioned.
function normalizeEdge(spec) {
  const { from, to, ...rest } = spec || {};
  const out = { ...rest };
  const fromNode = rest.fromNode || from;
  const toNode = rest.toNode || to;
  if (fromNode !== undefined) out.fromNode = fromNode;
  if (toNode !== undefined) out.toNode = toNode;
  return out;
}

async function loadCanvas(vault, args, { write = false } = {}) {
  const { rel, abs } = resolveTarget(vault, args, { write, ext: '.canvas' });
  if (!rel.toLowerCase().endsWith('.canvas')) {
    throw invalid(`${rel} is not a canvas. Canvas paths must end in .canvas.`);
  }
  if (!(await ops.exists(abs))) throw notFound(`No such canvas: ${rel}`);
  return { rel, abs, canvas: canvasLib.parse(await ops.readText(abs), rel) };
}

// A file node pointing at nothing renders as an empty card in Obsidian, which
// looks like a bug rather than a typo. Reported, not rejected: a canvas may
// legitimately be built before the notes it references.
function missingFiles(vault, canvas) {
  return canvas.nodes
    .filter((n) => n.type === 'file' && n.file)
    .map((n) => normalizeRelative(n.file))
    .filter((rel) => !vault.files.has(rel));
}

const tools = [
  {
    name: 'create-canvas',
    description:
      'Create an Obsidian canvas (.canvas). Nodes are laid out automatically, so positions can be left out - ' +
      'give the structure and let the layout place it.\n\n' +
      'Examples:\n' +
      '- From notes: { "path": "map.canvas", "fromNotes": ["a.md", "b.md"], "linkEdges": true }\n' +
      '- By hand: { "path": "flow.canvas", "nodes": [{ "id": "a", "type": "text", "text": "Start" }, ' +
      '{ "id": "b", "type": "file", "file": "step.md" }], "edges": [{ "from": "a", "to": "b", "label": "then" }] }',
    inputSchema: schema(
      {
        path: { type: 'string', description: 'Canvas path relative to the vault root. ".canvas" is appended if missing.' },
        nodes: { type: 'array', items: NODE_SCHEMA, description: 'Nodes to place.' },
        edges: { type: 'array', items: EDGE_SCHEMA, description: 'Arrows between nodes, by id.' },
        fromNotes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Vault-relative note paths to add as file nodes. Their ids are the paths themselves, so edges can reference them.',
        },
        linkEdges: { type: 'boolean', description: 'With fromNotes, draw an arrow wherever one of those notes links to another. Default false.' },
        layout: { type: 'string', enum: ['grid', 'column', 'row', 'none'], description: 'How to place nodes that have no coordinates. Default grid.' },
        columns: { type: 'number', description: 'Columns for the grid layout. Default 4.' },
        overwrite: { type: 'boolean', description: 'Replace an existing canvas. Default false.' },
      },
      ['path']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel, abs } = resolveTarget(vault, { path: args.path }, { write: true, ext: '.canvas' });
      if (!rel.toLowerCase().endsWith('.canvas')) throw invalid('A canvas path must end in .canvas.');
      if ((await ops.exists(abs)) && !args.overwrite) {
        throw invalid(`${rel} already exists. Pass "overwrite": true, or use edit-canvas to change it.`);
      }
      await vault.index();

      const specs = [];
      for (const note of args.fromNotes || []) {
        const noteRel = normalizeRelative(note);
        specs.push({ id: noteRel, type: 'file', file: noteRel });
      }
      specs.push(...(args.nodes || []));
      if (specs.length === 0) throw invalid('Give at least one node, via "nodes" or "fromNotes".');

      const nodes = [];
      for (const spec of specs) {
        try {
          nodes.push(canvasLib.buildNode(spec, nodes));
        } catch (err) {
          throw invalid(err.message);
        }
      }

      if (args.layout !== 'none') {
        canvasLib.layout({ nodes, edges: [] }, { mode: args.layout || 'grid', columns: args.columns || 4 });
      }

      const edgeSpecs = (args.edges || []).map(normalizeEdge);
      if (args.linkEdges && args.fromNotes) {
        const inCanvas = new Set(nodes.filter((n) => n.type === 'file').map((n) => normalizeRelative(n.file)));
        for (const from of inCanvas) {
          const note = vault.notes.get(from);
          if (!note) continue;
          for (const link of note.links) {
            const to = vault.resolveLink(link.target, from);
            if (to && to !== from && inCanvas.has(to)) edgeSpecs.push({ fromNode: from, toNode: to });
          }
        }
      }

      const edges = [];
      const seen = new Set();
      for (const spec of edgeSpecs) {
        const key = `${spec.fromNode}->${spec.toNode}:${spec.label || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          edges.push(canvasLib.buildEdge(spec, nodes));
        } catch (err) {
          throw invalid(err.message);
        }
      }

      const canvas = { nodes, edges };
      await ops.writeText(abs, canvasLib.stringify(canvas));
      vault.invalidate();

      const missing = missingFiles(vault, canvas);
      const warning = missing.length
        ? `\n\nWarning: ${missing.length} file node${missing.length === 1 ? '' : 's'} point at paths that do not exist yet:\n  ${missing.join('\n  ')}`
        : '';
      return text(`Created ${rel} with ${nodes.length} nodes and ${edges.length} edges.${warning}`);
    },
  },

  {
    name: 'read-canvas',
    description:
      'Read a canvas as a structured list of nodes and edges with their ids, which is what edit-canvas needs. ' +
      'Set raw for the underlying JSON, which is mostly coordinates and much longer.',
    inputSchema: schema(
      {
        path: { type: 'string', description: 'Canvas path relative to the vault root.' },
        raw: { type: 'boolean', description: 'Return the file contents verbatim. Default false.' },
      },
      ['path']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel, abs, canvas } = await loadCanvas(vault, { path: args.path });
      if (args.raw) return text(await ops.readText(abs));
      await vault.index();

      const missing = missingFiles(vault, canvas);
      const warning = missing.length ? `\n\nFile nodes pointing at missing paths:\n  ${missing.join('\n  ')}` : '';
      return text(canvasLib.summarize(canvas, rel) + warning);
    },
  },

  {
    name: 'edit-canvas',
    description:
      'Change a canvas with a list of operations, applied in order. Node and edge ids come from read-canvas. ' +
      'Unknown fields Obsidian wrote are preserved.\n\n' +
      'Operations: add-node, update-node, remove-node (drops its edges too), add-edge, update-edge, remove-edge, ' +
      'layout (re-flow every node).\n\n' +
      'Example: { "path": "map.canvas", "operations": [ { "op": "add-node", "node": { "id": "c", "type": "text", ' +
      '"text": "New" } }, { "op": "add-edge", "edge": { "from": "a", "to": "c" } } ] }',
    inputSchema: schema(
      {
        path: { type: 'string', description: 'Canvas path relative to the vault root.' },
        operations: {
          type: 'array',
          description: 'Operations applied in order.',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['add-node', 'update-node', 'remove-node', 'add-edge', 'update-edge', 'remove-edge', 'layout'],
              },
              node: NODE_SCHEMA,
              edge: EDGE_SCHEMA,
              id: { type: 'string', description: 'Target id for update-node, remove-node, update-edge and remove-edge.' },
              mode: { type: 'string', enum: ['grid', 'column', 'row'], description: 'For the layout operation. Default grid.' },
              columns: { type: 'number', description: 'For the layout operation. Default 4.' },
            },
            required: ['op'],
          },
        },
      },
      ['path', 'operations']
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      const { rel, abs, canvas } = await loadCanvas(vault, { path: args.path }, { write: true });
      if (!Array.isArray(args.operations) || args.operations.length === 0) {
        throw invalid('"operations" must be a non-empty array.');
      }

      const log = [];
      for (const [i, operation] of args.operations.entries()) {
        const where = `operation ${i + 1} (${operation && operation.op})`;
        try {
          applyOperation(canvas, operation, log);
        } catch (err) {
          throw invalid(`${where} failed: ${err.message}. Nothing was written.`);
        }
      }

      await ops.writeText(abs, canvasLib.stringify(canvas));
      vault.invalidate();
      return text(
        [`Updated ${rel}: ${log.join(', ')}.`, `Now ${canvas.nodes.length} nodes and ${canvas.edges.length} edges.`].join('\n')
      );
    },
  },

  {
    name: 'list-canvases',
    description: 'Every .canvas file in the vault, newest first.',
    inputSchema: schema(
      {
        folder: { type: 'string', description: 'Only canvases under this folder.' },
        limit: { type: 'number', description: 'Maximum canvases. Default 100.' },
      },
      []
    ),
    async handler(args, { vaults }) {
      const vault = pickVault(vaults, args);
      await vault.index();
      const prefix = args.folder ? `${String(args.folder).replace(/^\/+|\/+$/g, '')}/` : null;

      const found = [...vault.files.entries()]
        .filter(([rel]) => rel.toLowerCase().endsWith('.canvas'))
        .filter(([rel]) => !prefix || rel.startsWith(prefix))
        .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
        .slice(0, args.limit || 100);

      if (found.length === 0) return text(`No canvases${prefix ? ` under ${args.folder}` : ''} in ${vault.name}.`);
      const lines = [`${found.length} canvas${found.length === 1 ? '' : 'es'}:`, ''];
      for (const [rel, meta] of found) lines.push(`  ${when(meta.mtimeMs)}  ${bytes(meta.size).padStart(9)}  ${rel}`);
      return text(lines.join('\n'));
    },
  },
];

// Mutates `canvas` in place. Every failure throws before anything is written,
// so a bad operation halfway through a list leaves the file untouched.
function applyOperation(canvas, operation, log) {
  const nodeIndex = (id) => {
    const at = canvas.nodes.findIndex((n) => n.id === id);
    if (at === -1) throw new Error(`no node with id "${id}"`);
    return at;
  };
  const edgeIndex = (id) => {
    const at = canvas.edges.findIndex((e) => e.id === id);
    if (at === -1) throw new Error(`no edge with id "${id}"`);
    return at;
  };

  switch (operation.op) {
    case 'add-node': {
      if (!operation.node) throw new Error('"node" is required');
      if (operation.node.id && canvas.nodes.some((n) => n.id === operation.node.id)) {
        throw new Error(`a node with id "${operation.node.id}" already exists`);
      }
      const node = canvasLib.buildNode(operation.node, canvas.nodes);
      canvas.nodes.push(node);
      log.push(`added node ${node.id}`);
      break;
    }
    case 'update-node': {
      const id = operation.id || (operation.node && operation.node.id);
      const at = nodeIndex(id);
      const merged = { ...canvas.nodes[at], ...(operation.node || {}), id };
      canvas.nodes[at] = canvasLib.buildNode(merged, canvas.nodes.filter((_, i) => i !== at));
      log.push(`updated node ${id}`);
      break;
    }
    case 'remove-node': {
      const at = nodeIndex(operation.id);
      const [removed] = canvas.nodes.splice(at, 1);
      const before = canvas.edges.length;
      canvas.edges = canvas.edges.filter((e) => e.fromNode !== removed.id && e.toNode !== removed.id);
      log.push(`removed node ${removed.id}${before !== canvas.edges.length ? ` and ${before - canvas.edges.length} edges` : ''}`);
      break;
    }
    case 'add-edge': {
      if (!operation.edge) throw new Error('"edge" is required');
      const edge = canvasLib.buildEdge(normalizeEdge(operation.edge), canvas.nodes);
      canvas.edges.push(edge);
      log.push(`added edge ${edge.id}`);
      break;
    }
    case 'update-edge': {
      const id = operation.id || (operation.edge && operation.edge.id);
      const at = edgeIndex(id);
      const merged = { ...canvas.edges[at], ...normalizeEdge(operation.edge || {}), id };
      canvas.edges[at] = canvasLib.buildEdge(merged, canvas.nodes);
      log.push(`updated edge ${id}`);
      break;
    }
    case 'remove-edge': {
      const at = edgeIndex(operation.id);
      const [removed] = canvas.edges.splice(at, 1);
      log.push(`removed edge ${removed.id}`);
      break;
    }
    case 'layout': {
      canvasLib.layout(canvas, { mode: operation.mode || 'grid', columns: operation.columns || 4 });
      log.push(`re-laid out ${canvas.nodes.length} nodes`);
      break;
    }
    default:
      throw new Error(`unknown operation "${operation.op}"`);
  }
}

module.exports = { tools };
