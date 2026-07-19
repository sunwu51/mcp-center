/**
 * OAuth integration tests for mcp-center.
 *
 * These tests verify that:
 *   1. A server with useOAuth:true that requires OAuth is loaded with status "needs_auth"
 *   2. The OAuth callback handler exchanges the code for tokens
 *   3. After tokens are saved, the server connects successfully
 *   4. Tools from the OAuth-protected server are exposed through the gateway
 */

import { createServer as createHttpServer } from 'http';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

// We need to test the oauth module directly
// The token store file is at ~/.mcp-center/oauth-tokens.json
// We'll use a temporary approach by setting HOME env

const TEST_HOME = resolve(homedir(), '.mcp-center-test-oauth-' + process.pid);

// Test OAuth MCP server (spawned as child process)
let oauthServerProcess = null;
const OAUTH_SERVER_PORT = 3299;

function startOAuthServer() {
  return new Promise((resolve, reject) => {
    oauthServerProcess = spawn('node', ['tests/test-oauth-mcp-server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, OAUTH_SERVER_PORT: String(OAUTH_SERVER_PORT) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    oauthServerProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Listening on')) {
        resolve();
      }
    });

    oauthServerProcess.on('error', reject);
    setTimeout(() => resolve(), 3000);
  });
}

function stopOAuthServer() {
  if (oauthServerProcess) {
    oauthServerProcess.kill();
    oauthServerProcess = null;
  }
}

// Helper: sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('OAuth integration', () => {
  beforeAll(async () => {
    // Create test home directory
    if (!existsSync(TEST_HOME)) mkdirSync(TEST_HOME, { recursive: true });
    process.env.HOME = TEST_HOME;
    process.env.PORT = '0'; // don't conflict with real server

    await startOAuthServer();
  }, 10000);

  afterAll(() => {
    stopOAuthServer();
    // Cleanup test home
    try {
      const tokenFile = resolve(TEST_HOME, '.mcp-center', 'oauth-tokens.json');
      if (existsSync(tokenFile)) unlinkSync(tokenFile);
    } catch {}
  });

  describe('OAuth module', () => {
    it('should create a provider with correct redirect URL and metadata', async () => {
      const { getOrCreateProvider, getCallbackPort } = await import('../src/oauth.js');

      const originalPort = process.env.PORT;
      process.env.PORT = '3500';
      const provider = getOrCreateProvider('test-server', `http://localhost:${OAUTH_SERVER_PORT}/mcp`);

      expect(provider.redirectUrl).toContain('/oauth/callback');
      expect(provider.clientMetadata.client_name).toContain('test-server');
      expect(provider.clientMetadata.grant_types).toContain('authorization_code');
      expect(provider.clientMetadata.grant_types).toContain('refresh_token');
      expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none');

      process.env.PORT = originalPort;
    });

    it('should save and load tokens', async () => {
      const { getOrCreateProvider } = await import('../src/oauth.js');
      const provider = getOrCreateProvider('token-test', `http://localhost:${OAUTH_SERVER_PORT}/mcp`);

      provider.saveTokens({
        access_token: 'test-access',
        token_type: 'Bearer',
        refresh_token: 'test-refresh',
        expires_in: 3600,
      });

      const tokens = provider.tokens();
      expect(tokens).toBeTruthy();
      expect(tokens.access_token).toBe('test-access');
      expect(tokens.refresh_token).toBe('test-refresh');
    });

    it('should save and load code verifier', async () => {
      const { getOrCreateProvider } = await import('../src/oauth.js');
      const provider = getOrCreateProvider('verifier-test', `http://localhost:${OAUTH_SERVER_PORT}/mcp`);

      provider.saveCodeVerifier('test-verifier-123');
      expect(provider.codeVerifier()).toBe('test-verifier-123');
    });

    it('should save and load client information', async () => {
      const { getOrCreateProvider } = await import('../src/oauth.js');
      const provider = getOrCreateProvider('clientinfo-test', `http://localhost:${OAUTH_SERVER_PORT}/mcp`);

      provider.saveClientInformation({ client_id: 'test-client-id' });
      const info = provider.clientInformation();
      expect(info).toBeTruthy();
      expect(info.client_id).toBe('test-client-id');
    });

    it('should store pending auth URL in redirectToAuthorization', async () => {
      const { getOrCreateProvider, getPendingAuth, clearPendingAuth } = await import('../src/oauth.js');
      const provider = getOrCreateProvider('pending-test', `http://localhost:${OAUTH_SERVER_PORT}/mcp`);

      const authUrl = new URL('http://example.com/authorize');
      authUrl.searchParams.set('state', 'test-state-123');
      authUrl.searchParams.set('client_id', 'test-client');

      await provider.redirectToAuthorization(authUrl);

      const pending = getPendingAuth('pending-test');
      expect(pending).toBeTruthy();
      expect(pending.state).toBe('test-state-123');
      expect(pending.url).toContain('example.com/authorize');

      clearPendingAuth('pending-test');
    });

    it('should report correct auth status', async () => {
      const { getOrCreateProvider, getAuthStatus, clearStoredCredentials } = await import('../src/oauth.js');
      const provider = getOrCreateProvider('status-test', `http://localhost:${OAUTH_SERVER_PORT}/mcp`);

      clearStoredCredentials('status-test');
      let status = getAuthStatus('status-test');
      expect(status.status).toBe('needs_auth');
      expect(status.authUrl).toBeNull();

      provider.saveTokens({ access_token: 'token', token_type: 'Bearer' });
      status = getAuthStatus('status-test');
      expect(status.status).toBe('authorized');

      clearStoredCredentials('status-test');
    });
  });

  describe('Loader with OAuth', () => {
    it('should set status to needs_auth when OAuth server requires authorization', async () => {
      const { loadServer, getServerStatus, closeAllServers } = await import('../src/loader.js');
      const { clearStoredCredentials } = await import('../src/oauth.js');

      const serverName = 'oauth-protected-' + randomUUID().slice(0, 8);
      clearStoredCredentials(serverName);

      const config = {
        name: serverName,
        url: `http://localhost:${OAUTH_SERVER_PORT}/mcp`,
        useOAuth: true,
      };

      try {
        await loadServer(config);
      } catch {
        // Expected to throw UnauthorizedError
      }

      const status = getServerStatus().get(serverName);
      expect(status).toBeTruthy();
      expect(status.status).toBe('needs_auth');
      expect(status.authUrl).toBeTruthy();
      expect(status.authUrl).toContain('/authorize');

      closeAllServers();
    }, 15000);

    it('should connect successfully after tokens are stored', async () => {
      const { loadServer, getServerStatus, getLoadedServers, closeAllServers } = await import('../src/loader.js');
      const { getOrCreateProvider, clearPendingAuth, clearStoredCredentials, handleOAuthCallback } = await import('../src/oauth.js');

      const serverName = 'oauth-connected-' + randomUUID().slice(0, 8);
      clearStoredCredentials(serverName);

      const serverUrl = `http://localhost:${OAUTH_SERVER_PORT}/mcp`;
      const config = { name: serverName, url: serverUrl, useOAuth: true };

      try {
        await loadServer(config);
      } catch {
        // Expected
      }

      const statusAfterLoad = getServerStatus().get(serverName);
      expect(statusAfterLoad.status).toBe('needs_auth');
      expect(statusAfterLoad.authUrl).toBeTruthy();

      const authUrl = new URL(statusAfterLoad.authUrl);
      const state = authUrl.searchParams.get('state');
      const code = randomUUID();

      const { getPendingAuth } = await import('../src/oauth.js');
      const pending = getPendingAuth(serverName);
      expect(pending).toBeTruthy();

      // Manually register the code in the test server
      // We need to actually do the OAuth flow through the test server's /authorize endpoint
      // Instead, let's directly call the authorize endpoint to get a real code
      const redirectUri = authUrl.searchParams.get('redirect_uri');
      const clientId = authUrl.searchParams.get('client_id');
      const scope = authUrl.searchParams.get('scope') || '';
      const codeChallenge = authUrl.searchParams.get('code_challenge');
      const codeChallengeMethod = authUrl.searchParams.get('code_challenge_method');

      const authorizeUrl = new URL(`http://localhost:${OAUTH_SERVER_PORT}/authorize`);
      authorizeUrl.searchParams.set('state', state);
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('client_id', clientId);
      if (scope) authorizeUrl.searchParams.set('scope', scope);
      if (codeChallenge) authorizeUrl.searchParams.set('code_challenge', codeChallenge);
      if (codeChallengeMethod) authorizeUrl.searchParams.set('code_challenge_method', codeChallengeMethod);
      authorizeUrl.searchParams.set('response_type', 'code');

      // Make the authorize request — it will redirect to our callback URL with the code
      const authorizeResponse = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
      const location = authorizeResponse.headers.get('location');
      expect(location).toBeTruthy();

      const callbackUrl = new URL(location);
      const realCode = callbackUrl.searchParams.get('code');
      const realState = callbackUrl.searchParams.get('state');
      expect(realCode).toBeTruthy();
      expect(realState).toBe(state);

      // Handle the callback — this exchanges the code for tokens
      const result = await handleOAuthCallback(realCode, realState);
      expect(result.serverName).toBe(serverName);

      // Now reload the server — it should connect with the stored tokens
      await loadServer(config);

      const finalStatus = getServerStatus().get(serverName);
      expect(finalStatus.status).toBe('connected');

      const loaded = getLoadedServers().get(serverName);
      expect(loaded).toBeTruthy();
      expect(loaded.tools.length).toBeGreaterThan(0);
      expect(loaded.tools[0].name).toContain('fetch_data');

      closeAllServers();
      clearStoredCredentials(serverName);
    }, 20000);
  });

  describe('Config validation with OAuth', () => {
    it('should accept useOAuth in server config', async () => {
      const { loadConfig } = await import('../src/config.js');
      const tmpConfig = resolve(TEST_HOME, 'test-oauth-config.json');
      writeFileSync(tmpConfig, JSON.stringify({
        servers: [
          { name: 'test-oauth', url: 'http://localhost:9999/mcp', useOAuth: true },
          { name: 'test-no-oauth', url: 'http://localhost:9998/mcp' },
        ],
      }), 'utf-8');

      const config = loadConfig(tmpConfig);
      expect(config.servers[0].useOAuth).toBe(true);
      expect(config.servers[1].useOAuth).toBeUndefined();

      unlinkSync(tmpConfig);
    });

    it('should reject invalid useOAuth value', async () => {
      const { loadConfig } = await import('../src/config.js');
      const tmpConfig = resolve(TEST_HOME, 'test-oauth-invalid.json');
      writeFileSync(tmpConfig, JSON.stringify({
        servers: [{ name: 'bad', url: 'http://localhost:9999/mcp', useOAuth: 'yes' }],
      }), 'utf-8');

      expect(() => loadConfig(tmpConfig)).toThrow();

      unlinkSync(tmpConfig);
    });
  });
});
