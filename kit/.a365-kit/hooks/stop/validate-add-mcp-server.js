#!/usr/bin/env node
// Static checks that an external MCP module exists, uses the SDK's MCP classes, is
// attached to the agent without displacing the Work IQ servers and holds no hard-coded
// secrets.

'use strict';

const { read, scan, detect, finish, filterByName } = require('../lib/kit-validator');

const issues = [];
const { language } = detect();
const all = scan();
const modPattern = { python: /mcp_servers\.py$/, nodejs: /mcp[Ss]ervers\.(ts|js|mjs)$/, dotnet: /ExternalMcpServers\.cs$/ }[language];
const modFiles = modPattern ? all.filter(f => modPattern.test(f)) : [];

if (!modFiles.length) {
  issues.push('no external-MCP module found (expected mcp_servers.py / mcpServers.ts / ExternalMcpServers.cs) -- add-mcp-server did not create it');
} else {
  const modText = modFiles.map(read).join('\n');
  if (!/MCPServerStdio|MCPServerStreamableHttp|MCPServerSse|McpClientFactory|StdioClientTransport/.test(modText)) {
    issues.push('external-MCP module does not reference an SDK MCP class (MCPServerStdio / MCPServerStreamableHttp / McpClientFactory)');
  }
  // A token-shaped literal assigned inline counts as a hard-coded secret.
  if (/(token|secret|password|connectionstring|conn_str)\s*[:=]\s*["'][A-Za-z0-9._~+/\-]{16,}/i.test(modText)
      && !/getenv|process\.env|Environment\.GetEnvironmentVariable/i.test(modText)) {
    issues.push('a credential looks hard-coded in the external-MCP module -- read it from the environment instead');
  }
}

function agentFiles() {
  switch (language) {
    case 'python': return filterByName(all, '.py').filter(f => /mcp_servers\s*=/.test(read(f)));
    case 'nodejs': return all.filter(f => /\.(ts|js|mjs)$/.test(f) && /mcpServers\s*:/.test(read(f)));
    case 'dotnet': return filterByName(all, '.cs').filter(f => /ExternalMcpServers|ListToolsAsync|AddAgent/.test(read(f)));
    default: return [];
  }
}
const agentText = agentFiles().map(read).join('\n');

if (!/EXTERNAL_MCP_SERVERS|buildExternalMcpServers|ExternalMcpServers|externalMcp/.test(agentText)) {
  issues.push('the external MCP servers are not attached to the agent -- append them to mcp_servers (do not replace the Work IQ servers)');
}

// With Work IQ also present, tool names must be namespaced by server or they can collide.
if (language === 'python') {
  const pyText = all.filter(f => f.endsWith('.py')).map(read).join('\n');
  if (/add_tool_servers_to_agent|setup_workiq_tools/.test(pyText) && !/include_server_in_tool_names/.test(agentText + pyText)) {
    console.warn('[validate-add-mcp-server] Warning: Work IQ and external MCP are both present but include_server_in_tool_names is not set -- tool names can collide across servers');
  }
}

finish(issues);
