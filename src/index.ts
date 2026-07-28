#!/usr/bin/env node
/**
 * stdio entry point.
 *
 * `runMcp` builds the `McpServer`, writes the banner to **stderr** (stdout is
 * the JSON-RPC channel and nothing else may touch it), applies every registrar
 * with `client` threaded through as deps, wires SIGINT/SIGTERM shutdown, and
 * connects the stdio transport.
 *
 * The client is built in the CALLER — here — and never in a registrar, which is
 * what keeps the deferred-config-error pattern intact: `new KiaClient()` does no
 * I/O and never throws, so the server boots and answers the host's install-time
 * `tools/list` probe with no Kia credentials present. The configuration error
 * surfaces on the first tool call instead, where a human can read it.
 */

import { runMcp } from '@chrischall/mcp-utils';
import { client } from './client.js';
import { TOOL_REGISTRARS } from './registrars.js';
import { VERSION } from './version.js';

await runMcp({
  name: 'kiaaccess-mcp',
  version: VERSION,
  banner: '[kiaaccess-mcp] This project was developed and is maintained by AI. Use at your own discretion.',
  deps: client,
  tools: TOOL_REGISTRARS,
});
