---
name: add-mcp-server
description: >
  Connects an Agent 365 agent to an external / community MCP server -- anything beyond
  Microsoft's Work IQ set: filesystem, git, GitHub, Postgres/SQLite, web fetch and search,
  Slack, Playwright browser, memory, time, and any other Model Context Protocol server.
  Wires it as an stdio (npx/uvx) or streamable-HTTP server on the agent's framework, so its
  tools appear alongside the built-in, Work IQ and lab tools. Use when the user says "add an
  MCP server", "connect the filesystem/github/postgres MCP", "give the agent web search", or
  names any community MCP server. IMPORTANT: this DIRECT connection path does not register
  servers with Agent 365 or configure its tooling consent -- see the governance section.
  Supports Python, Node.js and .NET. Kit
  add-on, not part of Microsoft's skills.
compatibility:
  - claude-code
  - vscode-copilot
  - github-copilot-cli
user-invocable: true
argument-hint: "Optional: the server (e.g. filesystem, github, fetch) or its command/URL"
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion
model: sonnet
hooks:
  preToolUse:
    - type: command
      command: node "${CLAUDE_PROJECT_DIR}/.a365-kit/hooks/preToolUse/path-guard.js"
      timeout: 5000
  stop:
    - type: command
      command: node "${CLAUDE_PROJECT_DIR}/.a365-kit/hooks/stop/validate-add-mcp-server.js"
      timeout: 15000
---

# Add an external MCP server

> **Kit runtime corrections:** Read `.a365-kit/shared/local-runtime-lessons.md` first.
> Preserve existing Work IQ tools, per-server identity, namespace limits, TLS
> validation and per-turn client cleanup. Do not use another server's bearer token
> or replace a blocked catalog endpoint with an invented one.

> **Trigger phrases:**
> - "add an MCP server" / "connect the <name> MCP server"
> - "give the agent filesystem / git / github / postgres / web search / browser access"
> - "add a community MCP tool"

> **Kit add-on, and a governance boundary.** Work IQ MCP servers (`add-workiq-tools`) are
> registered in Agent 365 and gated by Entra per-tool consent. **This add-on's direct path**
> instead connects the framework to a server without adding Agent 365 registration,
> approval or tooling-gateway routing. Existing server authentication is separate. Add external
> servers only for agents you operate, prefer servers you trust or run yourself, and treat
> their output as untrusted model input. `purview-dlp-integration` evaluates the user prompt and
> final reply, not intermediate MCP arguments/results; tool-boundary evaluation is
> additional work. Not part of Microsoft's skills.

## How external MCP differs from Work IQ

| | Work IQ (`add-workiq-tools`) | Direct external MCP (this add-on) |
|---|---|---|
| Server | Microsoft-hosted, 9 fixed | any MCP server, anywhere |
| Transport | streamable-HTTP with per-audience OBO tokens | stdio (`npx`/`uvx`) or streamable-HTTP/SSE |
| Agent 365 registration | yes (`ToolingManifest.json`, Entra grants) | **not created or verified by this wiring** |
| Agent 365 tooling consent | yes | **not configured by this wiring**; server authentication is separate |
| Runtime protections | configured Work IQ governance | only the agent/server protections you explicitly configure |

Use Work IQ for Microsoft 365 data. Use this add-on when the user chooses **direct**
external access rather than the separately governed BYO flow.

**Custom remote MCP is not inherently ungovernable.** Microsoft also documents a separate
[Bring Your Own MCP preview flow](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/manage-tools-for-agent)
with registration, admin approval and Agent 365 Tooling Gateway routing on supported
clients. That flow is not implemented here. If governed BYO MCP is required, follow that
flow and verify its current prerequisites/client support; do not silently substitute these
direct connections. A direct server may also independently require Entra authentication.

## A catalogue to offer

Widely-used servers, all runnable with no build via `npx -y` (Node) or `uvx` (Python). Present a few relevant ones; do not add any the user did not ask for.

| Server | Command (stdio) | Gives the agent | Notes |
|---|---|---|---|
| Filesystem | `npx -y @modelcontextprotocol/server-filesystem <dir>` | read/write files under one directory | scope to a single dir; never the drive root |
| Fetch | `uvx mcp-server-fetch` | fetch and convert a web page to markdown | web egress + injection surface, like lab `fetch_url` |
| Git | `uvx mcp-server-git --repository <path>` | inspect/commit a local repo | |
| GitHub | `npx -y @modelcontextprotocol/server-github` | issues, PRs, repo contents | needs `GITHUB_PERSONAL_ACCESS_TOKEN` |
| Postgres | `npx -y @modelcontextprotocol/server-postgres <conn>` | read-only SQL over a database | prefer a read-only role |
| SQLite | `uvx mcp-server-sqlite --db-path <file>` | query a local SQLite file | |
| Memory | `npx -y @modelcontextprotocol/server-memory` | a persistent knowledge graph | |
| Time | `uvx mcp-server-time` | timezone-aware date/time | harmless; good smoke test |
| Playwright | `npx -y @playwright/mcp` | drive a real browser | powerful; high risk, use deliberately |

Confirm exact package names against the server's own docs before wiring — the ecosystem moves. The Model Context Protocol reference servers live at `github.com/modelcontextprotocol/servers`.

## Phase 0 -- Detect and choose

1. **Read** `.a365-workspace-detection.local.json` for `programmingLanguage`; fall back to project files.
   Confirm the existing framework as well: the Python/Node references use OpenAI Agents,
   and the .NET reference produces `AITool` objects. Other frameworks need their own
   compatible MCP/tool adapter; do not silently change frameworks or replace Work IQ wiring.
2. Confirm `npx` (Node) and/or `uvx` (Python `pip install uv`) are available for stdio servers, or take a URL for an HTTP server.
3. **Ask** which server, and for its parameters (a directory to scope, a connection string, a token env var). If the server carries obvious risk (filesystem at a broad path, Playwright, an HTTP server on a URL you do not control), say so in one line and confirm.

## Phase 1 -- Wire it

**Read** the reference for the language and follow it exactly:

- Python: `.a365-kit/addons/add-mcp-server/references/python-mcp-server.md`
- Node.js: `.a365-kit/addons/add-mcp-server/references/nodejs-mcp-server.md`
- .NET: `.a365-kit/addons/add-mcp-server/references/dotnet-mcp-server.md`

Rules, every language:

- Put the server wiring in a **new module**; do not edit the file the onboarding skills own.
- **Append** to the agent's `mcp_servers` list. Do NOT touch the Work IQ path -- the two coexist. If Work IQ is present, `include_server_in_tool_names` should already be set; keep it, so external and Work IQ tools do not collide.
- Give each server a distinct `name`; use it to scope the connection (directory, DB, repo).
- Prefer **stdio** for local tools and **streamable-HTTP** for remote ones. Set a connect timeout and a tool-list cache where the SDK supports it.
- Connect before the first run and keep connections alive for the host/session lifetime.
  Close them during shutdown and if startup fails later. Do not retain a previous
  user's Work IQ clients on the shared base agent.
- A server that fails to connect or list tools is logged and left out; it must not stop the
  others. In Python and Node.js, check the servers before each run with the helper in
  `.a365-kit/shared/mcp-server-health.md`.
- Secrets (tokens, connection strings) go in `.env` and are read from the environment -- never hard-coded, never printed.

## Phase 2 -- Verify

1. Import/build check: the agent module still loads.
2. Start the agent (or `test-local`) and confirm the new server's tools list without error. Watch for a non-zero tool count from that server.
3. Run the validator: `node .a365-kit/hooks/stop/validate-add-mcp-server.js`.
4. If hosted, restart -- new servers are attached at startup.

## Phase 3 -- Governance (do not skip)

Tell the user plainly:

- This add-on does **not register or verify the capability in the Agent 365 registry**.
  Record direct connections in your team's inventory. Separately registered custom remote
  MCP can be governed through the documented BYO flow; registration/approval and use of
  its supported gateway path must be verified separately.
- The server runs with the **host's** privileges (stdio) or against whatever the URL/credentials allow (HTTP). A filesystem server scoped to `/` or a Postgres server with a write role is a real exposure.
- Tool output is **untrusted model input**. A fetched page or database row can carry a prompt
  injection. The DLP add-on's two hooks cover the prompt/final reply, not all tool content.
  They do not make external MCP calls Entra-governed or prevent arbitrary tool-side egress.

## Summary to show the user

```
Server      <name>   <stdio cmd | http url>   scope: <dir/db/repo>
Transport   stdio (npx/uvx) | streamable-http
Agent       mcp_servers <before> -> <after>   (Work IQ preserved)
Governance  Direct path; Agent 365 registration/consent not configured; server auth is separate
Verified    tools listed; validator ok
Next        restart the host if it is running
```
