# Agent 365 SDK Onboarding Experience

Onboard an existing AI agent to **Microsoft Agent 365** from whichever coding CLI you already use.

Microsoft publishes [`agent365-skills`](https://github.com/microsoft/agent365-skills) as a Claude Code plugin. The **Agent 365 Onboarding Kit** in this repository repackages those skills as a folder you drop into your agent's repository, so any skill-aware CLI picks them up with no install step.

The whole flow is four steps: download the kit into your agent project, run the launcher, start your CLI, and say *Onboard this agent to Agent 365.*

---

## Contents

- **Getting started**
  - [What it does](#what-it-does)
  - [Before you start](#before-you-start)
  - [Quick start](#quick-start)
  - [Keeping the kit up to date](#keeping-the-kit-up-to-date)
  - [Start from a sample instead](#start-from-a-sample-instead)
  - [Onboarding several agents at once](#onboarding-several-agents-at-once)
- **Using the kit**
  - [What you can ask for](#what-you-can-ask-for)
  - [What is included](#what-is-included)
  - [Supported CLIs](#supported-clis)
  - [Language support](#language-support)
  - [Examples](#examples)
- **Background**
  - [How it works](#how-it-works)
  - [Relationship to Microsoft's skills](#relationship-to-microsofts-skills)
  - [Verification](#verification)
  - [What local success does not prove](#what-local-success-does-not-prove)
- **Maintaining the kit**
  - [Building and self-hosting](#building-and-self-hosting)
  - [Repository layout](#repository-layout)
- [Contributors](#contributors)
- [Licence](#licence)

---

## What it does

Agent 365 onboarding has roughly ten stages: an Entra blueprint, an agent identity, an agentic user, observability, tools, a messaging endpoint, a published manifest, an admin-centre activation, DLP. Microsoft's skills automate most of it. Getting hold of those skills was the awkward part, because every documented install path assumes a particular host.

| Documented path | Requires |
|---|---|
| `/plugin marketplace add` | a Claude Code host that exposes `/plugin`, which several do not |
| `claude --plugin-dir ...` | an absolute path, and a non-elevated shell |
| `gh skill add` | the `gh skill` extension |

Each path works somewhere, but none works everywhere, so trying the skills often turned into troubleshooting the install. The kit removes the install step. The skills travel **with the project**, in the directories each CLI already looks in.

## Before you start

### Prerequisites

| | Why |
|---|---|
| **.NET SDK 8+** | the `a365` CLI is a .NET global tool, so you need the SDK, not just the runtime |
| **`a365` CLI** | creates the blueprint and Entra identity |
| **Azure CLI**, signed in | tenant sign-in and app registration |
| **Node.js 18+** | runs the kit's prerequisite check, validators and tools |
| **Git** | scaffolding starter agents |
| **An AI coding CLI** | drives the onboarding; see [Supported CLIs](#supported-clis) |
| **Your agent's own runtime** | Python 3.10+, Node.js, or .NET |

You do not have to get this right first time: the launcher in step 2 of the Quick start checks every item and prints the install command for anything missing.

**Windows:**

```powershell
winget install --id Microsoft.DotNet.SDK.8 -e
dotnet tool install -g Microsoft.Agents.A365.DevTools.Cli
winget install --id Microsoft.AzureCLI -e
az login --allow-no-subscriptions
```

**macOS:**

```bash
brew install --cask dotnet-sdk
dotnet tool install -g Microsoft.Agents.A365.DevTools.Cli
brew install azure-cli
az login --allow-no-subscriptions
```

Then at least one CLI:

```bash
npm install -g @github/copilot
npm install -g @anthropic-ai/claude-code
```

Three things that are easy to miss, all covered in the guide:

- **A one-time tenant step.** An administrator runs `a365 setup requirements` once; every developer in the tenant inherits it.
- **A model provider key.** The kit onboards your agent; it does not give it a model. Your project still needs its own `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or Azure OpenAI settings, or the agent registers successfully and then fails on its first message.
- **On Windows, use a normal terminal.** Per-user tools are invisible to an elevated shell.

### What to have ready

Onboarding creates real objects in a real tenant. Having these ready avoids stopping halfway.

| For every onboarding | Have ready |
|---|---|
| Your agent | Source path, language and framework, dependency file, and the command that starts it |
| Tenant and account | Entra tenant id, tenant domain, and the work account you will sign in with. Confirm it is the intended tenant. |
| An administrator | Someone who can grant consent, including the observability permission if setup asks for it, and upload the package. Know who before you start. |
| Agent details | Display name, description, and an accountable owner or sponsor with a resolvable UPN |
| Capabilities | Registration only, observability, Work IQ, Teams reachability, DLP. For a non-Teammate agent, OBO or S2S. |
| Model access | Provider, model or deployment name, and its key or identity. The kit does not supply a model. |

| Optional capability | Additional information |
|---|---|
| Work IQ | Which catalog servers you want, and the acting user's Microsoft 365 Copilot entitlement |
| Teams reachability | A public HTTPS endpoint, or a dev-tunnel sign-in and a free local port |
| Observability | At least one user in the tenant with Microsoft Agent 365 or Microsoft 365 E7 **assigned**. An unassigned subscription is not enough. |
| Purview DLP | A policy owner, the entitlement or pay-as-you-go billing, and the Entra application id the policy will target |
| External MCP servers | Approved server URLs or commands and their own credentials. These sit outside the Entra model. |

Everything else is generated during onboarding. Do not invent blueprint ids, secrets, or object ids, and keep model keys and client secrets out of Git.

## Quick start

Run every step from the root of your agent project, the folder that holds your agent's source.

> Use the **release asset** the commands below download, not GitHub's green Code > Download
> ZIP button. That button gives you the whole repository inside a wrapper folder, which puts
> the skills where no CLI looks. The extraction succeeds and your CLI then finds nothing.

**1. Download and extract the kit.**

Windows PowerShell:

```powershell
Invoke-WebRequest -Uri "https://github.com/AkramMSFT/agent365-sdk-onboarding-experience/releases/latest/download/agent365-onboarding-kit-latest.zip" -OutFile "kit.zip"
Expand-Archive -Path kit.zip -DestinationPath . -Force
```

macOS / Linux:

```bash
curl -L -o kit.zip https://github.com/AkramMSFT/agent365-sdk-onboarding-experience/releases/latest/download/agent365-onboarding-kit-latest.zip
unzip -o kit.zip -d . && chmod +x agent365-kit.sh
```

You can delete `kit.zip` afterwards; nothing depends on it.

**2. Run the launcher.** It changes nothing. It checks the prerequisites, prints the install command for anything missing, and lists the CLIs it can see.

```powershell
.\agent365-kit.ps1
```

```bash
./agent365-kit.sh
```

Fix anything it flags, open a **new** terminal so newly installed tools are on PATH, and run it again until everything passes. If Windows says running scripts is disabled, use `powershell -ExecutionPolicy Bypass -File .\agent365-kit.ps1`, which changes the setting for that one run only.

**3. Start your CLI in the same folder.**

```bash
copilot
```

or `claude`. Cursor, Codex, Gemini CLI and the other CLIs in [Supported CLIs](#supported-clis) read the skills when you open this folder in them.

Check that it found the skills: type `/skills` in Copilot CLI, or ask Claude Code *What Agent 365 skills do you have?* You should see fifteen. If you see none, the kit was extracted somewhere other than your project root.

**4. Ask for the onboarding.**

```
Onboard this agent to Agent 365.
```

The CLI detects your stack and works through the stages with you, and asks before it creates anything in your tenant. **[`GUIDE.md`](GUIDE.md) walks through every stage**, from your agent's source to a registered, observable agent answering in Teams.

## Keeping the kit up to date

Say *Update the Agent 365 kit.* in your CLI, or run the launcher:

```powershell
.\agent365-kit.ps1 -Update
```

```bash
./agent365-kit.sh --update
```

Only the kit's own files are replaced. Your agent, `.env`, configuration and any skills you added stay as they are. A fix in a new release reaches an agent you onboarded earlier when you ask for that capability again; the release notes say which phrase to use.

> Kits older than 0.2.12 cannot update a project inside a OneDrive folder on Windows. Extract
> the new kit zip over the project once, as in step 1 of the Quick start; later updates work.

**Updating from your own mirror.** Updates come from the public release unless you point them at another URL or a file path:

| Scope | Windows | macOS / Linux |
|---|---|---|
| One update | `.\agent365-kit.ps1 -Update -UpdateFrom <zip-or-url>` | `./agent365-kit.sh --update --update-from <zip-or-url>` |
| One shell or CI job | `$env:A365_KIT_UPDATE_SOURCE = '<zip-or-url>'` | `export A365_KIT_UPDATE_SOURCE=<zip-or-url>` |
| Every update in this project | `.\agent365-kit.ps1 -SetUpdateSource <zip-or-url>` | `./agent365-kit.sh --set-update-source <zip-or-url>` |

Setting a project source writes `a365-kit.config.json`. Commit it so the whole team updates from the same place, as long as the URL or path holds no credentials. A network share holding `agent365-onboarding-kit-latest.zip` works with no web server at all.

## Start from a sample instead

If you have no agent yet, the repository carries seven runnable starters in six languages. This is the one path where GitHub's **Code > Download ZIP** is fine, because the repository itself is the bundle: `kit/` plus `examples/` plus the workspace tool.

```powershell
git clone https://github.com/AkramMSFT/agent365-sdk-onboarding-experience.git
cd agent365-sdk-onboarding-experience
node tools\prepare-workspace.mjs --list
node tools\prepare-workspace.mjs --example python-teammate --destination ..\my-agent
```

```bash
git clone https://github.com/AkramMSFT/agent365-sdk-onboarding-experience.git
cd agent365-sdk-onboarding-experience
node tools/prepare-workspace.mjs --list
node tools/prepare-workspace.mjs --example python-teammate --destination ../my-agent
```

The tool copies the kit and one example into a **new** directory, checks every file against the SHA-256 recorded in `BUNDLE-MANIFEST.json`, and refuses to overwrite anything. `--example blank` gives a kit-only workspace. Then continue from step 2 of the Quick start in that directory. The catalog is in [`docs/AGENT-EXAMPLES.md`](docs/AGENT-EXAMPLES.md).

## Onboarding several agents at once

Optional. With [herdr](https://herdr.dev), an open-source terminal multiplexer for coding agents, `tools/bulk-onboard.mjs` starts one onboarding session per agent side by side, and herdr shows which sessions are waiting for you. Each onboarding stays interactive, just as it is for a single agent. See [`docs/BULK-ONBOARDING.md`](docs/BULK-ONBOARDING.md).

## What you can ask for

Each stage has a phrase. You do not need to know skill names.

| Say this | What happens |
|---|---|
| *Onboard this agent to Agent 365.* | Detects your stack, then creates the blueprint, identity and permissions |
| *Add observability to this agent.* | OpenTelemetry instrumentation and the Agent 365 exporter |
| *Add Work IQ tools to this agent.* | Microsoft 365 data: mail, calendar, Teams, SharePoint, OneDrive |
| *Add an MCP server.* | Any external MCP server: filesystem, git, GitHub, Postgres, Slack, Playwright |
| *Add lab tools.* | Local utilities: web fetch, encoders, hashing, text transforms |
| *Make this agent chattable in Teams.* | HTTP host, dev tunnel, and endpoint registration |
| *Add Purview DLP to my agent.* | Purview blocks sensitive prompts before the model and can audit replies (Microsoft's `purview-dlp-integration`) |
| *Onboard this Java agent.* | Hosting layer and telemetry for Java, which has no Microsoft SDK |
| *Let me test this agent locally.* | A loopback-only dev channel, so you can chat with the agent with no tenant, tunnel or Teams |
| *Update the Agent 365 kit.* | Updates the kit in place, leaving your agent untouched |
| *Grant observability access to this agent.* | Checks and grants the observability permission setup asks an administrator for (`maven-prod`) |

### Example

A TypeScript agent built on the OpenAI Agents SDK, with no Agent 365 code yet:

```
> Onboard this agent to Agent 365.

  Stack:      OpenAI Agents SDK
  Language:   NodeJS
  Agent type: Agent (Non AI Teammate)
  Blueprint:  none found - will create new

  Which capabilities should I configure?
    1. Register        2. Observability
    3. Work IQ         4. AI Teammate

> 1 and 2

  How will your agent authenticate when calling downstream APIs?
    1. On-behalf-of (OBO)    2. Service-to-service (S2S)

> 1
```

From there it previews `a365 setup all` with `--dry-run`, shows exactly what will be created in your tenant, and asks before committing. Nothing reaches Entra without your explicit confirmation.

## What is included

**Microsoft's eight skills**, unchanged except for the modifications recorded in [`NOTICE.md`](NOTICE.md): `a365-setup`, `make-a365-agent`, `make-ai-teammate`, `instrument-observability`, `add-workiq-tools`, `a365-code-validator`, `test-local`, and `purview-dlp-integration`, which upstream added in September 2026.

**Seven add-ons written for this kit**, discovered the same way and clearly separated in `NOTICE.md`:

| Add-on | Fills this gap |
|---|---|
| `add-messaging-endpoint` | Upstream registers a blueprint agent but never hosts it, leaving it reachable by nothing. Adds the `/api/messages` host, the tunnel, and the endpoint registration. |
| `add-mcp-server` | Connects the agent to any external MCP server, with the governance boundary stated plainly: these are **not** registered in Agent 365 or gated by Entra. |
| `add-lab-tools` | Local in-process utilities an agent otherwise lacks: web fetch, encoders, hashing, text transforms. Opt-in and dual-use. |
| `add-java-agent` | Java has no Agent 365 SDK. Adds the HTTP host, inbound token validation, and a direct OTLP exporter. |
| `a365-kit` | Kit maintenance from inside your CLI: prerequisites, versions, in-place update, update source. |
| `grant-observability-access` | `a365 setup all` grants the observability permission only when a Global Administrator runs it. Checks what is missing without changing anything, then grants it once an administrator signs in and confirms, including the blueprint role that Java, Go and Rust exporters need. |
| `test-local-channel` | Microsoft's `test-local` targets AI Teammates only, so a blueprint agent had no local test path: its host rejects every unauthenticated request. Adds a loopback-only dev channel on its own port, off unless `A365_DEV_CHANNEL=true`. |

An agent gets tools three ways and the kit covers all three: Work IQ MCP servers (Microsoft-hosted, Entra-gated), local function tools, and external MCP servers (the wider ecosystem, ungoverned by Agent 365). Only the first appears in the Agent 365 registry, and the add-ons for the other two say so. When one MCP server fails, the others keep working: for the SDKs that would otherwise fail the whole turn, the kit checks each server before the run.

The hosts the kit generates answer a prompt the model refuses, or a content filter blocks, with a plain refusal, and any other failure with a short apology. The error details go to the log, never to the user.

## Supported CLIs

Support follows from where each CLI looks for skills, not from anything kit-specific:

| Directory the kit ships | CLIs that read it | Validator hooks |
|---|---|---|
| `.claude/skills/` | Claude Code | yes |
| `.agents/skills/` | GitHub Copilot (CLI, VS Code agent mode, coding agent), Cursor, Codex, Gemini CLI, Amp, Cline, OpenCode, Warp, Antigravity | no |
| `.github/copilot-instructions.md` *(opt-in)* | GitHub Copilot, as optional extra grounding | no |
| (none) | any other CLI: point it at `.a365-kit/skills/a365-setup/SKILL.md` | no |

`.agents/skills/` follows the [Agent Skills specification](https://agentskills.io/specification).

The skills themselves are plain Markdown. Only the validator hooks are Claude Code specific, and they are optional: everything works without them, just without the end-of-session correctness check. [`docs/USING-WITH-YOUR-CLI.md`](docs/USING-WITH-YOUR-CLI.md) covers per-CLI differences.

## Language support

Agent 365 ships SDKs for **Python, Node.js / TypeScript and .NET**. Within those, framework coverage is broad and detected automatically: LangChain, OpenAI Agents SDK, Claude Agent SDK, Google ADK, Semantic Kernel and Microsoft Agent Framework.

Most of onboarding never reads your source. The blueprint, identity, agentic user, endpoint registration, manifest, upload and instance are Entra, CLI and portal operations, so an agent in **any** language can be registered, published and made reachable in Teams. Only observability, Work IQ tools and the generated host are SDK-bound. Java is covered by the `add-java-agent` add-on, and [`GUIDE.md`](GUIDE.md#which-languages-this-covers) documents the wire contract other languages would need. Console starters for Java, Go and Rust live under `examples/`; Go and Rust are manual-integration stacks, and a validator reporting `ok` on them is not evidence of onboarding.

## Examples

Seven runnable starters, each with an offline mode that needs no key and no tenant, plus opt-in live inference. Prepare one with `tools/prepare-workspace.mjs`; see [Start from a sample instead](#start-from-a-sample-instead) and [`docs/AGENT-EXAMPLES.md`](docs/AGENT-EXAMPLES.md).

| Example | Language | What it shows |
|---|---|---|
| `python-teammate` | Python 3.12 | Authenticated aiohttp host, pinned Agent Framework and SDK contracts, token store and telemetry, optional Work IQ |
| `dotnet-agent365-lab` | C# / .NET 8 | Opt-in Teams host, Work IQ, telemetry, agent mailbox and Purview patterns with offline checks |
| `dotnet-tool-agent` | C# / .NET 8 | Small Agent Framework console agent with an offline SDK self-test |
| `nodejs-tool-agent` | JavaScript / Node 24 | OpenAI Agents SDK tools and an in-memory model, tool, model turn |
| `java-tool-agent` | Java 21 / Maven | HttpClient and Gson model, tool loop with JUnit tests |
| `go-tool-agent` | Go 1.24+ | Standard-library model, tool loop with tests |
| `rust-tool-agent` | Rust 1.88+ | Native-TLS and serde_json model, tool loop with Cargo tests |

The examples and the workspace tool were contributed by Gerard Salvador López.

## How it works

A skill is a Markdown file with front matter. CLIs discover skills by looking in known directories, so the kit ships the same content in the directories each one reads:

```
your-agent-project/
  .a365-kit/            canonical: skills, shared docs, validators, prerequisite checker
  .claude/skills/       discovery copy for Claude Code
  .agents/skills/       discovery copy for Copilot, Cursor, Codex, Gemini CLI, and others
  agent365-kit.ps1      launcher: prerequisite check, per-CLI activation, updates (Windows)
  agent365-kit.sh       the same for macOS and Linux
```

The discovery copies are **byte-identical**, because every internal reference points at `.a365-kit/`. That single indirection is what lets one copy serve every CLI, and the build verifies the copies match.

## Relationship to Microsoft's skills

This is a repackage, not a fork. The build clones upstream fresh on every run and re-applies a fixed set of edits, each of which asserts the upstream text it expects to find. If Microsoft reword a patched passage, the build fails and names the file rather than silently emitting something broken.

Changes fall into two groups, both itemised in [`NOTICE.md`](NOTICE.md):

- **Packaging.** Path tokens, hook commands, the plugin command namespace, and a guard that would otherwise disable itself outside a plugin install. Mechanical, no behaviour change.
- **Defects found while onboarding real agents.** Mostly in the observability path, where several independent faults each left an agent tracing every turn and exporting none of it. Also in the Work IQ wiring, where one MCP server that failed took every tool down with it, and in the hosts, which answered a refused prompt with an error, sometimes including the raw exception text. Every one is documented with the failure it causes and upstream's own justification for the fix.

Problems with what the skills *do* belong upstream at [microsoft/agent365-skills](https://github.com/microsoft/agent365-skills/issues). Problems with the packaging, launchers, prerequisite checker or build belong here.

## Verification

Built against upstream `agent365-skills` v1.0.2 and verified on Windows 11.

| Area | What was checked |
|---|---|
| Discovery | Claude Code and GitHub Copilot CLI both list all fifteen skills from the extracted folder with no install step. Copilot loads referenced files by relative path, which shows the path rewrites work outside Claude Code. |
| Onboarding | A Python agent taken end to end through Copilot CLI on a live tenant: blueprint, agent identity, eleven delegated permission grants, observability, Work IQ tools, messaging endpoint, published package, and the agent answering in Teams. |
| Node.js and .NET | Both taken through Copilot CLI on the same tenant. The Node run showed the exporter switch and the per-turn token refresh landing in generated code. The .NET run exercised the validator's exporter and per-turn registration checks on a hosted agent. |
| Java | The `add-java-agent` output compiles on JDK 21 and runs: the health check returns 200, and anonymous or forged requests return 401. Its OTLP encoder matches the Python SDK's output field by field. |
| Shared helpers | The MCP server check and the turn-reply helpers were run against the real Python, Node.js and .NET SDKs, and CI runs the shipped code on every build. |
| Examples | CI builds all seven offline and runs their tests on every push, Go and Rust included. |
| Reproducible build | CI rebuilds the kit from the upstream commit it records, and fails if the committed kit, manifest or checksums differ by a single byte, or if the tag and version fields disagree. |
| Launchers | CI runs each launcher's Copilot wiring, update-source and in-place update under Windows PowerShell 5.1, PowerShell 7 and bash, and fails if any of them writes a byte-order mark. |
| Validators | The kit's own validators run against every example and a set of fixtures on every build. |
| Observability grant | `grant-observability.mjs` passes offline tests against a simulated Microsoft Graph, and a real grant followed by a check has run against a live tenant. |
| Workspace tool | `prepare-workspace.mjs` copies an example from a clone, verifies every hash, and refuses an existing destination. |
| Bulk onboarding | `bulk-onboard.mjs` passes offline tests against a stand-in for herdr, and on Windows 11 with herdr 0.9.1 it started two Copilot CLI sessions in parallel that each received their request and listed the kit's skills. A full onboarding through it has not been run yet. |
| Path guard | Blocks writes into the kit and outside the project, and allows writes to agent source. |

Not yet exercised: the `.agents/skills/` path under Cursor, Codex, Gemini CLI, Amp, Cline, OpenCode, Warp and Antigravity, the bash launcher on macOS, and a Java agent taken all the way to a live tenant.

## What local success does not prove

The kit gives you source and a guided workflow, not a pre-provisioned agent.

| What you have | What it does not show |
|---|---|
| A passing offline demo or self-test | That a model was invoked, that it has quota, or that any tenant was configured |
| A registered endpoint, a manifest, or an HTTP 200 | Administrator approval, correct runtime grants, an authorised Teams reply, or telemetry visible in the service |
| DLP code and successful Graph calls | That an app-scoped blocking policy exists and its returned action is enforced |
| A validator reporting `ok` on a Go or Rust project | Anything about onboarding. Those are manual-integration stacks. |

Before declaring an agent done: confirm the tenant, blueprint and identity ids from real setup output; have the administrator review the actual scopes requested; send one authorised message through Teams and see the reply; and check that a turn produced telemetry for that agent id, not merely an exporter 200.

## Building and self-hosting

Requires PowerShell 7+, Git and Node.js. The tests use Node.js 24, as CI does.

```powershell
.\build\Build-Kit.ps1 -UpstreamRef <commit> -Zip
node --test build/test-*.mjs
```

- **Source.** `-UpstreamRef` clones upstream at a branch, tag or commit; `-UpstreamPath C:\src\agent365-skills` builds from a local clone instead.
- **Output.** The kit lands in `kit/`. With `-Zip` the build also writes `agent365-onboarding-kit-v<version>.zip` (the kit alone) and `agent365-onboarding-bundle-v<version>.zip` (kit, examples, tools and docs) at the repository root. Building into `kit/` regenerates `BUNDLE-MANIFEST.json` and `SHA256SUMS.txt`, which the workspace tool verifies against.
- **Changes to Microsoft's files.** Every one is an entry in `build/upstream-fixups.json` with an id and an exact match count, so an upstream rewording fails the build instead of shipping a stale patch. [`CONTRIBUTING.md`](CONTRIBUTING.md) explains how to add one.
- **Checks.** The build refuses to emit output it cannot prove coherent: no `${CLAUDE_PLUGIN_ROOT}` path tokens or `/agent365:` command references survive, every path a skill references exists, every bundled script parses, the discovery copies match, and every hook command was repointed.
- **CI.** Each push rebuilds from the commit and timestamp in `kit/.a365-kit/KIT-VERSION.json` and fails if the committed `kit/`, manifest or checksums differ by a single byte, then runs the launcher, validator, tool and example checks.
- **Staying current.** `.github/workflows/refresh-upstream.yml` runs daily. When upstream `main` moves, it rebuilds, runs the same checks as CI, commits `kit/` with the manifest, and cuts a release with both archives. If a fix-up no longer matches, it opens an issue instead.
- **Your own default update source.** `.\build\Build-Kit.ps1 -UpdateSource <zip-or-url> -Zip` bakes your mirror into the kit you build.

## Repository layout

| Path | Purpose |
|---|---|
| `build/Build-Kit.ps1` | the build, which derives `kit/` from upstream |
| `build/upstream-fixups.json` | every change made to Microsoft's files, each asserted by id and match count |
| `build/bundle-examples.json` | the example catalog written into the manifest |
| `build/kit.version` | this kit's packaging version |
| `build/test-*.mjs` | tests for the tools, validators, launch helper and shared code |
| `payload/` | files authored here and copied into every build: add-ons, validators, launchers, helpers, prerequisite checker |
| `kit/` | built output, committed so the repository can be used directly and cloned as a bundle |
| `examples/` | seven runnable starter agents |
| `tools/prepare-workspace.mjs` | copies the kit and one example into a new directory, verifying every file's hash |
| `tools/bulk-onboard.mjs` | starts the onboarding for several agents in parallel herdr sessions (optional) |
| `BUNDLE-MANIFEST.json`, `SHA256SUMS.txt` | generated by the build; what the workspace tool verifies against |
| `.github/` | CI: the build check, the shared release checks, and the daily upstream refresh |
| `GUIDE.md` | the end-to-end walkthrough |
| `NOTICE.md` | attribution and every modification made to upstream |
| `CONTRIBUTING.md` | where each kind of change belongs, and how to add a fix-up |
| `docs/` | deeper references: per-CLI setup, lifecycle, bulk onboarding |

`kit/`, the manifest and the checksums are generated. Changes to Microsoft's skills go in `build/upstream-fixups.json`; changes to the kit's own content go in `payload/`.

## Contributors

- **Akram Eleyan** ([@AkramMSFT](https://github.com/AkramMSFT)): author and maintainer.
- **Gerard Salvador López** ([@gerardsl](https://github.com/gerardsl)): the September 2026 audit, covering the SDK and playbook corrections in `build/upstream-fixups.json`, the hardened launchers and version check, the environment parser and console-mode checks, the setup runner for the observability access-package hand-off, the seven examples and the workspace tool, the runtime lessons the skills now point to, and the idea of onboarding several agents in parallel with herdr.

## Licence

Copyright © 2026 Akram Eleyan ([@AkramMSFT](https://github.com/AkramMSFT)). The kit is released under the MIT licence; see [`LICENSE`](LICENSE).

The bundled skills are © Microsoft Corporation, also under the MIT licence. [`NOTICE.md`](NOTICE.md) carries their attribution and the full list of modifications. Every kit carries both licences and the notice inside `.a365-kit/`.
