// Runs the kit's five stop-hook validators against every example and a set of small
// fixture projects, the way a stop hook runs them: the project as the working directory,
// VALIDATE_SKIP_EXEC=1 as in CI. Set KIT_VALIDATORS_RECORD to a file path to also save
// every stdout, stderr and exit code, for a byte-for-byte comparison across a refactor.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const VALIDATORS = ['add-java-agent', 'add-lab-tools', 'add-mcp-server', 'add-messaging-endpoint', 'test-local-channel'];
// Stop hooks run with a 15 second timeout.
const HOOK_TIMEOUT_MS = 15_000;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-validators-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// project-scan.js comes from upstream, so only the built kit/ has it. The payload is laid
// over the built hooks/lib the same way Build-Kit.ps1 overlays it.
const hooks = path.join(tmp, 'hooks');
fs.mkdirSync(path.join(hooks, 'lib'), { recursive: true });
fs.mkdirSync(path.join(hooks, 'stop'), { recursive: true });
for (const dir of ['kit', 'payload'].map(root => path.join(repo, root, '.a365-kit', 'hooks', 'lib'))) {
  for (const name of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, name), path.join(hooks, 'lib', name));
}
for (const name of VALIDATORS) {
  const file = `validate-${name}.js`;
  fs.copyFileSync(path.join(repo, 'payload', '.a365-kit', 'hooks', 'stop', file), path.join(hooks, 'stop', file));
}

const text = (...lines) => lines.join('\n') + '\n';
const json = value => JSON.stringify(value, null, 2) + '\n';
const pass = (extra = {}) => ({ ok: true, ...extra });
const fail = (...issues) => ({ ok: false, issues });

const HTTPS_ENDPOINT = json({ messagingEndpoint: 'https://agent.example.com/api/messages', completed: true });
const POM = text('<project>', '  <dependencies>',
  '    <dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId></dependency>',
  '    <dependency><groupId>com.nimbusds</groupId><artifactId>nimbus-jose-jwt</artifactId></dependency>',
  '  </dependencies>', '</project>');
// Deeper than scanProject's default maxDepth of 5, as Maven lays sources out.
const JAVA_DIR = 'src/main/java/com/contoso/agent/host';
const JAVA_AGENT = {
  [`${JAVA_DIR}/AgentHost.java`]: text('package com.contoso.agent.host;', '',
    'public final class AgentHost {',
    '  static final String ROUTE = "/api/messages";',
    '  String replyTo(Map<String, Object> activity) { return (String) activity.get("serviceUrl"); }',
    '}'),
  [`${JAVA_DIR}/InboundTokenValidator.java`]: text('package com.contoso.agent.host;', '',
    'final class InboundTokenValidator {',
    '  private final JWKSource<SecurityContext> keys;',
    '  boolean validate(Headers headers) { return check(headers.getFirst("Authorization")); }',
    '}'),
  [`${JAVA_DIR}/Exporter.java`]: text('package com.contoso.agent.host;', '',
    '// Attributes go out as a plain object, not the OTLP stringValue array.',
    'final class Exporter {',
    '  static final String PATH = "/otlp/agents";',
    '  void tag(Map<String, Object> a) {',
    '    a.put("gen_ai.operation.name", "invoke_agent");',
    '    a.put("microsoft.tenant.id", tenantId);',
    '    a.put("gen_ai.agent.id", agentId);',
    '  }',
    '}'),
};
const PY_LAB_TOOLS = text('import urllib.request', '',
  'MAX_FETCH_BYTES = 200_000', '',
  'def fetch_url(url: str) -> str:',
  '    if not url.startswith(("http://", "https://")):',
  '        raise ValueError("http and https only")',
  '    with urllib.request.urlopen(url, timeout=10) as response:',
  '        return response.read(MAX_FETCH_BYTES).decode("utf-8", "replace")', '',
  'def hash_text(value: str) -> str:',
  '    return hashlib.sha256(value.encode()).hexdigest()', '',
  'LAB_TOOLS = [fetch_url, hash_text]');
const PY_MCP_SERVERS = text('import os',
  'from agents.mcp import MCPServerStdio', '',
  'def build_external_mcp_servers():',
  '    token = os.getenv("GITHUB_TOKEN", "")',
  '    return [MCPServerStdio(params={"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]})]', '',
  'EXTERNAL_MCP_SERVERS = build_external_mcp_servers()');
const NODE_MCP_SERVERS = text("import { MCPServerStdio } from '@openai/agents';", '',
  'export function buildExternalMcpServers() {',
  "  return [new MCPServerStdio({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],",
  "    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '' } })];",
  '}');
const NODE_HOST = text("import express from 'express';",
  "import { authorizeJWT, loadAuthConfigFromEnv } from '@microsoft/agents-hosting';", '',
  'const app = express();',
  "app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));",
  "app.post('/api/messages', authorizeJWT(loadAuthConfigFromEnv()), (req, res) => adapter.process(req, res, ctx => agent.run(ctx)));",
  'app.listen(3978);');
const PY_HOST = text('from aiohttp import web',
  'from microsoft_agents.hosting.aiohttp import jwt_authorization_middleware, start_agent_process', '',
  'async def messages(request):',
  '    return await start_agent_process(request, AGENT_APP, ADAPTER)', '',
  'async def health(request):',
  '    return web.json_response({"status": "ok"})', '',
  'app = web.Application(middlewares=[jwt_authorization_middleware])',
  'app.router.add_post("/api/messages", messages)',
  'app.router.add_get("/api/health", health)');
const CSPROJ = text('<Project Sdk="Microsoft.NET.Sdk.Web">', '</Project>');
const WORKIQ_MANIFEST = json({ mcpServers: [{ mcpServerName: 'mcp_MailTools' }, { mcpServerName: 'mcp_CalendarTools' }] });

const FIXTURES = {
  'empty': {
    files: {},
    expect: {
      'add-java-agent': pass({ note: /not a Java project/ }),
      'add-lab-tools': fail('no lab-tools module found', 'the lab tools are not imported into the agent'),
      'add-mcp-server': fail('no external-MCP module found', 'the external MCP servers are not attached'),
      'add-messaging-endpoint': fail('could not determine the project language', 'a365.generated.config.json not found'),
      'test-local-channel': pass({ note: /No dev channel found/ }),
    },
  },
  'python-lab-tools': {
    files: {
      'requirements.txt': text('openai-agents'),
      'lab_tools.py': PY_LAB_TOOLS,
      'agent.py': text('from lab_tools import LAB_TOOLS', '', 'agent = Agent(name="hr", tools=[get_policy, *LAB_TOOLS])'),
    },
    expect: { 'add-lab-tools': pass() },
  },
  'python-lab-tools-replaced': {
    files: {
      '.a365-workspace-detection.local.json': json({ programmingLanguage: 'Python' }),
      'lab_tools.py': PY_LAB_TOOLS,
      'agent.py': text('agent = Agent(name="hr", tools=[LAB_TOOLS])'),
    },
    expect: { 'add-lab-tools': pass({ warn: /tools list references LAB_TOOLS but not the original tools/ }) },
  },
  'python-lab-tools-unguarded': {
    files: {
      'requirements.txt': text('requests'),
      'lab_tools.py': text('import requests', '', 'def fetch_url(url):', '    return requests.get(url).text'),
      'agent.py': text('agent = Agent(name="hr", tools = [get_policy])'),
    },
    expect: {
      'add-lab-tools': fail('fetch_url is present but missing one of its guards', 'the lab tools are not imported into the agent'),
    },
  },
  'python-lab-tools-empty': {
    files: {
      'pyproject.toml': text('[project]', 'name = "agent"'),
      'lab_tools.py': text('def helper():', '    return 1'),
    },
    expect: {
      'add-lab-tools': fail('lab-tools module exists but defines none of the expected tools', 'the lab tools are not imported into the agent'),
    },
  },
  'node-lab-tools': {
    files: {
      'package.json': json({ name: 'agent', type: 'module' }),
      'src/labTools.ts': text('const MAX_FETCH_BYTES = 200_000;',
        'export async function fetchUrl(url: string): Promise<string> {',
        "  if (!/^https?:\\/\\//.test(url)) throw new Error('http and https only');",
        '  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });',
        '  return (await response.text()).slice(0, MAX_FETCH_BYTES);',
        '}',
        'export const labTools = [fetchUrl];'),
      'src/agent.ts': text("import { labTools } from './labTools';",
        "export const agent = new Agent({ name: 'orders', tools: [lookUpOrder, ...labTools] });"),
      // Would fail the guard check if scanned: dependencies are not the agent's code.
      'node_modules/fake-lab/labTools.js': text('export function fetchUrl(url) { return fetch(url); }'),
    },
    expect: { 'add-lab-tools': pass() },
  },
  'dotnet-lab-tools': {
    files: {
      'Agent.csproj': CSPROJ,
      'LabTools.cs': text('public static class LabTools {',
        '  const int MaxFetchBytes = 200_000;',
        '  static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(10) };',
        '  public static async Task<string> FetchUrl(string url) {',
        '    if (!url.StartsWith("http://") && !url.StartsWith("https://")) throw new ArgumentException(url);',
        '    var body = await Http.GetStringAsync(url);',
        '    return body.Length > MaxFetchBytes ? body[..MaxFetchBytes] : body;',
        '  }',
        '}'),
      'Program.cs': text('var tools = new List<AITool> { AIFunctionFactory.Create(LookUpOrder) };',
        'tools.AddRange(LabTools.All());'),
    },
    expect: { 'add-lab-tools': pass() },
  },
  'python-mcp-server': {
    files: {
      'pyproject.toml': text('[project]', 'name = "agent"'),
      'mcp_servers.py': PY_MCP_SERVERS,
      'agent.py': text('from mcp_servers import EXTERNAL_MCP_SERVERS',
        'from microsoft_agents_a365.tooling.extensions.openai import add_tool_servers_to_agent', '',
        'mcp_servers = [*EXTERNAL_MCP_SERVERS]',
        'agent = Agent(name="hr", mcp_servers=mcp_servers, mcp_config={"include_server_in_tool_names": True})'),
    },
    expect: { 'add-mcp-server': pass() },
  },
  'python-mcp-server-unnamespaced': {
    files: {
      'requirements.txt': text('openai-agents'),
      'mcp_servers.py': PY_MCP_SERVERS,
      'agent.py': text('from mcp_servers import EXTERNAL_MCP_SERVERS', '',
        'def setup_workiq_tools(agent):', '    pass', '',
        'mcp_servers = [*EXTERNAL_MCP_SERVERS]'),
    },
    expect: { 'add-mcp-server': pass({ warn: /include_server_in_tool_names is not set/ }) },
  },
  'python-mcp-server-secret': {
    files: {
      'requirements.txt': text('openai-agents'),
      'mcp_servers.py': text('GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"', 'servers = []'),
      'agent.py': text('agent = Agent(name="hr")'),
    },
    expect: {
      'add-mcp-server': fail('external-MCP module does not reference an SDK MCP class',
        'a credential looks hard-coded in the external-MCP module',
        'the external MCP servers are not attached'),
    },
  },
  'node-mcp-server': {
    files: {
      'package.json': json({ name: 'agent', type: 'module' }),
      'src/mcpServers.ts': NODE_MCP_SERVERS,
      'src/agent.ts': text("import { buildExternalMcpServers } from './mcpServers';",
        "export const agent = new Agent({ name: 'orders', mcpServers: [...buildExternalMcpServers()] });"),
      'node_modules/fake-mcp/mcpServers.js': text('export const config = { token: "abcdefghijklmnopqrstuvwxyz" };'),
    },
    expect: { 'add-mcp-server': pass() },
  },
  'node-mcp-server-unattached': {
    files: {
      'package.json': json({ name: 'agent', type: 'module' }),
      'src/mcpServers.ts': NODE_MCP_SERVERS,
      'src/agent.ts': text("export const agent = new Agent({ name: 'orders', tools: [] });"),
    },
    expect: { 'add-mcp-server': fail('the external MCP servers are not attached') },
  },
  'dotnet-mcp-server': {
    files: {
      'Agent.csproj': CSPROJ,
      'ExternalMcpServers.cs': text('public static class ExternalMcpServers {',
        '  public static async Task<IList<McpClientTool>> ListToolsAsync() {',
        '    var transport = new StdioClientTransport(new() { Command = "npx" });',
        '    var token = Environment.GetEnvironmentVariable("GITHUB_TOKEN");',
        '    var client = await McpClientFactory.CreateAsync(transport);',
        '    return await client.ListToolsAsync();',
        '  }',
        '}'),
      'Program.cs': text('var builder = WebApplication.CreateBuilder(args);',
        'builder.AddAgent<HrAgent>();',
        'var app = builder.Build();',
        'app.MapAgentApplicationEndpoints(requireAuth: !app.Environment.IsDevelopment());',
        'app.MapGet("/api/health", () => Results.Ok());',
        'var external = await ExternalMcpServers.ListToolsAsync();',
        'app.Run();'),
      'a365.generated.config.json': HTTPS_ENDPOINT,
    },
    expect: { 'add-mcp-server': pass(), 'add-messaging-endpoint': pass() },
  },
  'python-blueprint-host': {
    files: {
      'requirements.txt': text('microsoft-agents-hosting-aiohttp'),
      'host.py': PY_HOST + text('', 'TOOL_OPTIONS = {"include_server_in_tool_names": True}'),
      'ToolingManifest.json': WORKIQ_MANIFEST,
      '.env': text('PYTHON_ENVIRONMENT=Production'),
      'a365.generated.config.json': HTTPS_ENDPOINT,
    },
    expect: { 'add-messaging-endpoint': pass() },
  },
  'python-blueprint-host-development': {
    files: {
      'requirements.txt': text('microsoft-agents-hosting-aiohttp'),
      'host.py': text('CONNECTIONS = MsalConnectionManager.from_environment()',
        'app.router.add_post("/api/messages", messages)',
        'app.router.add_get("/api/health", health)'),
      'ToolingManifest.json': WORKIQ_MANIFEST,
      '.env': text('PYTHON_ENVIRONMENT=Development'),
      'a365.generated.config.json': json({ messagingEndpoint: 'http://localhost:3978/api/msgs', completed: false }),
    },
    expect: {
      'add-messaging-endpoint': {
        ...fail('host uses MsalConnectionManager.from_environment()',
          'host does not apply jwt_authorization_middleware',
          'host does not call start_agent_process',
          'PYTHON_ENVIRONMENT=Development puts the tooling SDK in development mode; it will read BEARER_TOKEN_*',
          'messagingEndpoint is not HTTPS: http://localhost:3978/api/msgs',
          'messagingEndpoint does not end in /api/messages: http://localhost:3978/api/msgs'),
        warn: /Warning: 2 WorkIQ servers configured but include_server_in_tool_names is not set[^\n]*\n[^\n]*Warning: completed=false/,
      },
    },
  },
  'python-blueprint-host-no-environment': {
    files: {
      'pyproject.toml': text('[project]', 'name = "agent"'),
      'host.py': PY_HOST,
      'ToolingManifest.json': json({ servers: [{ name: 'mcp_MailTools' }] }),
      'a365.generated.config.json': '{ not json',
    },
    expect: {
      'add-messaging-endpoint': fail('WorkIQ is configured but no environment variable is set',
        'a365.generated.config.json cannot be parsed'),
    },
  },
  'python-no-host': {
    files: {
      'requirements.txt': text('openai-agents'),
      'app.py': text('print("hello")'),
      'a365.generated.config.json': json({ messagingEndpoint: '' }),
    },
    expect: {
      'add-messaging-endpoint': fail('no Python file serves both /api/messages and /api/health', 'messagingEndpoint is empty'),
    },
  },
  'node-blueprint-host': {
    files: {
      'package.json': json({ name: 'agent', type: 'module' }),
      'src/index.ts': NODE_HOST,
      'a365.generated.config.json': HTTPS_ENDPOINT,
    },
    expect: { 'add-messaging-endpoint': pass() },
  },
  'node-blueprint-host-anonymous': {
    files: {
      'package.json': json({ name: 'agent' }),
      'src/server.js': text("app.get('/api/health', health);", "app.post('/api/messages', messages);"),
    },
    expect: {
      'add-messaging-endpoint': fail('host does not apply authorizeJWT', 'a365.generated.config.json not found'),
    },
  },
  'dotnet-blueprint-host-anonymous': {
    files: {
      'Agent.csproj': CSPROJ,
      'Program.cs': text('var app = builder.Build();', 'app.MapAgentApplicationEndpoints(requireAuth: false);', 'app.Run();'),
      'a365.generated.config.json': HTTPS_ENDPOINT,
    },
    expect: {
      'add-messaging-endpoint': fail('no /api/health endpoint', 'MapAgentApplicationEndpoints(requireAuth: false) -- auth is off; not acceptable'),
    },
  },
  'ai-teammate': {
    files: {
      '.a365-workspace-detection.local.json': json({ programmingLanguage: 'Python', agentType: 'AI-Teammate' }),
      'requirements.txt': text('openai-agents'),
    },
    expect: { 'add-messaging-endpoint': pass({ note: /AI Teammate: hosting is owned by make-ai-teammate/ }) },
  },
  'detection-cache-nodejs': {
    files: {
      '.a365-workspace-detection.local.json': json({ programmingLanguage: 'NodeJS', agentType: 'blueprint' }),
      'requirements.txt': text('unused'),
      'src/server.ts': NODE_HOST,
      'a365.generated.config.json': HTTPS_ENDPOINT,
    },
    expect: {
      'add-messaging-endpoint': pass(),
      'add-lab-tools': fail('no lab-tools module found', 'the lab tools are not imported into the agent'),
    },
  },
  'detection-cache-null': {
    files: {
      '.a365-workspace-detection.local.json': 'null\n',
      'package.json': json({ name: 'agent' }),
    },
    expect: {
      'add-messaging-endpoint': fail('no Node.js file serves both /api/messages and /api/health', 'a365.generated.config.json not found'),
    },
  },
  'detection-cache-unknown-language': {
    files: {
      '.a365-workspace-detection.local.json': json({ programmingLanguage: 'Go' }),
      'go.mod': text('module example.com/agent'),
    },
    expect: {
      'add-messaging-endpoint': fail('could not determine the project language', 'a365.generated.config.json not found'),
      'add-mcp-server': fail('no external-MCP module found', 'the external MCP servers are not attached'),
    },
  },
  'java-dev-channel': {
    files: {
      'pom.xml': POM,
      ...JAVA_AGENT,
      [`${JAVA_DIR}/DevChannel.java`]: text('package com.contoso.agent.host;', '',
        '// Loopback only: 127.0.0.1, never "0.0.0.0".',
        'final class DevChannel {',
        '  static void start() throws IOException {',
        '    if (!"true".equals(System.getenv("A365_DEV_CHANNEL"))) return;',
        '    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 3979), 0);',
        '    server.createContext("/dev", exchange -> {',
        '      if (exchange.getRequestHeaders().containsKey("X-Forwarded-For")) { exchange.sendResponseHeaders(403, -1); }',
        '    });',
        '    System.err.println("DEV CHANNEL ENABLED on http://127.0.0.1:3979");',
        '  }',
        '}'),
      '.env': text('ENABLE_A365_OBSERVABILITY_EXPORTER=true', 'A365_DEV_CHANNEL=false'),
      '.env.example': text('ENABLE_A365_OBSERVABILITY_EXPORTER=false'),
      'a365.generated.config.json': HTTPS_ENDPOINT,
    },
    expect: { 'add-java-agent': pass(), 'test-local-channel': pass() },
  },
  'java-gradle-incomplete': {
    files: {
      'build.gradle': text("dependencies { implementation 'com.google.code.gson:gson:2.11.0' }"),
      [`${JAVA_DIR}/App.java`]: text('final class App {',
        '  static final String PATH = "/otlp/agents";',
        '  void tag(JsonObject a) { a.addProperty("key", "gen_ai.operation.name"); a.addProperty("stringValue", "invoke_agent"); }',
        '}'),
      '.env.example': text('ENABLE_A365_OBSERVABILITY_EXPORTER=false'),
    },
    expect: {
      'add-java-agent': fail('jackson-databind is not declared in the build file',
        'nimbus-jose-jwt is not declared in the build file',
        'No .java file serves /api/messages',
        'No inbound JWT validation found',
        'No .java file reads serviceUrl',
        'Exporter does not set microsoft.tenant.id',
        'Exporter does not set gen_ai.agent.id',
        'Exporter appears to emit OTLP keyValue attributes',
        'ENABLE_A365_OBSERVABILITY_EXPORTER is present but not "true" -- the agent is instrumented but exports nothing; set it',
        'a365.generated.config.json not found'),
      'test-local-channel': pass({ note: /No dev channel found/ }),
    },
  },
  'java-gradle-kts-no-sources': {
    files: {
      'build.gradle.kts': text('dependencies {', '  implementation("com.fasterxml.jackson.core:jackson-databind:2.18.0")',
        '  implementation("com.nimbusds:nimbus-jose-jwt:9.40")', '}'),
      'a365.generated.config.json': 'not json',
    },
    expect: {
      'add-java-agent': fail('No .java files found',
        'No .java file serves /api/messages',
        'No inbound JWT validation found',
        'No .java file reads serviceUrl',
        'a365.generated.config.json is not valid JSON'),
    },
  },
  'java-no-endpoint': {
    files: { 'pom.xml': POM, ...JAVA_AGENT, 'a365.generated.config.json': json({ completed: false }) },
    expect: { 'add-java-agent': fail('a365.generated.config.json has no messagingEndpoint') },
  },
  'java-http-endpoint': {
    files: { 'pom.xml': POM, ...JAVA_AGENT, 'a365.generated.config.json': json({ messagingEndpoint: 'http://localhost:3978/api/messages' }) },
    expect: { 'add-java-agent': fail('messagingEndpoint is not HTTPS') },
  },
  'dev-channel-python-unsafe': {
    files: {
      'requirements.txt': text('aiohttp'),
      'dev_channel.py': text('import os', '',
        'def start_dev_channel(app):',
        '    if os.getenv("A365_DEV_CHANNEL") != "true":',
        '        return',
        '    web.run_app(app, host="0.0.0.0", port=3979)'),
      'host.py': text('app.router.add_post("/api/messages", messages)'),
      '.env': text('A365_DEV_CHANNEL=true'),
    },
    expect: {
      'test-local-channel': fail('The dev channel does not bind 127.0.0.1 explicitly',
        'The file wiring the dev channel binds 0.0.0.0',
        'The dev channel does not refuse requests carrying forwarding headers',
        'A365_DEV_CHANNEL is set to true in .env',
        '/api/messages no longer shows any inbound token validation',
        'No startup warning found'),
    },
  },
  'dev-channel-node': {
    files: {
      'package.json': json({ name: 'agent', type: 'module' }),
      'src/devChannel.ts': text('// Loopback only: 127.0.0.1, never "0.0.0.0".',
        'export function startDevChannel() {',
        "  if (process.env.A365_DEV_CHANNEL !== 'true') return;",
        '  const server = http.createServer((req, res) => {',
        "    if (req.headers['x-forwarded-for']) { res.statusCode = 403; res.end(); }",
        '  });',
        "  server.listen(3979, '127.0.0.1');",
        "  console.warn('DEV CHANNEL ENABLED on http://127.0.0.1:3979');",
        '}'),
      '.env.example': text('A365_DEV_CHANNEL=false'),
    },
    expect: { 'test-local-channel': pass() },
  },
  'dev-channel-dotnet-silent': {
    files: {
      'Agent.csproj': CSPROJ,
      'DevChannel.cs': text('if (Environment.GetEnvironmentVariable("A365_DEV_CHANNEL") == "true") {',
        '  listener.Prefixes.Add("http://127.0.0.1:3979/");',
        '  if (request.Headers["X-Forwarded-For"] != null) Refuse(context);',
        '}'),
      'Program.cs': text('app.UseAuthorization();', 'app.MapPost("/api/messages", Handle);'),
    },
    expect: { 'test-local-channel': fail('No startup warning found') },
  },
};

const projects = new Map();
for (const [name, { files }] of Object.entries(FIXTURES)) {
  const dir = path.join(tmp, 'projects', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), content);
  }
  projects.set(`fixture:${name}`, dir);
}
for (const name of fs.readdirSync(path.join(repo, 'examples')).sort()) {
  projects.set(`examples/${name}`, path.join(repo, 'examples', name));
}
// CI runs the validators from kit/.
projects.set('kit', path.join(repo, 'kit'));

const env = { ...process.env, VALIDATE_SKIP_EXEC: '1' };
delete env.NODE_TEST_CONTEXT;

function runValidator(name, cwd) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(hooks, 'stop', `validate-${name}.js`)],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), HOOK_TIMEOUT_MS);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

const jobs = [];
for (const [project, dir] of projects) {
  for (const validator of VALIDATORS) jobs.push({ key: `${project} | ${validator}`, run: () => runValidator(validator, dir) });
}
const results = new Map();
let next = 0;
const workers = Math.max(2, os.availableParallelism?.() ?? os.cpus().length);
await Promise.all(Array.from({ length: workers }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++];
    results.set(job.key, await job.run());
  }
}));

if (process.env.KIT_VALIDATORS_RECORD) {
  const sorted = Object.fromEntries([...results].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  fs.writeFileSync(process.env.KIT_VALIDATORS_RECORD, JSON.stringify(sorted, null, 2) + '\n');
}

const separators = value => value.split('; ').length - 1;

function assertVerdict(result, expected, label) {
  assert.equal(result.signal, null, `${label}: killed (${result.signal})`);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.ok, expected.ok, `${label}: ${result.stdout}`);
  assert.equal(result.status, expected.ok ? 0 : 1, label);
  if (expected.ok) {
    assert.deepEqual(Object.keys(verdict), expected.note ? ['ok', 'note'] : ['ok'], label);
    if (expected.note) assert.match(verdict.note, expected.note, label);
  } else {
    assert.deepEqual(Object.keys(verdict), ['ok', 'reason'], label);
    // Issues are joined with "; ", which a few messages also contain, so the expected
    // phrases include those inner separators and the count allows for them.
    let from = 0;
    for (const issue of expected.issues) {
      const at = verdict.reason.indexOf(issue, from);
      assert.ok(at >= from, `${label}: expected "${issue}" in order in: ${verdict.reason}`);
      from = at + issue.length;
    }
    const expectedSeparators = expected.issues.length - 1 + expected.issues.reduce((n, issue) => n + separators(issue), 0);
    assert.equal(separators(verdict.reason), expectedSeparators, `${label}: unexpected issue count in: ${verdict.reason}`);
  }
  if (expected.warn) assert.match(result.stderr, expected.warn, label);
  else assert.equal(result.stderr, '', label);
}

test('every validator emits one JSON verdict and the matching exit code for every project', () => {
  assert.equal(results.size, projects.size * VALIDATORS.length);
  for (const [key, result] of results) {
    assert.equal(result.signal, null, `${key}: killed (${result.signal})`);
    const verdict = JSON.parse(result.stdout);
    assert.equal(typeof verdict.ok, 'boolean', key);
    assert.equal(result.status, verdict.ok ? 0 : 1, key);
    assert.match(result.stderr, /^(\[validate-[a-z-]+\] Warning: [^\n]*\n)*$/, `${key}: ${result.stderr}`);
  }
});

for (const [name, fixture] of Object.entries(FIXTURES)) {
  test(`fixture ${name}`, () => {
    for (const [validator, expected] of Object.entries(fixture.expect)) {
      const key = `fixture:${name} | ${validator}`;
      assertVerdict(results.get(key), expected, key);
    }
  });
}
