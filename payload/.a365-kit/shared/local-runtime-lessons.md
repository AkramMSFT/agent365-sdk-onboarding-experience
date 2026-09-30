# Verified local-runtime corrections

Lessons recorded while onboarding real agents with this kit, contributed by Gerard
Salvador López (September 2026). Apply these corrections before following older command
snippets or language recipes. The installed CLI's help
and actual SDK contracts take precedence over remembered flags. These are reusable
lessons, not permission to copy another tenant's identities, tokens or policy settings.

## Choose the right workspace

The kit installs into an existing agent project; that is the primary path. If you are
starting from one of the repository's examples, prepare exactly one into a new directory
with `tools/prepare-workspace.mjs`. For the extended .NET local workflow, choose
`dotnet-agent365-lab`; it includes executable offline
checks and opt-in Teams, Work IQ, Purview and mailbox patterns. Keep an existing
agent's framework. Do not replace its logic just to match a sample.
The extended starter ships optional host/telemetry code before any identity is
configured. Treat those integrations as partial until runtime configuration and
the corresponding verification exist; do not skip onboarding from symbols alone.
Java, Go and Rust console examples are also available. Java needs a deliberate
adapter to the kit's Java hosting guidance; Go/Rust are manual-integration stacks.
Never treat an unknown-language validator's `ok` as successful onboarding, and
never silently replace one of these agents with another language/framework.

## Identity is not one ID

Distinguish the interactive management client, blueprint application, blueprint
service principal object, child agent identity, agent user, human operator, and
Purview protected-app location. Record how each value was obtained.

- Verify the active account and tenant before tenant operations; a cached sign-in
  is not proof it is the account the user requested.
- Re-read effective identity settings after endpoint registration and publishing.
  CLI operations can restamp the blueprint ID into an `AgentId` field or omit a
  previously generated child ID. Do not hand-repair generated manifests/configuration.
  Verify the child in Entra, including its parent blueprint, and keep any necessary
  runtime override in a separate git-ignored local configuration.
- Reject a blueprint ID used as its own child in the FMI/OBO exchange.
- Hosting, a tooling manifest, Teams publication, or a package-format flag alone
  must not silently convert a confirmed system agent into an AI Teammate.
- Never invent identifiers or mark cached capabilities complete based only on a
  symbol, a package reference, or a nonempty file.
- Re-running `setup all` can issue another secret even when the blueprint is reused.
  Inspect state and use the appropriate granular command instead of repeatedly
  provisioning to repair a token, consent or endpoint problem.

## Authentication and consent

- Run setup commands from the prepared workspace through
  `node .a365-kit/run-a365.mjs setup ...`, preserving all approved CLI arguments.
  The guarded runner keeps failures nonzero and prints the recovery steps for
  the specific `maven-prod [Agent365.Observability.OtelWrite]` administrator handoff.
  If you ran `a365` directly and see that message, do not rerun provisioning just to
  display help. Follow the `grant-observability-access` add-on:
  `node .a365-kit/grant-observability.mjs --check` reports what is missing, and an
  administrator grants it with `--grant`. Include the blueprint as a principal when the
  exporter signs in with the blueprint's client secret (Java, Go, Rust). An access package
  (`.a365-kit/shared/observability-access-package.md`) is the alternative when the tenant
  wants approvals and expiry. Do not mark setup or observability complete until `--check`
  reports every grant, whatever the CLI exit code.
- Check available flags with `a365 ... --help`. Do not assume every command has
  `--device-code`; the token command does, while other commands may not.
- Display device codes promptly. After a timeout, refresh only the failed resource.
  Do not hide later codes inside a long multi-resource background job.
- `AADSTS65002` for a Microsoft-to-Microsoft client/resource pairing is a
  preauthorization restriction, not something tenant admin consent fixes.
  Use a reviewed tenant-owned client when supported; do not modify the Microsoft-
  managed application's registration.
- A role and a token permission are separate prerequisites. Recheck active/PIM
  roles when permission writes fail; yesterday's Global Administrator session
  may no longer be active. Never grant management permissions to the runtime agent.
- Avoid Windows native-command JSON quoting mistakes: use a reviewed JSON file or
  an SDK/native HTTP API. Preserve unrelated grants and distinguish AllPrincipals
  from Principal grants.
- Prefer device authentication when WAM is broken. Security & Compliance PowerShell
  and Graph PowerShell have different parameter sets; do not copy flags between them.
  The installed Exchange module can use its underlying Connect-ExchangeOnline
  device path with the Security & Compliance connection URI.
- Local bearer files are bootstrap artifacts, not a long-running credential strategy.
  Renew from a supported encrypted cache scoped to the exact approved client,
  tenant and user where possible. Validate renewed identity/audience/scopes/expiry;
  fail explicitly rather than switching accounts. If renewal fails, request sign-in.

## Work IQ

Always use the live catalog for exact names, endpoints, audiences and scopes.
Discovery, permission grants, token acquisition, tool execution and delivery are
different checks.

- Group human-token requests by audience and request the union of enabled scopes.
  Refreshing one server must not remove scopes needed by an enabled peer.
- If a service reports blocked-by-admin, do not bypass that policy. If a catalog
  endpoint returns nonexistent, do not invent a replacement. Offer explicit local
  disablement while preserving the manifest; surface disabled services at startup.
- Namespace tools by source server. Preserve the underlying schema and dispatch,
  enforce provider name limits and detect collisions after normalization.
- Preserve existing local/lab tools. Never replace the tool collection.
- One failing MCP server must not stop the others. The OpenAI Agents SDK (Python and
  Node.js) and Agent Framework fail the whole run when one server cannot connect or list
  tools. Check the servers before each run and pass on the healthy ones; see
  `mcp-server-health.md`.
- Keep certificate validation enabled, constrain credential-bearing endpoints,
  and dispose MCP clients per turn. The pinned .NET SDK's development transport
  disables certificate validation; the extended example overrides transport
  creation rather than weakening TLS.
- Explicit Streamable HTTP avoids an old MCP auto-detection disposal exception
  hiding the actual HTTP error. GET 405 can be normal for an optional event stream;
  a failed initialization POST must still be reported.
- Log tool names and outcome/error status, not arguments, email content, tokens
  or full results. A model's claim about licensing is not a service error.

## Telemetry

The ingestion URL/`gen_ai.agent.id` must match the token's `azp`/`appid`.
A human CLI-client token cannot export on behalf of a different child agent.
Use the real blueprint-to-child FMI exchange and OBO user assertion for an OBO
agent; do not relabel traces as the CLI client or switch to S2S to evade a failure.

Register the actual model/tool instrumentation plus agent scopes and baggage.
Do not record sensitive prompts/results by default. Drain the exporter before exit.
A flush or HTTP 200 alone is not delivery: inspect rejection/routing receipts and
report rejected/not-routed responses as failures. Portal visibility is a separate check.
Do not edit SDK URL paths as a speculative workaround.

## Teams

- Use a new host/thin adapter around the existing agent logic. Reuse factories,
  tools and error handling; keep offline CLI modes.
- JWT-protect `/api/messages` in every environment, even if the CLI-generated
  TokenValidation.Enabled value is false. Health can be public. Prove local and
  public health 200, unsigned/invalid messages 401.
- The Messaging Bot API service can deliver an Entra token in the user's tenant.
  Its application ID is `5a807f24-c9de-44ee-a3a7-329e88a00ffc`; its service-principal
  object ID is not the human sender. Trust only validated, known delivery paths,
  and separately validate the allowed human, tenant, channel and reply endpoint.
- Never lend a local operator's tokens to arbitrary Teams users. The extended
  example is deliberately single-user. Multi-user hosting requires per-user auth.
- Acknowledge trusted system lifecycle events without invoking the model/tools.
- Configure the tunnel port as HTTP for a plain-HTTP local host. Read the public
  URL from the actual tunnel output; do not derive it from the tunnel name.
- Register the endpoint using the installed CLI's supported M365 path. An endpoint
  alone is not Teams availability: verify Developer Portal, package, upload,
  activation, and an actual authenticated reply.
- On the recorded CLI version, `publish --use-blueprint` produced no package;
  `publish --aiteammate true` selected the required package format. Inspect current
  help/dry-run and verify the stored identity mode afterwards; never assume the
  flag is universally a harmless format switch.
- Stop/restart only the process this session owns. Keep host and tunnel attached
  unless the user explicitly requests survival after the session ends.

## Agent mail

Ask who should send: the human caller or the agent's own mailbox. A licensed agent
user does not help if Mail tools authenticate as the human.

For an agent mailbox, verify the agent user's `identityParentId`, the linked
instance's blueprint, and Exchange service-plan provisioning. Use the SDK's
`IAgenticTokenProvider.GetAgenticUserTokenAsync`; validate the resulting user and
client identities. Do not fall back to a human mailbox on failure. Scope a Mail-only
identity change explicitly; it does not silently change other tools or DLP identity.

Prefer workload-specific Mail tools over generic Copilot chat. Ask for missing
recipient/subject/body details. Never infer a license failure without a real tool
error, and never claim sending or delivery without evidence.

Verify a send only with user approval. Distinguish proposed tool call, invocation,
successful result, Sent Items, transport handoff, and recipient Inbox placement.
A trace marked Delivered with `250 Recipient OK` can still end in Junk/quarantine.
Inspect the exact diagnostic message and do not resend automatically.

## Purview

Use Microsoft's `purview-dlp-integration` skill and its guard, scripts and wiring,
and read `.a365-kit/shared/purview-kit-notes.md` before its Step 2. Do not store a
blocked reply in conversation history. Collection and HTTP 200 do not demonstrate
inline blocking; a synthetic matching prompt blocked before the model call does.
An existing policy is inspected, never overwritten. Prompt checks are not a
tool-boundary firewall and cannot undo a tool's side effects.
