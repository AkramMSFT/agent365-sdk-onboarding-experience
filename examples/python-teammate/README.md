# Python authenticated AI Teammate host

An aiohttp host for an Agent Framework agent on Azure OpenAI, with authenticated `/api/messages`, email notifications and optional Work IQ tools. The dependencies are pinned in `requirements-lock.txt` and `pyproject.toml`, which target Python 3.12.

## Offline first

The offline tests run against an isolated copy of the pinned dependencies, with networking blocked. From the prepared workspace:

```powershell
python -m pip install --target deps -r requirements-lock.txt
python -I -S run_offline.py
python demo.py "Hello Agent 365"
```

`run_offline.py` checks the installed SDK versions, then runs the contract tests in `tests/` and reports `NETWORK_GUARD_BLOCKS=0` when nothing tried to reach the network. `demo.py` is a dependency-free tool demonstration, not an AI response. The `deps` folder is git-ignored; use `--deps <folder>` to point at another one.

## Running the host

The host needs a registered agent. Onboard it first, then copy `.env.example` to `.env` and fill in the Azure OpenAI values and the blueprint credentials that setup produced:

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements-lock.txt
.venv\Scripts\python app\host_agent_server.py
```

It listens on `HOST` and `PORT` from `.env`, by default `127.0.0.1:3978`. `GET /api/health` returns 200 without a token. `POST /api/messages` always requires a valid token, including in development, so AgentsPlayground's unsigned requests get 401. Use Teams, an authorised caller, or the kit's `test-local-channel` add-on to talk to it locally.

`ENABLE_WORKIQ` and `ENABLE_A365_OBSERVABILITY_EXPORTER` start as `false`. Turn them on only after registration, consent and licensing are in place.

With Work IQ on, this host fails closed on purpose. If any Work IQ server fails to connect or list its tools, the turn stops before the model is called and the user gets a short apology, so the agent never answers without a tool the user expected. To carry on with the servers that work instead, use the helper in `.a365-kit/shared/mcp-server-health.md`.

## Onboarding it to Agent 365

Start your CLI in this folder, say *Onboard this agent to Agent 365.* and choose the AI Teammate capability. The kit's Python guidance for this pinned profile is in `.a365-kit/shared/local-runtime-lessons.md`.
