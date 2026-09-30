# Attribution and modifications

## Bundled third-party content

This kit redistributes **[microsoft/agent365-skills](https://github.com/microsoft/agent365-skills)**.

> Copyright (c) Microsoft Corporation.
> Licensed under the MIT License.

The bundled version and the exact upstream commit are recorded in `.a365-kit/KIT-VERSION.json` in every build.

Everything under `.a365-kit/skills/`, `.a365-kit/shared/`, `.a365-kit/hooks/` and `.a365-kit/copilot-instructions.md` originates upstream, except these kit-authored files, whose source is `payload/` in this repository:

- the launchers `agent365-kit.ps1` and `agent365-kit.sh`, and `AGENT365-KIT-README.md`
- in `.a365-kit/`: `doctor.js`, `kit-version.js`, `run-a365.mjs`, `grant-observability.mjs`, `lib/`, `settings-fragment.json`, `KIT-VERSION.json` and `addons/`
- `.a365-kit/hooks/lib/` and five validators in `.a365-kit/hooks/stop/`: `validate-add-java-agent.js`, `validate-add-lab-tools.js`, `validate-add-mcp-server.js`, `validate-add-messaging-endpoint.js` and `validate-test-local-channel.js`
- `.a365-kit/shared/local-runtime-lessons.md`, `.a365-kit/shared/observability-access-package.md` and `.a365-kit/shared/purview-kit-notes.md`
- the "Kit add-ons" section at the end of `.a365-kit/copilot-instructions.md`

Every build ships Microsoft's licence as `.a365-kit/LICENSE-agent365-skills`, the kit's licence as `.a365-kit/LICENSE`, and this notice as `.a365-kit/NOTICE.md`.

---

## Modifications made when repackaging

The goal is a faithful repackage. Sections 1 to 7 are packaging changes: they exist because the upstream files assume a plugin install, which is false in a drop-in install. Sections 8 onward correct defects, and each names the failure it prevents. All are applied mechanically by `build/Build-Kit.ps1` and `build/upstream-fixups.json`, and each asserts upstream's exact text, so an upstream rewording fails the build instead of shipping a stale patch.

### 1. `${CLAUDE_PLUGIN_ROOT}` path tokens

`${CLAUDE_PLUGIN_ROOT}` is set by the host only when skills load as a plugin. In a drop-in install it is unset, so every path built from it resolves to nothing.

Because `.a365-kit/` mirrors the upstream layout exactly (`skills/`, `shared/`, `hooks/`), one substitution fixes every in-body reference:

```
${CLAUDE_PLUGIN_ROOT}/shared/agent-detection.md   ->   .a365-kit/shared/agent-detection.md
```

These are prose instructions the model resolves with its own file tools, and a project-relative path works regardless of whether the host expands variables in skill content.

### 2. Hook commands

Hook `command:` values are executed by the host, so they need an absolute path. These get `${CLAUDE_PROJECT_DIR}` instead, which Claude Code expands reliably, quoted so paths containing spaces survive:

```yaml
# before
command: node ${CLAUDE_PLUGIN_ROOT}/hooks/stop/validate-a365-setup.js
# after
command: node "${CLAUDE_PROJECT_DIR}/.a365-kit/hooks/stop/validate-a365-setup.js"
```

### 3. `path-guard.js`: restoring a guard that would otherwise disable itself

Upstream refuses writes inside `CLAUDE_PLUGIN_ROOT`, so skills cannot rewrite their own instructions. That check is conditional on the variable being set:

```js
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
  ? safeRealpath(path.resolve(process.env.CLAUDE_PLUGIN_ROOT))
  : null;   // <- drop-in install lands here; the guard silently switches off
```

The kit adds a fallback to the kit folder inside the project. The environment variable is still honoured first, so the file behaves identically if it ever *is* loaded as a plugin. The block message was updated to name the kit folder rather than an environment variable the user never set.

This is the one change with a security consequence, and it makes the drop-in install **more** protective than it would otherwise be, not less. Verified with four cases: writing into the kit blocks, writing outside the project blocks, writing to agent source is allowed, and non-write tools pass through.

### 4. `/agent365:` command namespace

Upstream instructs the user to re-run skills as `/agent365:<name>`. That namespace is created by installing the plugin. Project skills are invoked as `/<name>`, so `/agent365:make-ai-teammate` becomes `/make-ai-teammate`. CLIs other than Claude Code use trigger phrases and ignore slash commands entirely.

This is applied to reference docs and validator scripts as well as `SKILL.md` files, because the validators print these strings back to the user in failure messages.

### 5. `scripts/check-version.js` replaced

Upstream's version check tells the user to run `gh skill add microsoft/agent365-skills`, the install path this kit exists to avoid. It is replaced by `kit-version.js`, which reports when Microsoft has published a newer skills release than the bundled one and points at re-downloading the kit. It is optional, silent when up to date or offline, and never blocks a session.

### 6. `copilot-instructions.md` relocated

Staged at `.a365-kit/copilot-instructions.md` rather than shipped at `.github/copilot-instructions.md`. That file is commonly project-owned, and an archive extraction would overwrite it with no warning. The launcher's `-WireCopilot` flag creates it, or appends to an existing one. Its relative links are repointed from `../plugins/agent365/...` to `../.a365-kit/...` so they resolve from `.github/`.

### 7. One wording fix-up

`a365-code-validator/SKILL.md` explains how to run its validator "from the plugin source", with a fallback for when the runtime cannot expand `${CLAUDE_PLUGIN_ROOT}`. After the substitution in (1) that passage no longer parses as English. It is rewritten to describe running from the project root, with an absolute-path fallback.

The build asserts this passage still matches upstream before patching it, so an upstream rewording fails the build rather than shipping a broken instruction.

### 8. `validate-make-ai-teammate.js`: one bug fix

This was the first modification that changes behaviour rather than paths, and it is called out here for that reason.

Upstream's `validate-make-ai-teammate.js` detects a Python project **only** by the presence of `pyproject.toml`:

```js
const hasPyproject  = fs.existsSync(path.join(cwd, 'pyproject.toml'));
```

Every sibling validator (`validate-instrument-observability.js`, `validate-add-workiq-tools.js`, `validate-test-local.js`, `validate-a365-code-validator.js`) accepts `requirements.txt` as well, and so does the skills' own stack detection. The result is that a `requirements.txt`-only Python project falls through to the Node.js default and fails eight TypeScript checks that do not apply to it: `src/index.ts not found`, `package.json not found`, `tsconfig.json not found`, and so on.

In Claude Code this validator runs as a **stop hook that refuses to end the session** until it passes, so a false negative is not cosmetic: it blocks the session. Three checks in this one file assume a layout that upstream's own `make-ai-teammate` skill does not enforce when it edits an existing project:

| Check | Upstream assumption | What the kit accepts instead |
|---|---|---|
| Language detection | Python ⇔ `pyproject.toml` exists | `pyproject.toml` **or** `requirements.txt`, matching every sibling validator |
| Check 2, `agent.py` | Must be at the project root | Root, or anywhere in the scanned tree (e.g. `src/agent.py`) |
| Check 4, dependencies | Read from `pyproject.toml` only, underscore-only names | `pyproject.toml` or `requirements.txt`, whichever exists; hyphen and underscore forms compared as equal, as pip treats them |

Without the first fix a `requirements.txt` project falls through to the Node.js default and fails eight TypeScript checks. With only the first fix, Check 4 would then read a `pyproject.toml` that does not exist. So the three are applied together. The *content* of each check (what must be present in `agent.py`, which packages are required) is unchanged.

Found 2026-09-03 while onboarding an existing Python / OpenAI Agents SDK project (`src/` layout, `requirements.txt`) through the kit: the skill adapted to the layout correctly and the validator then reported it as a failed Node.js project. Reported upstream.

### 9. `validate-instrument-observability.js`: exporter value, not just presence

The `a365` CLI stamps `ENABLE_A365_OBSERVABILITY_EXPORTER=false` into `.env`, and `instrument-observability` has an explicit invariant not to overwrite an existing value ("Preserve existing values … Add only missing keys"); it is meant to *warn* instead. Upstream's validator then checks only that the key **exists**:

```js
const hasEnvConfig = envFiles.some(f => fileContains(f, 'ENABLE_A365_OBSERVABILITY_EXPORTER'));
```

So an agent with the exporter switched off passes validation as fully instrumented, produces spans on every turn, and exports none of them. The Agent 365 Activity view stays empty with nothing anywhere reporting a fault.

The kit adds a value check to both the Node.js and Python branches: the validator fails unless the exporter is actually enabled. Since section 14 the message reads *"No enabled Agent 365 exporter found"* and names both the code option and the environment variable to check.

Found 2026-09-04 after several hours of live Teams traffic produced no activity. The instrumentation was correct throughout; only the last hop was disabled.

### 10. `instrument-observability/SKILL.md`: the skill now sets the exporter, not just reports it

Section 9 makes a disabled exporter visible. This makes the skill fix it.

Invariant 1 told the skill to preserve an existing `ENABLE_A365_OBSERVABILITY_EXPORTER`, and rule 6 told it to report that value back to the user when it was `false`. Because `a365 setup` stamps the key as `false` before this skill ever runs, the key always exists, so the preserve branch always won. The outcome of "add observability to my agent" was an agent correctly instrumented, building a span per turn, exporting none of them, with the fact recorded in one line of a long completion summary.

The kit rewrites three passages in the Node.js / Python path:

| Passage | Upstream | Kit |
|---|---|---|
| Invariant 1 | Preserve an existing exporter value | Preserve every value **except** the exporter switch; set that to `true` and say so |
| Rule 6 | Tell the user it is off and how to turn it on | Tell the user it was off and that you turned it on, and to restart |
| Phase 9 next steps | "Enable exporting when ready for production" | "Confirm the exporter is still on. This skill sets it, but a later `a365 setup` run can reset it to false" |

Upstream's own .NET path already does exactly this. Invariant 3 reads: *"`EnableAgent365Exporter: true` at the root. `a365 setup` may write `false`; this skill corrects it."* The Node.js and Python branches were inconsistent with .NET on the same decision, and the kit makes them agree.

This matters more outside Claude Code than inside it. The validator in section 9 runs as a stop hook, which only Claude Code honours; the kit ships no hook wiring for Copilot CLI, Cursor or Gemini CLI, so on those the validator never runs unless the reader invokes it. Fixing the skill rather than only the validator is what makes the behaviour identical on every CLI the kit supports.

Found and fixed 2026-09-04, alongside section 9. Reported upstream.


### 11. `references/python-observability.md`: the OBO token resolver must be synchronous

The Python OBO sample wires the exporter's token resolver like this:

```python
a365_token_resolver=_token_cache.get_observability_token,
```

`AgenticTokenCache.get_observability_token` is declared `async def`, and the exporter calls the resolver synchronously from its own batch-export thread:

```python
return self._token_resolver(agent_id, tenant_id)
```

So it receives an un-awaited coroutine rather than a token. The next guard is `if not token:`, but a coroutine object is **truthy**, so the one check that would have caught this passes. The exporter then builds `f"Bearer {token}"`, sending the literal text `Bearer <coroutine object AgenticTokenCache.get_observability_token at 0x...>`. The service cannot read a tenant out of that and answers:

```json
{"code":"EndpointInvalid","message":"Tenant id  is invalid.","innererror":{"code":"TenantIdInvalid"}}
```

The blank in *"Tenant id  is invalid"* is the tell: the tenant is unreadable, not absent from the agent's configuration. Chasing the configured `TENANTID`, which is correct, leads nowhere.

Upstream's own documentation already says what the contract is. Its kwarg table describes `a365_token_resolver` as a *"Sync callable `(agent_id, tenant_id) -> str | None`"*, and its S2S sample passes a sync lambda correctly. Only the OBO sample is wrong, and `AgenticTokenCache` exposes no sync accessor, so that sample cannot work as written.

The kit replaces it with a bridge that marshals the coroutine onto the host's event loop via `run_coroutine_threadsafe` and returns `None` on failure, so a telemetry fault never costs a turn. It is applied in three places, because any one alone leaves a way through:

| Where | Why it is needed |
|---|---|
| `references/python-observability.md` | The code the skill copies from. Also shows where to capture the loop: the per-turn handler the skill already wraps with `InvokeAgentScope`, so nothing outside the skill's own edits has to change. |
| `SKILL.md` | Read before any reference doc, and it stated the broken wiring outright. Fixing only the reference leaves the model with a contradiction and the wrong instruction first. |
| `validate-instrument-observability.js` | Catches the pattern in code already written, including agents onboarded before this kit version. Matches `a365_token_resolver=` bound directly to `get_observability_token`; the bridge mentions the same symbol and is correctly ignored. |

Leaving the captured loop unset is the one remaining way to get no telemetry, and unlike the original defect it is loud: the exporter logs `No token resolved for agent ...; dropping chunk` at ERROR on every export.

Found 2026-09-04 on a live Python OBO agent: the agent answered normally in Teams while every export was rejected. Verified fixed against the same tenant: `HTTP 200`, three spans, all sinks accepting. Reported upstream.


### 12. `instrument-observability`: the Node.js OBO path

Section 11 is Python-only. Node.js does not share that defect: its `AgenticTokenCacheInstance` splits the work that Python collapses into one `async def`, and the shipped types confirm the split.

```ts
getObservabilityToken(agentId, tenantId): string | null;   // sync cache read — the resolver
refreshObservabilityToken(...): Promise<void>;             // async, awaited once per turn
```

Passing the sync getter as `tokenResolver` is therefore correct on Node. But the split creates a different failure with the same outcome (an agent that traces and exports nothing), and `SKILL.md` walks into it twice.

**The cache is only filled per turn.** `tokenResolver` reads a cache that nothing populates unless `refreshObservabilityToken` is called at the start of each handler turn. Miss it and the resolver returns `''` on every export. Upstream instructs the call in Phase 4 and names the symptom in its own troubleshooting table, so this one is documented. Nothing verified it, however, and the two halves live in different phases.

**The method name is wrong in `SKILL.md`.** In the Phase 4 code sample, which a CLI copies verbatim, it writes `AgenticTokenCacheInstance.RefreshObservabilityToken` in PascalCase. The shipped API is `refreshObservabilityToken`, camelCase since GA 1.0, which upstream's own reference doc states explicitly at the top of its auth table. The PascalCase name is `undefined`, so the call throws a `TypeError` on the agent's first turn. Both occurrences are corrected.

The kit adds two validator checks for the OBO path: a `tokenResolver` reading the cache with no `refreshObservabilityToken` anywhere, and the PascalCase spelling. Verified across three states: refresh missing, refresh misspelled, refresh correct.

Found 2026-09-04 while confirming whether the section 11 fix left Node.js exposed. Reported upstream.


### 13. `validate-instrument-observability.js`: the .NET branch

.NET does not share the section 11 defect either, and this was verified by reflecting over the shipped assemblies rather than reading the docs:

```
delegate AsyncAuthTokenResolver(String agentId, String tenantId) -> Task<...>
Agent365ExporterOptions.TokenResolver : AsyncAuthTokenResolver
```

The resolver is async **by type**, so the exporter awaits it and the reference doc's `async (agentId, tenantId) => await tokenCache.GetObservabilityToken(...)` is correct. `AgenticTokenCache` has the same shape as Python's (sync `RegisterObservability`, async `GetObservabilityToken`), but because the delegate is declared async, there is no mismatch.

The .NET *instructions* are also the strongest of the three languages: invariant 3 already has the skill correct `EnableAgent365Exporter`, Phase 3 warns that without it "the exporter is wired but inert", and the per-turn `RegisterObservability()` call is spelled out in Phase 4. Nothing needed rewriting.

What was missing was verification. The validator's .NET branch checked only that `EnableAgent365Exporter` **exists**. That is the same defect section 9 fixed for Node.js and Python, left in place for .NET, so an agent with the exporter off passed as fully instrumented. And nothing checked the per-turn registration, so an OBO agent whose token cache is never filled also passed.

Both checks added. The exporter check requires `true` only in the root `appsettings.json`, matched by exact file name; `appsettings.Development.json` is *meant* to be `false` (invariant 3 says so) and is excluded. Verified across four states: exporter false, exporter true, a `false` Development file beside a `true` root, and a missing `RegisterObservability`.

Found 2026-09-04 while checking whether sections 11 and 12 left .NET exposed.

---

### 14. Environment-value validation: active settings, not comments or examples

The exporter checks in sections 9 and 13 accepted a commented-out `true`, a value merely beginning with `true`, an earlier assignment superseded by a later `false`, or an enabled `.env.example` beside a disabled `.env`, and rejected a valid quoted value. A disabled exporter could pass and a correctly configured one could fail.

The kit-authored `hooks/lib/env-config.js` parses assignments, honours quoting and `export`, ignores comments, takes the last assignment, and prefers the project's `.env` over example files. The Node.js and Python observability validators use it through fix-ups; the Java and dev-channel validators use it directly. The dev-channel check still inspects both `.env` and `.env.example`, because neither should enable an unauthenticated listener by default.

### 15. `path-guard.js`: nested new paths and Windows casing

Section 3's fallback resolved only the immediate parent of a new file. A new path with several missing directories beneath a junction or symlink fell back to the unexpanded path, so a location lexically inside the project could resolve outside it. String-prefix containment also rejected legitimate paths whose Windows casing differed from the project root, and would have treated `C:\proj2` as inside `C:\proj`.

The guard now resolves the nearest existing ancestor before appending the missing components, compares containment with `path.relative`, and ignores malformed or non-tool events instead of crashing. The drop-in protection from section 3 is unchanged.

### 16. `validate-add-workiq-tools.js`: honour the S2S early exit

The skill deliberately exits without changes on an S2S project, because this kit's Work IQ wiring needs a delegated user token. Its validator then demanded a manifest and MCP wiring anyway, blocking the session after the skill had correctly refused. The validator now reads the cached auth mode and returns a non-blocking verdict for S2S; OBO and agentic-user validation are unchanged.

### 17. Setup diagnostics: `completed:false` is not a consent failure

Two validators read `completed:false` in the generated config as proof that OAuth consent was missing and sent the operator to an administrator. It equally reflects a skipped endpoint or hosting step, as the live runs in this repository showed. The warnings now direct the reader to check setup, endpoint and consent results separately. An unconditional warning that an App Service managed identity was required for observability is removed; Azure hosting is optional and other credentials are supported.

### 18. SDK and playbook corrections: the September 2026 audit

An audit of the bundled skills against the released SDKs found instructions and samples that could not work as written. The corrections are applied to the canonical files before the discovery copies are made and are recorded in `build/upstream-fixups.json`, each with an id and an exact expected match count, so an upstream rewording fails the build rather than silently shipping a stale patch.

| Area | What was wrong | Correction |
|---|---|---|
| .NET observability | Samples set `o.Agent365.Exporter.TokenResolver` and `o.Agent365.Exporter.UseS2SEndpoint`, a property path that does not exist in the shipped distro; the OBO cache was described as auto-registered when it is not | `o.Agent365.TokenResolver` / `o.Agent365.UseS2SEndpoint`, verified against the distro's own type documentation; explicit `IExporterTokenCache<AgenticTokenStruct>` registration. A host built with only `UseMicrosoftOpenTelemetry(...)` resolves no such service on `Microsoft.OpenTelemetry` 1.0.3 or 1.0.7, and the build fails if the auto-registration claim reappears anywhere |
| .NET logging check | The validator blocked the session when `appsettings.json` had no `Logging.LogLevel` entries for the observability categories | A warning: log categories govern local diagnostics and prove nothing either way about exported telemetry |
| Node.js clients | LangChain returned a content union where the host needed a string; the Claude sample used the Messages constructor on the Agent SDK package; notifications and Work IQ called a client method that does not exist | Union flattened to text; `query()` from the Claude Agent SDK; `client.invoke` |
| Node.js managed identity | MSAL silently discards the `fmiPath` option | The token request serialises `fmi_path` in the form POST directly |
| Work IQ, Python | `ENV=development` where the SDK reads `PYTHON_ENVIRONMENT` | `PYTHON_ENVIRONMENT=Development`, which is also what drove the Work IQ 401s recorded earlier in this repository |
| Framework detection | Hosting and notification packages classified Semantic Kernel, OpenAI, Claude and ADK projects as Agent Framework | Detection keys on the LLM framework package |
| Validation commands | `npm run build \|\| npm run compile \|\| echo` turned a failed build into success; an unquoted `\|` in a log-level value was a shell pipe; one `dotnet add package` named two packages | Explicit script checks that preserve exit codes; quoted value; one package per command |
| Playground | `@microsoft/agentsplayground` is not the package name | `@microsoft/m365agentsplayground`; the executable is still `agentsplayground` |
| Local testing | The `-c emulator` flag was described as bypassing server authentication, and ports were assumed per language | The flag selects the client channel only; the actual listening port is inspected; a health check must return 200 first |
| Exporter checks | Environment-only checks ignored explicit code options; Node's `enableConsoleExporters` belongs at the top level, not inside `a365`; .NET's explicit `o.Exporters` selection overrides the legacy root flag | Code and environment are both read; console-only intent is recorded as `observabilityExportMode` and validated without demanding a remote token |

What this repository does **not** carry from that audit: the pinned Python Agents 1.6 profile and the rule that only that profile is generated for Python AI Teammates. Those are a policy about which frameworks to support, not defects, so they stay out of Microsoft's text. The profile ships as the runnable `examples/python-teammate` and as kit-authored guidance in `shared/local-runtime-lessons.md`, which the skills point to.

### 19. Guarded setup and the observability access-package hand-off

When `a365 setup` reports that the blueprint needs consent for `maven-prod [Agent365.Observability.OtelWrite]`, the CLI can still exit zero, and an assistant reading only the exit code reports setup as complete. The kit-authored `run-a365.mjs` forwards approved setup commands to the installed CLI, recognises that message even in coloured or chunked output, prints the administrator steps from `shared/observability-access-package.md`, and exits 2 so automation cannot mistake the hand-off for success. It does not sign in, retry, create packages or grant anything. The recovery itself is an Entra access package with the exact resource role, an initial policy, and an assignment to the blueprint that reaches **Delivered**; approval alone is not enough.

From kit 0.2.3 the hand-off offers a direct grant first: `grant-observability.mjs` makes the same Microsoft Graph calls `a365 setup all` makes for a Global Administrator, after an administrator signs in and confirms. The access package stays as the alternative for tenants that want approvals and expiry.

Sections 14 to 19 are the work of Gerard Salvador López, contributed in September 2026 with offline regression fixtures for each change.

---

### 20. Kit pointers inside Microsoft's files

The kit adds short pointers to its own material in a few places, and nowhere else:

- Seven `SKILL.md` files and `copilot-instructions.md` open with a **Kit runtime corrections** note that tells the CLI to read `.a365-kit/shared/local-runtime-lessons.md` first.
- `test-local` sends hosts that keep `/api/messages` authenticated, which includes every blueprint host, to the `test-local-channel` add-on instead of disabling authentication.
- `purview-dlp-integration` tells the CLI to read `.a365-kit/shared/purview-kit-notes.md` before its Step 2.
- `copilot-instructions.md` ends with a generated **Kit add-ons** section, because GitHub Copilot reads that file and not the skill folders.

These change where a CLI looks, not what Microsoft's phases do.

### 21. Work IQ: one failing MCP server no longer stops the rest

The OpenAI Agents SDK, in Python and Node.js, lists tools from every attached MCP server when a run starts, and Agent Framework connects each one. A single server that fails fails the whole run. Microsoft's Work IQ wiring and AI Teammate templates run the agent with every discovered server attached, so one server that lacks consent or is down stops every Work IQ tool. The kit adds a check that leaves out the failing servers for that turn, kept in `.a365-kit/shared/mcp-server-health.md`, and calls it from:

- `add-workiq-tools/references/python-workiq.md`: the OpenAI Agents SDK and Agent Framework `process_user_message` examples and their imports.
- `add-workiq-tools/references/nodejs-workiq.md`: a note after the OpenAI Agents SDK example with the connect and run, and a note after the LangChain example that one failure there still loses every Work IQ tool.
- `add-workiq-tools/SKILL.md`: a fourth step in sections 4.5, 4.7 and 4.8 to write the helper, and a line so that re-running the skill on an agent wired earlier adds just the check.
- `make-ai-teammate/references/python-ai-teammate.md`: the Agent Framework and OpenAI Agents SDK templates, inside the branch that runs only once Work IQ is wired.
- `make-ai-teammate/SKILL.md`: the rule that preserves Work IQ wiring also keeps the helper.

Google ADK 2.0 and later and the .NET tooling library already skip a failing server, so their paths are unchanged. The helpers were run against openai-agents 0.20.0, @openai/agents 0.17.0 and 0.18.0, and agent-framework-core 1.17.0, with local servers that answer tools/list with HTTP 403, answer with a JSON-RPC error, never answer, or refuse the connection. `build/test-mcp-server-health.mjs` runs them on every build.

### 22. Refused prompts get a refusal, and errors never reach the user

When a model refuses a prompt or a content filter blocks it, the SDKs raise an exception, and the generated hosts turned that into an error reply. The Python AI Teammate host never set a turn error hook, so the Python SDK's default sent `Exception caught : <error>` to the user; the Node.js and .NET hosts appended the exception message to their apology. A jailbreak or prompt-injection attempt, which is exactly when a refusal is expected, showed users an error. The kit adds reply helpers, kept in `.a365-kit/shared/turn-replies.md`, and changes:

- `make-ai-teammate/references/python-ai-teammate.md`: the host sets the adapter's turn error hook to the helper, and the Agent Framework template answers with the refusal when the output filter returns empty text.
- `make-ai-teammate/references/nodejs-ai-teammate.md` and `dotnet-ai-teammate.md`: the turn error handlers, and the Node.js agent's own message handler, send the helper's reply instead of the exception message.
- `make-ai-teammate/SKILL.md`: one task per language to add the helper file.

What each SDK raises was captured from openai-agents 0.20.0, agent-framework 1.17.0 with agent-framework-openai 1.14.2, @openai/agents 0.17.0 and 0.18.0, and Azure.AI.OpenAI 2.7.0-beta.2 with Microsoft.Extensions.AI.OpenAI, against a local endpoint answering with a filtered output, a refusal, Azure's prompt-shield error and an ordinary HTTP 400. `build/test-turn-replies.mjs` runs the helpers on every build and fails if a template sends exception text to the user.

---

## Kit add-ons: not Microsoft's

Everything under `.a365-kit/addons/` (and its copies in `.claude/skills/` and `.agents/skills/`) plus the five add-on validators listed at the top of this notice is **written for this kit** and MIT-licensed under the repository's `LICENSE`. They follow upstream's skill format so every CLI discovers them the same way, but they are not part of `microsoft/agent365-skills` and should not be reported there.

| Add-on | Fills this gap | Basis |
|---|---|---|
| `add-messaging-endpoint` | `make-a365-agent` asks for a messaging endpoint but never creates the HTTP host; blueprint-based agents built from a CLI or library end up registered but unreachable. Adds the host, the tunnel, and the endpoint registration; hands off the one broker-bound step. | Python host verified live on `microsoft-agents` 1.6.0 (2026-09-04). Node.js and .NET reference upstream's own hosting layers, which need no change for this path. |
| `a365-kit` | Kit maintenance from inside the CLI: prerequisite check, versions, in-place update, and choosing the update source (public release or an internal mirror). Thin wrapper over the launchers. | Kit-authored. |
| `add-lab-tools` | Local in-process utility tools an agent otherwise lacks: web fetch / page summarise, encoders/decoders, hashing, text transforms. Dual-use (the web fetch is egress + prompt-injection surface); opt-in and clearly labelled. | Python verified live on a hosted agent (2026-09-04); Node.js and .NET are faithful ports awaiting a run. |
| `add-mcp-server` | Connects the agent to any external / community MCP server (filesystem, git, GitHub, Postgres, web fetch, Slack, Playwright, …) beyond Microsoft's Work IQ set. Governance boundary: external servers are NOT registered in Agent 365 or gated by Entra; opt-in, clearly labelled, paired with DLP guidance. | Python wiring pattern API-verified on the live SDK (`MCPServerStdio`/`StreamableHttp`). From 0.2.11 a server that fails to start is logged and skipped instead of stopping the others: the Python startup code was run against openai-agents 0.20.0, and the .NET reference was compiled and run against ModelContextProtocol 1.4.1, each with healthy, refusing and missing servers side by side. Node.js is a faithful port awaiting a run. |
| `grant-observability-access` | `a365 setup all` grants `Agent365.Observability.OtelWrite` only when a Global Administrator runs it, and otherwise prints a hand-off. Checks the delegated consent and the application roles read-only, then grants what is missing after an administrator signs in to `az` and confirms. Java, Go and Rust exporters sign in as the blueprint, so the blueprint can be included. | Mirrors the CLI 1.1.221 grant logic: the consent scope, the role name and the fallback PowerShell come from its source. Offline tests cover every Graph call. A grant followed by a read-only check completed against a live tenant on 2026-09-24. |
| `test-local-channel` | Microsoft's `test-local` is written throughout for the AI Teammate path, so a blueprint agent had no local test route at all: its host rejects every unauthenticated request, which is deliberate. Adds a dev channel on its own loopback-bound port, off unless `A365_DEV_CHANNEL=true`, leaving `/api/messages` fully authenticated. | Python module run and verified: with the flag unset the port refuses connections; with it set, `/dev/health` returns 200, `/dev/chat` answers without a token, a request carrying `X-Forwarded-For` is refused 403, the socket is bound to 127.0.0.1 rather than the wildcard, and the production endpoint still returns 401. Node.js and .NET are faithful ports awaiting a run. |
| `add-java-agent` | Microsoft ships no Java SDK, so a Java agent can be registered and published but has no host, no inbound token validation and no way to export telemetry. Adds all three. Registration and the portal steps are language-agnostic and stay with the Microsoft skills. | Compiled on JDK 21 and run: health 200, anonymous POST 401, forged bearer 401, GET 405. The OTLP encoder was matched field by field against the Python SDK's output. Dry-run end to end through GitHub Copilot CLI on a fresh Maven project: the CLI found the skill, wrote the five classes, wired them to the project's own agent class rather than a stub, added both dependencies, compiled, and reproduced the non-standard wire format correctly. Not yet exercised against a tenant from Java, because a real inbound activity and Connector reply need a published agent. |

The eight Microsoft skills are untouched by the add-ons: they reference upstream files, never modify them. Kit 0.2.1 and earlier also shipped an `add-purview-dlp` add-on. Upstream's `purview-dlp-integration` skill, added in September 2026, answers the same request with different wiring, so from 0.2.2 the add-on is retired. What it learned on a live tenant and upstream does not cover moved to `.a365-kit/shared/purview-kit-notes.md`, which also tells the CLI how to handle a project the add-on already wired.

The September 2026 audit also re-verified the add-ons offline: every Python, Node.js and .NET reference was compiled or executed against the released SDK versions it names, and the Java host was compiled on JDK 21 with Maven 3.9 and its five classes verified. These are compile and mocked-boundary checks, not live-tenant runs, except where the table says otherwise.

## Examples and the workspace tool

`examples/` holds seven starter agents in six languages and `tools/prepare-workspace.mjs` copies the kit and one example into a new directory, verifying every file against `BUNDLE-MANIFEST.json`. `tools/bulk-onboard.mjs` starts the onboarding for several agents in parallel sessions of [herdr](https://herdr.dev), a separate Apache 2.0 project that the kit does not bundle. Both are kit-authored, MIT, contributed by Gerard Salvador López, and contain no tenant, user, tunnel or credential values; the model keys they read are supplied by the person running them. The SDKs they declare are restored from their registries, not redistributed.

---

## What is *not* changed

- No phase ordering, decision matrix, or trigger phrases.
- No code patterns in `references/` beyond the token-resolver fix in section 11, the SDK corrections itemised in section 18, the MCP server check in section 21 and the turn replies in section 22, all of which are asserted against upstream's text on every build.
- No skill logic beyond the exporter switch in section 10, which is applied to bring the Node.js and Python paths into line with what upstream's .NET path already does.
- No validator check logic beyond the fixes in sections 8, 9, 11 to 17 and 19, and no code pattern beyond the token-resolver fix in section 11, the SDK corrections in section 18, the MCP server check in section 21 and the turn replies in section 22; the validators otherwise enforce exactly what upstream enforces.
- Nothing added to the skills beyond the pointers in section 20 and the steps in sections 21 and 22. The kit's own Purview, hosting and hardening content lives in the separately labelled add-ons above.

## Reporting issues

Problems with the skills themselves (what they do, ask, or generate) belong upstream at
[microsoft/agent365-skills](https://github.com/microsoft/agent365-skills/issues). Problems with the
packaging, the launchers, the prerequisite doctor, or the build belong in this repository.
