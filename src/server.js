#!/usr/bin/env node

import { createServer as createHttpServer } from 'http';
import { randomUUID } from 'crypto';
import { UI_HTML } from './ui.js';
import { warn as logWarn, error as logError } from './log.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  loadAllServers,
  reloadServer,
  getAllTools,
  getAllResources,
  getAllResourceTemplates,
  getAllPrompts,
  callTool,
  readResource,
  getPrompt,
  closeAllServers,
  getLoadedServers,
  getServerStatus,
} from './loader.js';
import { loadConfig, watchConfig, getConfig, ensureDefaultConfig, unwatchConfig, saveConfig } from './config.js';
import { createWsServer, closeWsBridgeServers, getWsBridgeServers } from './wsBridge.js';
import {
  handleOAuthCallback,
  getPendingAuth,
  getAuthStatus,
  clearStoredCredentials,
} from './oauth.js';

let reloadInFlight = null;
let reloadQueued = false;

/**
 * Create an MCP Server instance with tool handlers
 * @returns {Server}
 */
export function createMcpServer() {
  const srv = new Server(
    { name: 'mcp-center', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  srv.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = getAllTools();
    return {
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await callTool(name, args);
      return result;
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message || String(error)}` }],
        isError: true,
      };
    }
  });

  srv.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = getAllResources();
    return {
      resources: resources.map(resource => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      })),
    };
  });

  srv.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const resourceTemplates = getAllResourceTemplates();
    return {
      resourceTemplates: resourceTemplates.map(rt => ({
        uriTemplate: rt.uriTemplate,
        name: rt.name,
        description: rt.description,
        mimeType: rt.mimeType,
      })),
    };
  });

  srv.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    try {
      const result = await readResource(uri);
      return result;
    } catch (error) {
      return {
        contents: [{ uri, mimeType: 'text/plain', text: `Error: ${error.message || String(error)}` }],
      };
    }
  });

  srv.setRequestHandler(ListPromptsRequestSchema, async () => {
    const prompts = getAllPrompts();
    return {
      prompts: prompts.map(prompt => ({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments,
      })),
    };
  });

  srv.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await getPrompt(name, args);
      return result;
    } catch (error) {
      return {
        messages: [{ role: 'user', content: { type: 'text', text: `Error: ${error.message || String(error)}` } }],
      };
    }
  });

  return srv;
}

/**
 * Reload all servers based on current config
 * @returns {Promise<void>}
 */
async function reloadAllServers() {
  const config = getConfig();
  if (!config) return;

  logError('[mcp-center] Reloading servers...');

  const loadedServers = getLoadedServers();
  const currentServers = new Map(Array.from(loadedServers.entries()).map(([name, server]) => [name, server]));
  const newServerConfigs = new Map(config.servers.map(s => [s.name, s]));

  // Close servers not in new config
  for (const [name, loaded] of currentServers) {
    if (!newServerConfigs.has(name)) {
      try {
        await loaded.client.close();
        loadedServers.delete(name);
        logError(`[mcp-center] Removed server "${name}"`);
      } catch (error) {
        logWarn(`[mcp-center] Error closing server "${name}":`, error);
      }
    }
  }

  // Reload all servers in parallel
  const reloadPromises = config.servers.map(async (serverConfig) => {
    try {
      await reloadServer(serverConfig);
    } catch (error) {
      logError(`[mcp-center] Failed to reload server "${serverConfig.name}":`, error);
    }
  });

  await Promise.all(reloadPromises);

  logError('[mcp-center] Reload complete');
}

/**
 * Serialize reloads and coalesce overlapping requests.
 * @returns {Promise<void>}
 */
function scheduleReloadAllServers() {
  if (reloadInFlight) {
    reloadQueued = true;
    return reloadInFlight;
  }

  reloadInFlight = (async () => {
    do {
      reloadQueued = false;
      await reloadAllServers();
    } while (reloadQueued);
  })().finally(() => {
    reloadInFlight = null;
  });

  return reloadInFlight;
}

function triggerReloadAllServers() {
  scheduleReloadAllServers().catch((error) => {
    logError('[mcp-center] Background reload failed:', error);
  });
}


/**
 * Run in HTTP mode with API and UI
 * @param {number} port
 * @returns {Promise<void>}
 */
async function runHttp(port) {
  const sessions = new Map();

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Serve UI
    if (url.pathname === '/' || url.pathname === '/ui') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(UI_HTML);
      return;
    }

    // API: Get all servers
    if (url.pathname === '/api/servers' && req.method === 'GET') {
      const config = getConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config.servers));
      return;
    }

    // API: Get server status
    if (url.pathname === '/api/servers/status' && req.method === 'GET') {
      const status = {};
      for (const [name, s] of getServerStatus()) {
        status[name] = s;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    // API: Get capabilities (tools/resources/templates/prompts) for a loaded server
    if (url.pathname.match(/^\/api\/servers\/([^/]+)\/capabilities$/) && req.method === 'GET') {
      const serverName = decodeURIComponent(url.pathname.split('/')[3]);
      const loaded = getLoadedServers().get(serverName);
      if (!loaded) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server not found or not connected' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tools: loaded.tools.map(t => ({ name: t.originalName, description: t.description })),
        resources: loaded.resources.map(r => ({ uri: r.originalUri, name: r.name, description: r.description })),
        resourceTemplates: loaded.resourceTemplates.map(r => ({ uriTemplate: r.originalUriTemplate, name: r.name, description: r.description })),
        prompts: loaded.prompts.map(p => ({ name: p.originalName, description: p.description })),
      }));
      return;
    }

    // API: Probe a server config (temporary connection) to list its tools
    if (url.pathname === '/api/probe' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const config = JSON.parse(body);
          const { probeServer } = await import('./loader.js');
          const result = await probeServer(config);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

    // API: Add server
    if (url.pathname === '/api/servers' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const server = JSON.parse(body);
          const config = getConfig();
          config.servers.push(server);
          saveConfig(config);
          triggerReloadAllServers();
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, reloading: true }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

    // API: Update server
    if (url.pathname.startsWith('/api/servers/') && req.method === 'PUT') {
      const index = parseInt(url.pathname.split('/')[3]);
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const server = JSON.parse(body);
          const config = getConfig();
          if (index < 0 || index >= config.servers.length) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Server not found' }));
            return;
          }
          config.servers[index] = server;
          saveConfig(config);
          triggerReloadAllServers();
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, reloading: true }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

    // API: Toggle server enabled/disabled
    if (url.pathname.match(/^\/api\/servers\/\d+\/toggle$/) && req.method === 'PATCH') {
      try {
        const index = parseInt(url.pathname.split('/')[3]);
        const config = getConfig();
        if (index < 0 || index >= config.servers.length) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Server not found' }));
          return;
        }
        // Toggle: if enabled is undefined or true, set to false; otherwise set to true
        config.servers[index].enabled = config.servers[index].enabled === false ? true : false;
        saveConfig(config);
        triggerReloadAllServers();
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, enabled: config.servers[index].enabled, reloading: true }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // API: Delete server
    if (url.pathname.startsWith('/api/servers/') && req.method === 'DELETE') {
      try {
        const index = parseInt(url.pathname.split('/')[3]);
        const config = getConfig();
        if (index < 0 || index >= config.servers.length) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Server not found' }));
          return;
        }
        config.servers.splice(index, 1);
        saveConfig(config);
        triggerReloadAllServers();
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, reloading: true }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // API: Get wsBridge servers (auto-registered, not in config)
    if (url.pathname === '/api/wsbridge/servers' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getWsBridgeServers()));
      return;
    }

    // API: Get OAuth auth URL for a server that needs authorization
    if (url.pathname.match(/^\/api\/servers\/([^/]+)\/auth-url$/) && req.method === 'GET') {
      const serverName = decodeURIComponent(url.pathname.split('/')[3]);
      const config = getConfig();
      const serverConfig = config.servers.find(s => s.name === serverName);
      if (!serverConfig) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server not found' }));
        return;
      }
      if (!serverConfig.useOAuth) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server does not use OAuth' }));
        return;
      }
      const authStatus = getAuthStatus(serverName);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(authStatus));
      return;
    }

    // API: Trigger re-authorization for a server (reloads to generate new auth URL)
    if (url.pathname.match(/^\/api\/servers\/([^/]+)\/reauth$/) && req.method === 'POST') {
      const serverName = decodeURIComponent(url.pathname.split('/')[3]);
      const config = getConfig();
      const serverConfig = config.servers.find(s => s.name === serverName);
      if (!serverConfig) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server not found' }));
        return;
      }
      if (!serverConfig.useOAuth) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server does not use OAuth' }));
        return;
      }

      clearStoredCredentials(serverName);

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { reloadServer, getLoadedServers } = await import('./loader.js');

          const loadedServers = getLoadedServers();
          const existing = loadedServers.get(serverName);
          if (existing) {
            if (existing.client) {
              try { await existing.client.close(); } catch (_) {}
            }
            loadedServers.delete(serverName);
          }

          await reloadServer(serverConfig);
          const pending = getPendingAuth(serverName);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            authUrl: pending?.url || null,
            status: pending ? 'needs_auth' : 'connected',
          }));
        } catch (error) {
          const pending = getPendingAuth(serverName);
          if (pending) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              authUrl: pending.url,
              status: 'needs_auth',
            }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              authUrl: null,
              status: 'needs_auth',
              error: error.message,
            }));
          }
        }
      });
      return;
    }

    // API: Clear OAuth credentials for a server
    if (url.pathname.match(/^\/api\/servers\/([^/]+)\/oauth-clear$/) && req.method === 'POST') {
      const serverName = decodeURIComponent(url.pathname.split('/')[3]);
      clearStoredCredentials(serverName);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // OAuth callback endpoint — receives redirect from OAuth provider
    if (url.pathname === '/oauth/callback' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const errorParam = url.searchParams.get('error');

      if (errorParam) {
        const errorDesc = url.searchParams.get('error_description') || errorParam;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center">
          <h2 style="color:#dc3545">Authorization Failed</h2>
          <p>${errorDesc}</p>
          <p><a href="/ui">Back to MCP Center</a></p>
        </body></html>`);
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>Missing code or state parameter</h2><p><a href="/ui">Back to MCP Center</a></p></body></html>');
        return;
      }

      try {
        const { serverName } = await handleOAuthCallback(code, state);

        const config = getConfig();
        const serverConfig = config.servers.find(s => s.name === serverName);
        if (serverConfig) {
          const { reloadServer } = await import('./loader.js');
          await reloadServer(serverConfig);
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center">
          <h2 style="color:#28a745">Authorization Successful</h2>
          <p>Server "${serverName}" has been authorized and reloaded.</p>
          <p><a href="/ui">Back to MCP Center</a></p>
          <script>setTimeout(() => { window.location.href = '/ui'; }, 2000);</script>
        </body></html>`);
      } catch (error) {
        logError('[mcp-center] OAuth callback error:', error);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center">
          <h2 style="color:#dc3545">Authorization Failed</h2>
          <p>${error.message || String(error)}</p>
          <p><a href="/ui">Back to MCP Center</a></p>
        </body></html>`);
      }
      return;
    }

    // MCP endpoint
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const sessionId = randomUUID();
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport('/mcp', sessionId);
      sessions.set(sessionId, { server: mcpServer, transport });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    if (url.pathname.startsWith('/mcp/') && req.method === 'POST') {
      const sessionId = url.pathname.split('/')[2];
      if (sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        await session.transport.handleRequest(req, res);
        sessions.delete(sessionId);
      } else {
        res.writeHead(404);
        res.end('Session not found');
      }
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  await new Promise((resolve, reject) => {
    httpServer.listen(port, () => {
      logError(`[mcp-center] HTTP server running on http://localhost:${port}`);
      logError(`[mcp-center] UI available at http://localhost:${port}/ui`);
      logError(`[mcp-center] MCP endpoint at http://localhost:${port}/mcp`);
      resolve();
    });
    httpServer.on('error', reject);
  });

  createWsServer(httpServer);
  logError(`[mcp-center] WebSocket bridge listening at ws://localhost:${port}/ws/:serverName`);

  const shutdown = async () => {
    logError('[mcp-center] Shutting down...');
    unwatchConfig();
    closeWsBridgeServers();
    await closeAllServers();
    httpServer.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return httpServer;
}

/**
 * Main entry point to run the mcp-center server
 * @param {string|undefined} configPath
 * @returns {Promise<void>}
 */
export async function runServer(configPath) {
  const path = configPath || ensureDefaultConfig();
  logError(`[mcp-center] Loading config from: ${path}`);

  const config = loadConfig(path);
  logError(`[mcp-center] Loaded ${config.servers.length} server(s) from config`);

  await loadAllServers(config.servers);

  watchConfig(() => {
    triggerReloadAllServers();
  });

  logError('[mcp-center] Starting MCP Center server (HTTP transport)...');

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  await runHttp(port);
}

function parseArgs() {
  const args = process.argv.slice(2);

  let configPath;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--config' || arg === '-c') {
      configPath = args[i + 1];
      i++;
    } else if (!arg.startsWith('-')) {
      configPath = arg;
    }
  }

  return { configPath };
}

async function main() {
  const { configPath } = parseArgs();

  try {
    await runServer(configPath);
  } catch (error) {
    logError('[mcp-center] Fatal error:', error);
    process.exit(1);
  }
}

main();
