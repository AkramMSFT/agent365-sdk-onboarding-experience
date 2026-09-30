# External MCP servers -- Node.js / TypeScript (OpenAI Agents SDK for JS)

Port of the Python reference. `MCPServerStdio` / `MCPServerStreamableHttp` are exported by
`@openai/agents`. Construction is lazy: connect before running, and close at host shutdown
or if startup fails later. A server that fails to connect is logged and left out; it does not
stop the others. No tenant call is needed to check these lifecycle rules.

## `src/mcpServers.ts`

```typescript
import { MCPServerStdio, MCPServerStreamableHttp, type MCPServer } from '@openai/agents';

/** Direct MCP connections: no Agent 365 registration/approval/gateway routing is added here. */
export function buildExternalMcpServers() {
  const servers: MCPServer[] = [];

  const fsRoot = process.env.AGENT_FS_ROOT;
  if (fsRoot) {
    servers.push(new MCPServerStdio({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', fsRoot],
      cacheToolsList: true,
      timeout: 30_000,
    }));
  }

  if (process.env.AGENT_ENABLE_FETCH_MCP === 'true') {
    servers.push(new MCPServerStdio({
      name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'], cacheToolsList: true, timeout: 30_000,
    }));
  }

  if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    servers.push(new MCPServerStdio({
      name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN },
      cacheToolsList: true,
      timeout: 30_000,
    }));
  }

  const httpUrl = process.env.AGENT_MCP_HTTP_URL;
  if (httpUrl) {
    servers.push(new MCPServerStreamableHttp({ name: 'remote', url: httpUrl, cacheToolsList: true, timeout: 30_000 }));
  }

  return servers;
}

export async function connectExternalMcpServers(servers = buildExternalMcpServers()) {
  const close = async () => {
    const results = await Promise.allSettled(servers.map(server => server.close()));
    for (const result of results) {
      if (result.status === 'rejected') console.warn('External MCP cleanup failed:', result.reason);
    }
  };
  const results = await Promise.allSettled(servers.map(server => server.connect()));
  results.forEach((result, i) => {
    if (result.status === 'rejected') console.warn(`External MCP server ${servers[i].name} not connected:`, result.reason);
  });
  return { servers, close };
}
```

## Wiring

```typescript
import { connectExternalMcpServers } from './mcpServers';

const external = await connectExternalMcpServers();
try {
  const agent = new Agent({
    name: '...',
    instructions: '... You also have external MCP tools: <describe>. Use them when relevant. ...',
    tools: [...existingTools],
    mcpServers: [...existingMcpServers, ...external.servers],
  });
  await runAgentSession(agent); // existing host/session; resolves only on shutdown
} finally {
  await external.close();
}
```

The SDK lists tools from every attached server when a run starts, and one failure fails the
run. Copy `healthyMcpAgent` from `.a365-kit/shared/mcp-server-health.md` into
`src/mcpHealth.ts` and run the copy it returns, so a server that did not connect or stops
answering is left out for that turn:

```typescript
import { healthyMcpAgent } from './mcpHealth';

const result = await run(await healthyMcpAgent(agent), prompt);
```

`npx` ships with Node; `uvx` needs `uv`. Verify with `npm run build`, start the agent, confirm the server's tools list. Same governance as the Python reference: scope tightly, secrets from env, treat output as untrusted, pair with `purview-dlp-integration`.
The session call and existing collections are adapter placeholders. Keep the `try/finally`
around the real host lifetime, not just construction of `Agent`. Preserve any framework
tool-name prefixing, and use fresh per-turn collections when attaching user-specific Work IQ
tools rather than modifying the shared base agent.
