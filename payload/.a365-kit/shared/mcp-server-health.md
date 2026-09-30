# MCP server health: one failing server must not stop the rest

Several agent SDKs gather tools from every attached MCP server when a run starts. If one
server fails at that point, the whole run fails, and a fallback that retries without tools
then loses every server. Check the servers before each run and pass on only the ones that
answer. A skipped server is tried again on the next turn.

| Stack | When one server fails | What to do |
|---|---|---|
| Python, OpenAI Agents SDK | The run fails. The Agent 365 extension skips a server that fails to connect, but not one that connects and then fails to list tools. | `healthy_mcp_agent` below |
| Node.js, OpenAI Agents SDK | The run fails. The Microsoft sample also connects servers one at a time, so the first connect failure stops the turn. | `healthyMcpAgent` below |
| Python, Agent Framework | The run fails when a server does not connect. A server whose tool list failed stays marked connected with no tools. | `healthy_mcp_tools` below |
| Node.js, LangChain | The Agent 365 extension connects every server through one client that throws on the first failure, so the turn loses all Work IQ tools. | Keep the fallback and log the full error. |
| Python, Google ADK 2.0 or later | ADK skips a toolset that fails to load and logs it. ADK 1.x does not. | Nothing on 2.x. |
| .NET, Agent 365 tooling | Tools load server by server and a failing server is logged and skipped. | Nothing. |

The helpers below were run against openai-agents 0.20.0, @openai/agents 0.17.0 and 0.18.0, and
agent-framework-core 1.17.0 with four local servers: one healthy, one answering tools/list with
HTTP 403, one answering with a JSON-RPC error, and one that never answers. Without the check
every run failed; with it the run kept the healthy server's tools. The kit repository tests the
helpers on every build in `build/test-mcp-server-health.mjs`.

Each helper logs the server name and the error. They never log headers or tokens.

## Python: OpenAI Agents SDK

Save as `mcp_health.py` beside `agent.py`.

```python
import asyncio
import logging

logger = logging.getLogger(__name__)


async def healthy_mcp_agent(agent, timeout: float = 10.0):
    """Return the agent, or a copy without the MCP servers that cannot list tools right now."""
    servers = list(agent.mcp_servers or [])
    if not servers:
        return agent
    results = await asyncio.gather(
        *(asyncio.wait_for(server.list_tools(), timeout) for server in servers),
        return_exceptions=True,
    )
    healthy = []
    for server, result in zip(servers, results):
        if isinstance(result, BaseException):
            logger.warning("MCP server %s skipped this turn: %s: %s", server.name, type(result).__name__, result)
        else:
            healthy.append(server)
    if len(healthy) == len(servers):
        return agent
    return agent.clone(mcp_servers=healthy)
```

Run the returned agent and leave `self.agent` as it is, so a skipped server is tried again on
the next turn:

```python
from mcp_health import healthy_mcp_agent

await self.setup_mcp_servers(auth, auth_handler_name, context)
agent = await healthy_mcp_agent(self.agent)
result = await Runner.run(agent, message)
```

## Node.js: OpenAI Agents SDK

Save as `src/mcpHealth.ts`.

```typescript
import type { Agent, MCPServer } from '@openai/agents';

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Returns the agent, or a copy without the MCP servers that cannot list tools right now. */
export async function healthyMcpAgent<A extends Agent<any, any>>(agent: A, timeoutMs = 10_000): Promise<A> {
  const servers: MCPServer[] = agent.mcpServers ?? [];
  if (servers.length === 0) return agent;
  const results = await Promise.allSettled(servers.map((server) => within(server.listTools(), timeoutMs)));
  const healthy = servers.filter((server, i) => {
    const result = results[i];
    if (result.status === 'fulfilled') return true;
    console.warn(`MCP server ${server.name} skipped this turn:`, result.reason instanceof Error ? result.reason.message : result.reason);
    return false;
  });
  return healthy.length === servers.length ? agent : (agent.clone({ mcpServers: healthy }) as A);
}
```

Where the client connects the servers before `run()`, connect them all at once, then run the
checked copy. A server that failed to connect is dropped by the check, and `close()` is safe
on it afterwards:

```typescript
import { healthyMcpAgent } from './mcpHealth';

await Promise.allSettled(agent.mcpServers.map((server) => server.connect()));
const result = await run(await healthyMcpAgent(agent), prompt);
```

## Python: Agent Framework

Save as `mcp_health.py` beside `agent.py`.

```python
import asyncio
import logging

logger = logging.getLogger(__name__)


async def healthy_mcp_tools(tools, timeout: float = 10.0):
    """Reconnect MCP tools that have no tools loaded, and return the ones that do."""
    # A server whose tool list failed still reports is_connected, so check the loaded tools too.
    pending = [tool for tool in tools if not (tool.is_connected and tool.functions)]
    results = await asyncio.gather(
        *(asyncio.wait_for(tool.connect(reset=True), timeout) for tool in pending),
        return_exceptions=True,
    )
    for tool, result in zip(pending, results):
        if isinstance(result, BaseException):
            logger.warning("MCP server %s skipped this turn: %s: %s", tool.name, type(result).__name__, result)
    return [tool for tool in tools if tool.is_connected and tool.functions]
```

Keep the full list of MCP tools and give the agent the healthy ones before each run. The
agent's own list shrinks for the turn, so the full list is what lets a skipped server back in:

```python
from mcp_health import healthy_mcp_tools

await self.setup_mcp_servers(auth, auth_handler_name, context)
if getattr(self, "_mcp_agent", None) is not self.agent:
    self._mcp_agent, self._all_mcp_tools = self.agent, list(self.agent.mcp_tools)
self.agent.mcp_tools = await healthy_mcp_tools(self._all_mcp_tools)
result = await self.agent.run(message)
```

## When to fail closed instead

Some agents should stop rather than answer without a tool, for example when a missing mailbox
tool would produce a confident but wrong reply. That is a valid choice. Make it explicit: fail
the turn with a clear message and do not fall back to an agent with no tools. The
`python-teammate` example in the kit repository fails closed: one failing Work IQ server ends
the turn before any model call, and the user gets a short apology.
