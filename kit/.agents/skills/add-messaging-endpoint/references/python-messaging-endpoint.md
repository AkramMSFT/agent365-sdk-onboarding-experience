# Python hosting layer for a blueprint-based Agent 365 agent

Verified 2026-09-04 against `microsoft-agents` 1.6.0 and `microsoft-opentelemetry` 1.3.8 on a real
tenant: health 200, anonymous POST 401, and an agent answering in Teams. The host below is the
later audited revision of that pattern.

The original recipe was verified 2026-09-04 against `microsoft-agents` **1.6.0** and
`microsoft-opentelemetry` **1.3.8** on a tenant. This revision is checked with those SDK
versions in isolated offline fixtures: imports, mocked model callbacks, health 200,
anonymous POST 401 and startup/shutdown. The new adapter/lifecycle changes are **not**
claimed to be live-tenant verified.

> **Why not copy the AI Teammate host?** The Python host `make-ai-teammate` generates uses
> `CloudAdapter.on_activity`, `adapter.authorization` and `MsalConnectionManager.from_environment()`.
> None exist in `microsoft-agents` 1.6.x; that host crashes on startup with
> `AttributeError: type object 'MsalConnectionManager' has no attribute 'from_environment'`.
> The pattern below is the 1.6 one: `AgentApplication` + `start_agent_process` + `jwt_authorization_middleware`.

## Dependencies

Append to `requirements.txt` (or `pyproject.toml`) **and install**:

```
microsoft-agents-hosting-aiohttp>=1.6.0
microsoft-agents-authentication-msal>=1.6.0
```

`microsoft-opentelemetry`, `microsoft-agents-a365-tooling*` and `microsoft-agents-a365-runtime` should already be present from onboarding. If `import` fails on `microsoft_agents_a365.runtime`, add `microsoft-agents-a365-runtime>=1.0.0` -- the tooling wheel imports it without declaring it.

## Files

Four new files. **Do not edit the agent module the onboarding skills produced** (`src/agent.py` in the verified project); import it.

### `turn_replies.py` (project root)

Copy the Python helper from `.a365-kit/shared/turn-replies.md`. The host below sends its
replies when a turn fails, so a refused or filtered prompt gets a refusal and any other error
gets an apology, never the exception text.

### `agent_interface.py` (project root)

```python
from abc import ABC, abstractmethod
from microsoft_agents.hosting.core import Authorization


class AgentInterface(ABC):
    @abstractmethod
    async def initialize(self) -> None: ...

    @abstractmethod
    async def process_user_message(
        self, message: str, auth: Authorization, auth_handler_name: str | None, context
    ) -> str: ...

    @abstractmethod
    async def cleanup(self) -> None: ...
```

### `src/a365_agent.py` -- the adapter

Wraps the existing OpenAI agent. Substitute the module (`src.agent`) and agent object
(`expenses_agent`) after reading the consuming project. `setup_workiq_tools` is **not** a
standard upstream-generated API. Use the optional Work IQ method below when Work IQ exists.
Other model frameworks need an equivalent adapter, not an OpenAI `Runner` pasted into them.

```python
import logging
from contextlib import AsyncExitStack
import src.agent as core            # importing it initialises observability
from agents import Runner            # OpenAI Agents SDK; use your framework's runner
from agent_interface import AgentInterface

logger = logging.getLogger(__name__)


class HostedAgent(AgentInterface):
    def __init__(self):
        self._base_agent = core.expenses_agent
        self._connections = AsyncExitStack()

    async def initialize(self) -> None:
        try:
            for server in self._base_agent.mcp_servers or []:
                await self._connections.enter_async_context(server)
        except BaseException:
            await self._connections.aclose()
            raise

    async def _model_reply(self, agent, message: str) -> str:
        result = await Runner.run(agent, message)
        return str(result.final_output) if result.final_output is not None else "Sorry, I couldn't get a response."

    async def process_user_message(self, message, auth, auth_handler_name, context) -> str:
        return await self.process_local_message(message)

    async def process_local_message(self, message: str) -> str:
        agent = self._base_agent.clone(mcp_servers=list(self._base_agent.mcp_servers or []))
        return await self._model_reply(agent, message)

    async def cleanup(self) -> None:
        await self._connections.aclose()
```

`initialize` and `cleanup` run on the same host-startup task. The base agent must contain
only its static local/external tools, never a previous user's Work IQ clients. If another
component already owns those static connections, reuse its lifecycle rather than connecting
them twice.

**When Work IQ is present**, replace only `HostedAgent.process_user_message` with this
method (inside that class). It uses the actual OpenAI extension API, retains all base-agent
options/guardrails, and closes per-turn connections on the task that opened them:

```python
async def process_user_message(self, message, auth, auth_handler_name, context) -> str:
    if auth is None or context is None or not auth_handler_name:
        return await self.process_local_message(message)
    from microsoft_agents_a365.tooling.extensions.openai.mcp_tool_registration_service import McpToolRegistrationService

    base = self._base_agent
    existing = list(base.mcp_servers or [])
    service = McpToolRegistrationService()
    attached = base.clone(mcp_servers=existing)
    try:
        attached = await service.add_tool_servers_to_agent(
            agent=attached, auth=auth, auth_handler_name=auth_handler_name, context=context)
        cfg = {**(base.mcp_config or {}), "include_server_in_tool_names": True}
        turn_agent = base.clone(mcp_servers=list(attached.mcp_servers or []), mcp_config=cfg)
        return await self._model_reply(turn_agent, message)
    finally:
        for server in reversed(attached.mcp_servers or []):
            if not any(server is old for old in existing):
                try:
                    await server.cleanup()
                except Exception:
                    logger.warning("Work IQ connection cleanup failed", exc_info=True)
```

Do not store `attached` or `turn_agent` in `core.expenses_agent`: doing so reuses the first
caller's tools/credentials in later turns. S2S Work IQ needs its detected token strategy;
the method above is the delegated OBO/agentic-user branch, not an S2S implementation.

### `host_agent_server.py` (project root)

```python
from __future__ import annotations
import asyncio, json, logging, os
from contextlib import suppress
from typing import Type
from dotenv import load_dotenv
load_dotenv()

import src.agent as core  # FIRST: runs use_microsoft_opentelemetry() before aiohttp imports

from aiohttp import web
from microsoft_agents.activity import ActivityTypes, load_configuration_from_env
from microsoft_agents.authentication.msal import MsalConnectionManager
from microsoft_agents.hosting.aiohttp import CloudAdapter, jwt_authorization_middleware, start_agent_process
from microsoft_agents.hosting.core import AgentApplication, ApplicationOptions, AuthHandler, Authorization, MemoryStorage, TurnState
from microsoft.opentelemetry.a365.core import AgentDetails, CallerDetails, Channel, InvokeAgentScope, InvokeAgentScopeDetails, Request, UserDetails
from microsoft.opentelemetry.a365.core.middleware.baggage_builder import BaggageBuilder
from microsoft.opentelemetry.a365.hosting import ObservabilityHostingManager, ObservabilityHostingOptions
from agent_interface import AgentInterface
from turn_replies import reply_for_error, send_turn_error

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

AUTH_HANDLER_NAME = os.getenv("AUTH_HANDLER_NAME", "AGENTIC")   # matches AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__<NAME>__* in .env
AGENT_NAME = os.getenv("AGENT365OBSERVABILITY__AGENTNAME", "My Agent")
AGENT_BLUEPRINT_ID = os.getenv("AGENT365OBSERVABILITY__AGENTBLUEPRINTID", "")
TENANT_ID_FALLBACK = os.getenv("AGENT365OBSERVABILITY__TENANTID", "")
AGENT_ID_FALLBACK = os.getenv("AGENT365OBSERVABILITY__AGENTID", "")


def _attr(obj, name, default=None):
    v = getattr(obj, name, None)
    return default if v is None else v


def _patch_a365_middleware_arity(middleware_set) -> None:
    """hosting-core calls the next middleware as logic(ctx); microsoft-opentelemetry's A365
    middleware calls logic() -- every inbound activity dies with 'missing ... ctx'. Wrap each
    middleware so logic tolerates both. Idempotent; a no-op once the packages agree."""
    for mw in getattr(middleware_set, "_middleware", []):
        orig = getattr(mw, "on_turn", None)
        if orig is None or getattr(mw, "_a365_arity_patched", False):
            continue
        def _wrap(original):
            async def patched(context, logic):
                async def flexible(ctx=None):
                    await logic(context if ctx is None else ctx)
                await original(context, flexible)
            return patched
        mw.on_turn = _wrap(orig)
        mw._a365_arity_patched = True


class GenericAgentHost:
    def __init__(self, agent: AgentInterface):
        self._agent = agent
        self._adapter: CloudAdapter | None = None
        self._app: AgentApplication | None = None

    def _build_authorization_handlers(self) -> dict[str, AuthHandler] | None:
        if not AUTH_HANDLER_NAME:
            return None
        p = f"AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__{AUTH_HANDLER_NAME}__SETTINGS__"
        scopes = os.getenv(p + "SCOPES", "https://graph.microsoft.com/.default")
        return {AUTH_HANDLER_NAME: AuthHandler(
            name=AUTH_HANDLER_NAME,
            auth_type=os.getenv(p + "TYPE", "AgenticUserAuthorization"),
            scopes=[s.strip() for s in scopes.split(",") if s.strip()],
        )}

    @property
    def _authorization(self) -> Authorization | None:
        return getattr(self._app, "auth", None)

    def _setup_handlers(self) -> None:
        app = self._app
        auth_handlers = [AUTH_HANDLER_NAME] if AUTH_HANDLER_NAME else None

        @app.conversation_update("membersAdded")
        async def on_members_added(context, state: TurnState):
            rid = _attr(context.activity.recipient, "id")
            for m in context.activity.members_added or []:
                if m.id != rid:
                    await context.send_activity("Hello! How can I help?")

        @app.activity(ActivityTypes.message, auth_handlers=auth_handlers)
        async def on_message(context, state: TurnState):
            await self._run_turn(context, context.activity.text or "")

    async def _run_turn(self, context, text: str) -> None:
        logger.info("process_user_message called")
        a = context.activity
        recipient, sender = _attr(a, "recipient"), _attr(a, "from_property")
        tenant_id = _attr(recipient, "tenant_id") or TENANT_ID_FALLBACK
        agent_id = _attr(recipient, "agentic_app_id") or AGENT_ID_FALLBACK
        if not agent_id:
            logger.warning("No agent instance id is available for turn telemetry; check Agent365Observability configuration")
        conversation_id = str(_attr(_attr(a, "conversation"), "id", "") or "")
        channel_name = str(_attr(a, "channel_id", "unknown"))

        agent_details = AgentDetails(agent_id=agent_id, agent_name=AGENT_NAME,
                                     agent_description=os.getenv("AGENT365OBSERVABILITY__AGENTDESCRIPTION", ""),
                                     agent_blueprint_id=AGENT_BLUEPRINT_ID, tenant_id=tenant_id)
        caller = CallerDetails(user_details=UserDetails(user_id=str(_attr(sender, "id", "")),
                                                        user_name=str(_attr(sender, "name", "")),
                                                        user_email=str(_attr(sender, "email", "") or "")))
        request = Request(content=text, session_id=conversation_id or "session",
                          conversation_id=conversation_id or "conversation", channel=Channel(name=channel_name))

        # Register an OBO-exchanged token for the span exporter on each turn. Observability setup
        # wires AgenticTokenCache as the resolver, but nothing registers a token without this.
        if AUTH_HANDLER_NAME and tenant_id and agent_id and self._authorization is not None:
            try:
                from microsoft.opentelemetry.a365.hosting.token_cache_helpers import AgenticTokenStruct
                from microsoft_agents_a365.runtime.environment_utils import get_observability_authentication_scope
                core._token_cache.register_observability(agent_id, tenant_id,
                    AgenticTokenStruct(authorization=self._authorization, turn_context=context, auth_handler_name=AUTH_HANDLER_NAME),
                    get_observability_authentication_scope())
            except Exception as err:
                logger.warning("Observability token not registered for this turn: %s", err)

        typing = True
        async def typing_loop():
            while typing:
                try:
                    await context.send_activity({"type": "typing"})
                except Exception:
                    logger.debug("Typing activity failed", exc_info=True)
                    return
                await asyncio.sleep(4)
        task = asyncio.create_task(typing_loop())
        try:
            baggage = (BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id)
                       .agent_blueprint_id(AGENT_BLUEPRINT_ID).agent_name(AGENT_NAME).channel_name(channel_name))
            if conversation_id: baggage = baggage.conversation_id(conversation_id)
            u = caller.user_details
            if u.user_id: baggage = baggage.user_id(u.user_id)
            if u.user_name: baggage = baggage.user_name(u.user_name)
            with baggage.build():   # baggage MUST wrap the scope or spans partition into "0 identity groups"
                with InvokeAgentScope.start(request, InvokeAgentScopeDetails(), agent_details, caller) as scope:
                    scope.record_input_messages([text])
                    reply = await self._agent.process_user_message(text, self._authorization, AUTH_HANDLER_NAME or None, context)
                    scope.record_output_messages([reply])
            await context.send_activity(reply)
        except Exception as error:
            logger.exception("turn failed")
            await context.send_activity(reply_for_error(error))
        finally:
            typing = False
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    async def start_server(self) -> None:
        await self._agent.initialize()
        runner = None
        try:
            cfg = load_configuration_from_env(os.environ)        # CONNECTIONS__* / CONNECTIONSMAP__*
            cm = MsalConnectionManager(**cfg)
            self._adapter = CloudAdapter(connection_manager=cm)
            # The SDK's default hook sends the raw exception text to the user.
            self._adapter.on_turn_error = send_turn_error
            ObservabilityHostingManager.configure(self._adapter.middleware_set, ObservabilityHostingOptions(enable_baggage=True))
            _patch_a365_middleware_arity(self._adapter.middleware_set)
            self._app = AgentApplication[TurnState](
                ApplicationOptions(adapter=self._adapter, storage=MemoryStorage(),
                                   authorization_handlers=self._build_authorization_handlers()),
                connection_manager=cm, **cfg)
            self._setup_handlers()

            @web.middleware
            async def _auth_except_health(request: web.Request, handler):
                if request.path.rstrip("/") == "/api/health":
                    return await handler(request)
                return await jwt_authorization_middleware(request, handler)

            web_app = web.Application(middlewares=[_auth_except_health])
            web_app.router.add_post("/api/messages", self._handle_messages)
            web_app.router.add_get("/api/health", self._handle_health)
            web_app["agent_configuration"] = cm.get_default_connection_configuration()   # NOT the raw dict
            web_app["agent_app"] = self._app
            web_app["adapter"] = self._adapter

            port = int(os.getenv("PORT", "3978"))
            runner = web.AppRunner(web_app)
            await runner.setup()
            await web.TCPSite(runner, "0.0.0.0", port).start()
            logger.info("listening on http://localhost:%s/api/messages", port)
            await asyncio.Event().wait()
        finally:
            try:
                if runner is not None:
                    await runner.cleanup()
            finally:
                await self._agent.cleanup()

    async def _handle_messages(self, request: web.Request) -> web.Response:
        try:
            return await start_agent_process(request, self._app, self._adapter)
        except Exception:
            logger.exception("[/api/messages] agent process raised")
            return web.Response(status=500, text=json.dumps({"error": "Internal server error"}), content_type="application/json")

    async def _handle_health(self, request: web.Request) -> web.Response:
        return web.json_response({"status": "healthy", "agent": AGENT_NAME})


def create_and_run_host(agent_class: Type[AgentInterface]) -> None:
    asyncio.run(GenericAgentHost(agent_class()).start_server())


if __name__ == "__main__":
    from src.a365_agent import HostedAgent
    create_and_run_host(HostedAgent)
```

## Run and verify

```bash
python -u host_agent_server.py                 # -u: unbuffered logs
curl -s http://localhost:3978/api/health       # {"status": "healthy", ...}
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3978/api/messages -H "Content-Type: application/json" -d '{"type":"message","text":"hi"}'   # 401
```

## Dev tunnel: take the URL from `devtunnel host`, never from the name

```bash
devtunnel create <agent>-tunnel --allow-anonymous
devtunnel port create <agent>-tunnel -p 3978 --protocol http
devtunnel host <agent>-tunnel            # prints:  Connect via browser: https://<id>-3978.<cluster>.devtunnels.ms
```

Use exactly the `Connect via browser` URL for `--update-endpoint`. The **cluster** (`aue`, `asse`, `usw3`, …) is assigned when the tunnel is created and a deleted-and-recreated tunnel can land in a different one, so a URL built from the tunnel *name* silently stops resolving. Seen on the verified run: the first tunnel was `…tunnel.aue`, the recreated one `…tunnel.asse`, and the registered `aue` endpoint went dark. **If the tunnel is ever recreated, re-run `a365 setup blueprint --update-endpoint <new url> --m365`.**

## Work IQ tools: three things that silently break them

Both verified on a live tenant, 2026-09-04. Neither is set by `a365 setup all` or by `add-workiq-tools`, and both fail in ways that look like a permissions problem when they are not.

### 1. `PYTHON_ENVIRONMENT` must be set, or every MCP server returns 401

Two modules in the same SDK disagree about the default environment:

| Function | Default when no env var is set |
|---|---|
| `microsoft_agents_a365.runtime.…is_development_environment()` | **Production** |
| `microsoft_agents_a365.tooling.utils.utility.is_development_environment()` | **Development** |

The tooling module resolves `PYTHON_ENVIRONMENT` → `ENVIRONMENT` → `ASPNETCORE_ENVIRONMENT` → `DOTNET_ENVIRONMENT`, and falls back to `"Development"`. Nothing writes any of them, so a production agent takes the development path: it loads servers from the local manifest instead of the gateway, and acquires tokens from `BEARER_TOKEN_*` env vars that do not exist. No token is attached and **every** Work IQ server answers `401`.

```
PYTHON_ENVIRONMENT=Production
```

The symptom is maximally misleading: consent is correct, `a365 query-entra inheritance` reports OK, the OBO exchange returns a valid token when called directly, and the agent simply says it has no tools. Two tells in the log:

```
Listing MCP tool servers for agent            <- agent id EMPTY (dev mode sets it to "")
Loading MCP servers from: ToolingManifest.json <- manifest, not the gateway
```

### 2. Several servers together collide on tool names

SharePoint and OneDrive both publish `getFileOrFolderMetadataByUrl` and `getSensitivityLabels`. The OpenAI Agents SDK refuses duplicates and raises `UserError: Duplicate tool names found across MCP servers`, which fails the whole turn. Namespace them **after** attachment, because `add_tool_servers_to_agent` returns a fresh `Agent`:

```python
# Place this inside the per-turn adapter method, after attachment.
cfg = {**(base.mcp_config or {}), "include_server_in_tool_names": True}
turn_agent = base.clone(mcp_servers=list(attached.mcp_servers or []), mcp_config=cfg)
```

Tools then appear as `mcp_MailTools_sendMail` and so on.
Keep this clone local to the turn, preserving all options from `base`; do not overwrite the
shared module-level agent or cache delegated server connections across users.

### 3. The model will not use tools its instructions never mention

With both fixes in place the tools attach, and the agent can still answer *"I'm only set up to help with expense reports"* — because its system prompt describes a narrow job. Tools are necessary, not sufficient. Say so in the instructions:

> Work IQ tools are attached for mail, calendar, Teams, SharePoint, OneDrive and Excel. Tool names are prefixed with their server, e.g. `mcp_MailTools_*`. Use them when the user asks you to send an email, check a calendar, or look something up. Sending mail on request is expected — do it rather than telling the user to use Outlook.

### Not every server will be healthy

On the verified tenant seven of nine attached; `mcp_PlannerServer` returned `404` and `mcp_WordServer` `403`. That is per-tenant provisioning, not a code fault. The `400` and `405` responses in the log are part of the normal MCP handshake. Judge success by the `Attached N WorkIQ MCP server(s)` line, not by absence of non-200s. A
server that fails during a turn still fails the whole run unless the per-server check from
`.a365-kit/shared/mcp-server-health.md` is in place.

## Gotchas seen on the verified run

| Symptom | Cause |
|---|---|
| `AttributeError ... from_environment` | Host written against pre-1.6 SDK. Use the pattern above. |
| Every request 500s | `web_app["agent_configuration"]` was the raw env dict; it must be `cm.get_default_connection_configuration()`. |
| `missing 1 required positional argument: 'ctx'` on every turn | Middleware arity mismatch; `_patch_a365_middleware_arity` handles it. |
| `AssertionError` in `find_dotenv` when running from stdin | `load_dotenv()` walks the caller frame; pass `load_dotenv(".env")` or run from a file. |
| Port already in use | Another agent on the machine. Set `PORT` in `.env`; use that port for the tunnel. |
| Health JSON shows the *identity* name | `AGENT365OBSERVABILITY__AGENTNAME` holds the identity display name; cosmetic. |
