# External MCP servers -- Python (OpenAI Agents SDK)

API verified against `openai-agents` on the live venv (2026-09-04): `agents.mcp` exports `MCPServerStdio`, `MCPServerStreamableHttp`, `MCPServerSse`; `Agent(..., mcp_servers=[...])` accepts them. The wiring below constructed and entered a server and called `list_tools` cleanly; a smoke test additionally needs network access to fetch the chosen server package (`uvx`/`npx`).

## `src/mcp_servers.py`

One factory per server you attach. Constructing a server is lazy; **the caller must connect
it before `Runner.run`**. The SDK does not open unconnected servers automatically.

```python
"""External (non-Work-IQ) MCP servers for the agent.

These connect the framework directly to MCP servers. This module does not add
Agent 365 registration, approval or tooling-gateway routing. Separately governed
BYO MCP and the server's own authentication are different flows; see the skill.
Secrets come from the environment, never hard-coded.
"""

from __future__ import annotations

import logging
import os
from contextlib import AsyncExitStack, asynccontextmanager

from agents.mcp import MCPServerStdio, MCPServerStreamableHttp

logger = logging.getLogger(__name__)


def build_external_mcp_servers() -> list:
    """Return the external MCP servers to attach this run. Add only what you need."""
    servers: list = []

    # Scope the filesystem server to one directory, never the drive root.
    workdir = os.getenv("AGENT_FS_ROOT")
    if workdir:
        servers.append(MCPServerStdio(
            name="filesystem",
            params={"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", workdir]},
            client_session_timeout_seconds=30,
            cache_tools_list=True,
        ))

    # The fetch server is an egress and prompt-injection surface, like the lab fetch_url tool.
    if os.getenv("AGENT_ENABLE_FETCH_MCP", "").lower() == "true":
        servers.append(MCPServerStdio(
            name="fetch",
            params={"command": "uvx", "args": ["mcp-server-fetch"]},
            client_session_timeout_seconds=30,
            cache_tools_list=True,
        ))

    if os.getenv("GITHUB_PERSONAL_ACCESS_TOKEN"):
        servers.append(MCPServerStdio(
            name="github",
            params={
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-github"],
                "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": os.environ["GITHUB_PERSONAL_ACCESS_TOKEN"]},
            },
            client_session_timeout_seconds=30,
            cache_tools_list=True,
        ))

    # Connect only to a remote MCP server you trust.
    http_url = os.getenv("AGENT_MCP_HTTP_URL")
    if http_url:
        servers.append(MCPServerStreamableHttp(
            name="remote",
            params={"url": http_url},   # add "headers": {...} for auth if the server needs it
            client_session_timeout_seconds=30,
            cache_tools_list=True,
        ))

    return servers


EXTERNAL_MCP_SERVERS = build_external_mcp_servers()


@asynccontextmanager
async def connect_external_mcp_servers(servers=None):
    """Keep connections alive for the enclosing run/host lifetime, on the same task."""
    selected = EXTERNAL_MCP_SERVERS if servers is None else servers
    async with AsyncExitStack() as stack:
        connected = []
        for server in selected:
            # One server that fails to start must not keep the others away.
            try:
                connected.append(await stack.enter_async_context(server))
            except Exception as error:
                logger.warning("External MCP server %s not connected: %s: %s", server.name, type(error).__name__, error)
        yield connected
```

## Wiring into the agent

Append to the agent's `mcp_servers` -- do not disturb the Work IQ path. If Work IQ is also attached, `include_server_in_tool_names` should already be set so names never collide.

```python
try:
    from src.mcp_servers import EXTERNAL_MCP_SERVERS
except ImportError:
    from mcp_servers import EXTERNAL_MCP_SERVERS

expenses_agent = Agent(
    name="...",
    instructions=(
        # Name the new tools so the model uses them.
        "You also have external MCP tools: <describe what you attached, e.g. read files "
        "under the work directory, fetch web pages, query GitHub>. Use them when relevant. "
        # Keep the rest of the existing instructions.
    ),
    tools=[*existing_tools],
    mcp_servers=[*existing_mcp_servers, *EXTERNAL_MCP_SERVERS],
    mcp_config={"include_server_in_tool_names": True},
)
```

`existing_tools` and `existing_mcp_servers` stand for the consuming agent's current
collections. This is an integration fragment, not a new replacement agent.

The SDK lists tools from every attached server when a run starts, and one failure fails the
run. Copy `healthy_mcp_agent` from `.a365-kit/shared/mcp-server-health.md` into
`mcp_health.py` and run the copy it returns, so a server that did not connect or stops
answering is left out for that turn:

```python
from mcp_health import healthy_mcp_agent

result = await Runner.run(await healthy_mcp_agent(expenses_agent), message)
```

Keep the connections open around the **entire** host/session lifetime:

```python
from src.mcp_servers import connect_external_mcp_servers

async def main():
    async with connect_external_mcp_servers():
        await run_agent_session()  # existing async host/session entry point
```

For `GenericAgentHost`, enter that context in `HostedAgent.initialize()` using an
`AsyncExitStack` and close it in `HostedAgent.cleanup()` on the same startup task. Close on
partial startup failure as well. Never call `asyncio.run()` just to connect and then close
its loop before the host starts. If Work IQ is attached per turn, clone the base agent and
pass a fresh `mcp_servers` list; keep these connected external servers, and never retain a
previous user's authenticated Work IQ servers on the base agent.

## Prerequisites for stdio servers

- **Node servers** (`@modelcontextprotocol/server-*`, `@playwright/mcp`): `npx` on PATH (comes with Node). `npx -y` fetches on first use.
- **Python servers** (`mcp-server-fetch`, `mcp-server-git`, `mcp-server-time`, `mcp-server-sqlite`): `uv` on PATH (`pip install uv`), then `uvx <server>`.
- The host process needs outbound network the first time to download the server package; in a locked-down deployment, pre-install the servers into the image.

## Verify

```bash
python -c "import src.agent as a; print('mcp servers:', [s.name for s in (a.expenses_agent.mcp_servers or [])])"
```

Then start the agent (or `test-local`) and confirm the server's tools list without error. `time` (`uvx mcp-server-time`) is the cheapest smoke test. Restart the host after changes -- servers attach at startup.

## Guards to keep

- Scope every server to the least it needs: one directory, a read-only DB role, a single repo.
- Put tokens and connection strings in `.env`; pass them through `params["env"]` for stdio, `params["headers"]` for HTTP. Never inline.
- Set `client_session_timeout_seconds` so a hung server does not hang the turn.
- Treat every tool result as untrusted model input; pair with `purview-dlp-integration`.
