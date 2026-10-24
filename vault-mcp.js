#!/usr/bin/env node
//
// MCP server over an Obsidian vault on disk, spoken over stdio.
//
// Reads and writes plain files, so Obsidian does not need to be running and no
// plugin is involved. supergateway puts this on Streamable HTTP and
// auth-server.js is what makes it safe to reach from outside; nothing in here
// authenticates anything.

'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} = require('@modelcontextprotocol/sdk/types.js');

const { createRegistry } = require('./lib/vault');
const { check } = require('./lib/validate');
const pkg = require('./package.json');

const TOOLS = [
  ...require('./lib/tools/browse').tools,
  ...require('./lib/tools/notes').tools,
  ...require('./lib/tools/frontmatter').tools,
  ...require('./lib/tools/folders').tools,
  ...require('./lib/tools/tags').tools,
  ...require('./lib/tools/links').tools,
  ...require('./lib/tools/search').tools,
  ...require('./lib/tools/canvas').tools,
  ...require('./lib/tools/daily').tools,
  ...require('./lib/tools/attachments').tools,
];

const USAGE = `Usage: node vault-mcp.js <vault-path> [more-vault-paths...]

Serves each directory as a vault named after its folder, lower-cased with
non-alphanumeric characters turned into hyphens: "~/Documents/Brain dump"
becomes "brain-dump".

Speaks MCP over stdio. It has no authentication and no network listener of its
own, so run it behind auth-server.js rather than exposing it directly.`;

function log(message) {
  // stdout carries the protocol. Anything else goes to stderr or it corrupts
  // the stream and the client drops the connection.
  process.stderr.write(`[vault-mcp] ${message}\n`);
}

async function main() {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (process.argv.includes('--help') || process.argv.includes('-h') || paths.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(paths.length === 0 ? 1 : 0);
  }

  let vaults;
  try {
    vaults = createRegistry(paths);
  } catch (err) {
    log(`cannot start: ${err.message}`);
    process.exit(1);
  }

  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  if (byName.size !== TOOLS.length) {
    log('duplicate tool name in the registry');
    process.exit(1);
  }

  const server = new Server(
    { name: 'obsidian-vault-mcp', version: pkg.version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool "${request.params.name}".`);
    }
    const args = request.params.arguments || {};

    try {
      check(tool.inputSchema, args, tool.name);
      return await tool.handler(args, { vaults });
    } catch (err) {
      // Returned as a tool result rather than a JSON-RPC error: the caller can
      // read what went wrong and try again, instead of the client treating the
      // whole request as failed.
      const message = err instanceof McpError ? err.message.replace(/^MCP error -?\d+:\s*/, '') : err.message;
      log(`${tool.name} failed: ${message}`);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  log(`serving ${vaults.size} vault(s): ${[...vaults.keys()].join(', ')} - ${TOOLS.length} tools`);

  for (const vault of vaults.values()) {
    vault.index().catch((err) => log(`initial index of ${vault.name} failed: ${err.message}`));
  }
}

process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err && err.message}`));

main().catch((err) => {
  log(`fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
