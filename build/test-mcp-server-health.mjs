// Runs the MCP server health helpers from the shipped note against stand-in servers,
// so a doc edit that breaks them fails the build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const kit = path.join(here, '..', 'kit', '.a365-kit');
const note = fs.readFileSync(path.join(kit, 'shared', 'mcp-server-health.md'), 'utf8').replace(/\r\n/g, '\n');
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

function block(language, marker) {
  const found = [...note.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g'))]
    .map(m => m[1]).filter(code => code.includes(marker));
  assert.equal(found.length, 1, `expected one ${language} block defining ${marker}`);
  return found[0];
}

function workdir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-health-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

function run(command, args, cwd) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `${command} failed:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const pythonHarness = `
import asyncio, dataclasses, json, logging, time
from openai_health import healthy_mcp_agent
from af_health import healthy_mcp_tools

warnings = []
class Collect(logging.Handler):
    def emit(self, record): warnings.append(record.getMessage())
logging.getLogger().addHandler(Collect())

class Server:
    def __init__(self, name, mode): self.name, self.mode = name, mode
    async def list_tools(self):
        if self.mode == "error": raise RuntimeError("tools/list failed")
        if self.mode == "hang": await asyncio.sleep(30)
        return [self.name + "_tool"]

@dataclasses.dataclass
class Agent:
    mcp_servers: list
    def clone(self, **changes): return dataclasses.replace(self, **changes)

class Tool:
    def __init__(self, name, mode, connected=False, functions=()):
        self.name, self.mode, self.is_connected, self.functions, self.connects = name, mode, connected, list(functions), 0
    async def connect(self, *, reset=False):
        self.connects += 1
        if self.mode == "down": raise ConnectionError("refused")
        self.is_connected = True
        if self.mode == "no-tools": raise RuntimeError("tools/list failed")
        if self.mode == "hang": await asyncio.sleep(30)
        self.functions = [self.name + "_tool"]

async def main():
    out = {}
    healthy = Agent([Server("a", "ok"), Server("b", "ok")])
    out["unchanged"] = (await healthy_mcp_agent(healthy)) is healthy
    empty = Agent([])
    out["empty"] = (await healthy_mcp_agent(empty)) is empty
    mixed = Agent([Server("good", "ok"), Server("broken", "error"), Server("slow", "hang")])
    started = time.monotonic()
    kept = await healthy_mcp_agent(mixed, timeout=0.2)
    out["kept"] = [s.name for s in kept.mcp_servers]
    out["original"] = len(mixed.mcp_servers)
    out["fast"] = time.monotonic() - started < 2

    ready = Tool("ready", "ok", connected=True, functions=["ready_tool"])
    tools = [ready, Tool("fresh", "ok"), Tool("down", "down"), Tool("empty", "no-tools"), Tool("slow", "hang")]
    started = time.monotonic()
    out["af_kept"] = [t.name for t in await healthy_mcp_tools(tools, timeout=0.2)]
    out["af_fast"] = time.monotonic() - started < 2
    out["af_ready_untouched"] = ready.connects == 0
    await healthy_mcp_tools(tools, timeout=0.2)
    out["af_retried"] = tools[3].connects == 2
    out["warnings"] = warnings
    print(json.dumps(out))

asyncio.run(main())
`;

const nodeHarness = `
import { healthyMcpAgent } from './mcpHealth.ts';

const warnings = [];
console.warn = (...args) => warnings.push(args.join(' '));
const server = (name, mode) => ({
  name,
  async listTools() {
    if (mode === 'error') throw new Error('tools/list failed');
    if (mode === 'hang') await new Promise(() => {});
    return [{ name: name + '_tool' }];
  },
});
const agent = (mcpServers) => ({ mcpServers, clone(changes) { return agent(changes.mcpServers ?? mcpServers); } });

const out = {};
const healthy = agent([server('a', 'ok'), server('b', 'ok')]);
out.unchanged = (await healthyMcpAgent(healthy)) === healthy;
const empty = agent([]);
out.empty = (await healthyMcpAgent(empty)) === empty;
const mixed = agent([server('good', 'ok'), server('broken', 'error'), server('slow', 'hang')]);
const started = Date.now();
const kept = await healthyMcpAgent(mixed, 200);
out.kept = kept.mcpServers.map((s) => s.name);
out.original = mixed.mcpServers.length;
out.fast = Date.now() - started < 2000;
out.warnings = warnings;
console.log(JSON.stringify(out));
`;

test('Python helpers keep healthy servers and drop failing ones', () => {
  const dir = workdir({
    'openai_health.py': block('python', 'def healthy_mcp_agent('),
    'af_health.py': block('python', 'def healthy_mcp_tools('),
    'harness.py': pythonHarness,
  });
  const out = run(python, ['harness.py'], dir);
  assert.equal(out.unchanged, true, 'an agent whose servers all answer is returned as is');
  assert.equal(out.empty, true, 'an agent without servers is returned as is');
  assert.deepEqual(out.kept, ['good']);
  assert.equal(out.original, 3, 'the original agent keeps every server for the next turn');
  assert.equal(out.fast, true, 'a server that never answers is cut off by the timeout');
  assert.deepEqual(out.af_kept, ['ready', 'fresh']);
  assert.equal(out.af_fast, true);
  assert.equal(out.af_ready_untouched, true, 'a tool with loaded tools is not reconnected');
  assert.equal(out.af_retried, true, 'a connected tool with no tools is reconnected on the next turn');
  for (const name of ['broken', 'slow', 'down', 'empty']) {
    assert.ok(out.warnings.some(w => w.includes(`MCP server ${name} skipped`)), `no warning names ${name}`);
  }
});

test('Node.js helper keeps healthy servers and drops failing ones', () => {
  const dir = workdir({ 'mcpHealth.ts': block('typescript', 'export async function healthyMcpAgent'), 'harness.ts': nodeHarness });
  const out = run(process.execPath, ['harness.ts'], dir);
  assert.equal(out.unchanged, true);
  assert.equal(out.empty, true);
  assert.deepEqual(out.kept, ['good']);
  assert.equal(out.original, 3);
  assert.equal(out.fast, true);
  for (const name of ['broken', 'slow']) {
    assert.ok(out.warnings.some(w => w.includes(`MCP server ${name} skipped`)), `no warning names ${name}`);
  }
});

test('Work IQ and teammate guidance call the helpers the note defines', () => {
  const read = rel => fs.readFileSync(path.join(kit, 'skills', ...rel.split('/')), 'utf8');
  const python = read('add-workiq-tools/references/python-workiq.md');
  assert.match(python, /agent = await healthy_mcp_agent\(self\.agent\)/);
  assert.match(python, /self\.agent\.mcp_tools = await healthy_mcp_tools\(self\._all_mcp_tools\)/);
  assert.match(read('add-workiq-tools/references/nodejs-workiq.md'), /run\(await healthyMcpAgent\(this\.agent\), prompt\)/);
  assert.match(read('add-workiq-tools/SKILL.md'), /has no MCP server health check .* add just the check/, 'an agent wired earlier must still get the check');
  const teammate = read('make-ai-teammate/references/python-ai-teammate.md');
  assert.match(teammate, /from mcp_health import healthy_mcp_tools/);
  assert.match(teammate, /personalized_agent = await healthy_mcp_agent\(personalized_agent\)/);
});
