/**
 * Test OAuth-protected HTTP MCP server.
 *
 * Implements:
 *   - RFC 9728 protected resource metadata at /.well-known/oauth-protected-resource
 *   - RFC 8414 authorization server metadata at /.well-known/oauth-authorization-server
 *   - Authorization endpoint at /authorize
 *   - Token endpoint at /token
 *   - MCP endpoint at /mcp (requires Bearer token)
 *
 * Usage: node tests/test-oauth-mcp-server.js
 */
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PORT = process.env.OAUTH_SERVER_PORT ? parseInt(process.env.OAUTH_SERVER_PORT) : 3201;
const ISSUER = `http://localhost:${PORT}`;

const validAuthCodes = new Map();
const issuedTokens = new Map();

function createMcpServer() {
  const srv = new Server(
    { name: 'test-oauth-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'fetch_data',
      description: 'Fetches protected data',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    }],
  }));

  srv.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: 'text', text: `Data for: ${req.params.arguments?.query || 'all'}` }],
  }));

  return srv;
}

const sessions = new Map();

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      resource: `${ISSUER}/mcp`,
      authorization_servers: [ISSUER],
      scopes_supported: ['mcp:tools'],
      bearer_methods_supported: ['header'],
    }));
    return;
  }

  if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:tools'],
    }));
    return;
  }

  if (url.pathname === '/register' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const clientId = randomUUID();
      const redirectUris = parsed.redirect_uris || ['http://localhost:3000/oauth/callback'];
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        client_id: clientId,
        token_endpoint_auth_method: 'none',
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: parsed.client_name || 'mcp-center',
      }));
    });
    return;
  }

  if (url.pathname === '/authorize' && req.method === 'GET') {
    const code = randomUUID();
    const state = url.searchParams.get('state') || '';
    const redirectUri = url.searchParams.get('redirect_uri');
    validAuthCodes.set(code, { state, redirectUri, expires: Date.now() + 60000 });

    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);

    res.writeHead(302, { Location: callbackUrl.toString() });
    res.end();
    return;
  }

  if (url.pathname === '/token' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const grantType = params.get('grant_type');
      const code = params.get('code');
      const refreshToken = params.get('refresh_token');

      if (grantType === 'authorization_code') {
        const stored = validAuthCodes.get(code);
        if (!stored) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        validAuthCodes.delete(code);

        const accessToken = randomUUID();
        const newRefreshToken = randomUUID();
        issuedTokens.set(accessToken, { refreshToken: newRefreshToken, valid: true });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: newRefreshToken,
          scope: 'mcp:tools',
        }));
        return;
      }

      if (grantType === 'refresh_token') {
        for (const [accessToken, info] of issuedTokens) {
          if (info.refreshToken === refreshToken) {
            const newAccessToken = randomUUID();
            const newRefreshToken = randomUUID();
            issuedTokens.delete(accessToken);
            issuedTokens.set(newAccessToken, { refreshToken: newRefreshToken, valid: true });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              access_token: newAccessToken,
              token_type: 'Bearer',
              expires_in: 3600,
              refresh_token: newRefreshToken,
              scope: 'mcp:tools',
            }));
            return;
          }
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
    });
    return;
  }

  if (url.pathname === '/mcp' && req.method === 'POST') {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
      });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const token = auth.slice(7);
    if (!issuedTokens.has(token) || !issuedTokens.get(token).valid) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
      });
      res.end(JSON.stringify({ error: 'Invalid token' }));
      return;
    }

    const sessionId = randomUUID();
    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport('/mcp', sessionId);
    sessions.set(sessionId, { server: mcpServer, transport });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  if (url.pathname.startsWith('/mcp/') && req.method === 'POST') {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
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

httpServer.listen(PORT, () => {
  console.error(`[test-oauth-mcp-server] Listening on http://localhost:${PORT}`);
  console.error(`[test-oauth-mcp-server] MCP endpoint: http://localhost:${PORT}/mcp (requires OAuth)`);
});
