import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { createProxyFetch } from './proxy.js';
import { log as logMessage, warn as logWarn, error as logError } from './log.js';

/**
 * Pending OAuth authorization entries keyed by state parameter.
 * @type {Map<string, {serverName: string, serverUrl: string, authorizationUrl: string, timestamp: number}>}
 */
const pendingAuths = new Map();

/**
 * Provider instances keyed by server name.
 * @type {Map<string, FileOAuthClientProvider>}
 */
const providers = new Map();

/** @type {Map<string, NodeJS.Timeout>} */
const refreshTimers = new Map();

const TOKEN_REFRESH_LEAD_TIME_MS = 10 * 60 * 1000;

/**
 * Get the path to the OAuth token store file.
 * @returns {string}
 */
function getTokensFilePath() {
  return resolve(homedir(), '.mcp-center', 'oauth-tokens.json');
}

/**
 * Load the entire token store from disk.
 * @returns {object}
 */
function loadTokenStore() {
  const path = getTokensFilePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Persist the token store to disk.
 * @param {object} store
 */
function saveTokenStore(store) {
  const path = getTokensFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), 'utf-8');
}

function scheduleTokenRefresh(provider, tokens) {
  const existingTimer = refreshTimers.get(provider.serverName);
  if (existingTimer) clearTimeout(existingTimer);

  if (!tokens?.refresh_token || !tokens.expires_at) return;

  const delay = Math.max(1000, tokens.expires_at - Date.now() - TOKEN_REFRESH_LEAD_TIME_MS);
  const timer = setTimeout(async () => {
    refreshTimers.delete(provider.serverName);
    try {
      const result = await auth(provider, { serverUrl: provider.serverUrl, fetchFn: provider.fetch });
      if (result === 'AUTHORIZED') {
        logMessage(`[mcp-center] OAuth token refreshed for "${provider.serverName}"`);
      }
    } catch (error) {
      logWarn(`[mcp-center] OAuth token refresh failed for "${provider.serverName}":`, error);
    }
  }, delay);
  timer.unref?.();
  refreshTimers.set(provider.serverName, timer);
}

/**
 * Get the callback port for OAuth redirects.
 * Reads from PORT env or defaults to 3000.
 * @returns {number}
 */
export function getCallbackPort() {
  return process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
}

/**
 * A file-backed OAuthClientProvider implementation.
 *
 * Stores tokens, client information, code verifiers, and discovery state
 * in a JSON file at ~/.mcp-center/oauth-tokens.json, keyed by server name.
 *
 * When redirectToAuthorization is called, the authorization URL is stored
 * in an in-memory map so the Web UI can surface it to the user.
 */
export class FileOAuthClientProvider {
  /**
   * @param {string} serverName
   * @param {string} serverUrl
   * @param {string} [proxy]
   */
  constructor(serverName, serverUrl, proxy) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this.proxy = proxy;
    this.fetch = createProxyFetch(proxy);
    const storedTokens = loadTokenStore()[serverName]?.tokens;
    if (storedTokens?.expires_at === undefined && storedTokens?.expires_in !== undefined) {
      this.saveTokens(storedTokens);
    } else {
      scheduleTokenRefresh(this, storedTokens);
    }
  }

  get redirectUrl() {
    return `http://localhost:${getCallbackPort()}/oauth/callback`;
  }

  get clientMetadata() {
    return {
      client_name: `mcp-center (${this.serverName})`,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state() {
    return randomUUID();
  }

  clientInformation() {
    const store = loadTokenStore();
    return store[this.serverName]?.clientInformation;
  }

  saveClientInformation(clientInformation) {
    const store = loadTokenStore();
    if (!store[this.serverName]) store[this.serverName] = {};
    store[this.serverName].clientInformation = clientInformation;
    saveTokenStore(store);
  }

  tokens() {
    const store = loadTokenStore();
    return store[this.serverName]?.tokens;
  }

  saveTokens(tokens) {
    const store = loadTokenStore();
    if (!store[this.serverName]) store[this.serverName] = {};
    const normalizedTokens = { ...tokens };
    if (normalizedTokens.expires_in !== undefined) {
      const expiresIn = Number(normalizedTokens.expires_in);
      if (Number.isFinite(expiresIn) && expiresIn >= 0) {
        normalizedTokens.expires_at = Date.now() + expiresIn * 1000;
      }
    }
    store[this.serverName].tokens = normalizedTokens;
    saveTokenStore(store);
    scheduleTokenRefresh(this, normalizedTokens);
  }

  saveCodeVerifier(codeVerifier) {
    const store = loadTokenStore();
    if (!store[this.serverName]) store[this.serverName] = {};
    store[this.serverName].codeVerifier = codeVerifier;
    saveTokenStore(store);
  }

  codeVerifier() {
    const store = loadTokenStore();
    return store[this.serverName]?.codeVerifier;
  }

  async redirectToAuthorization(authorizationUrl) {
    const state = authorizationUrl.searchParams.get('state') || '';

    for (const [existingState, pending] of pendingAuths) {
      if (pending.serverName === this.serverName) {
        pendingAuths.delete(existingState);
      }
    }

    pendingAuths.set(state, {
      serverName: this.serverName,
      serverUrl: this.serverUrl,
      authorizationUrl: authorizationUrl.toString(),
      timestamp: Date.now(),
    });

    logMessage(`[mcp-center] OAuth authorization required for "${this.serverName}". URL stored for UI.`);
  }

  saveDiscoveryState(discoveryState) {
    const store = loadTokenStore();
    if (!store[this.serverName]) store[this.serverName] = {};
    store[this.serverName].discoveryState = discoveryState;
    saveTokenStore(store);
  }

  discoveryState() {
    const store = loadTokenStore();
    return store[this.serverName]?.discoveryState;
  }

  invalidateCredentials(scope) {
    const store = loadTokenStore();
    if (!store[this.serverName]) return;
    switch (scope) {
      case 'all':
        delete store[this.serverName];
        break;
      case 'client':
        delete store[this.serverName].clientInformation;
        break;
      case 'tokens':
        delete store[this.serverName].tokens;
        break;
      case 'verifier':
        delete store[this.serverName].codeVerifier;
        break;
      case 'discovery':
        delete store[this.serverName].discoveryState;
        break;
    }
    saveTokenStore(store);
  }
}

/**
 * Get or create a FileOAuthClientProvider for a server.
 * @param {string} serverName
 * @param {string} serverUrl
 * @param {string} [proxy]
 * @returns {FileOAuthClientProvider}
 */
export function getOrCreateProvider(serverName, serverUrl, proxy) {
  if (!providers.has(serverName)) {
    providers.set(serverName, new FileOAuthClientProvider(serverName, serverUrl, proxy));
  } else {
    const provider = providers.get(serverName);
    if (provider.proxy !== proxy) {
      const fetch = createProxyFetch(proxy);
      provider.fetch?.close().catch(error => logWarn('[mcp-center] Error closing OAuth proxy:', error));
      provider.proxy = proxy;
      provider.fetch = fetch;
    }
    provider.serverUrl = serverUrl;
  }
  return providers.get(serverName);
}

/**
 * Get the pending authorization URL for a server (if any).
 * @param {string} serverName
 * @returns {{state: string, url: string} | null}
 */
export function getPendingAuth(serverName) {
  for (const [state, pending] of pendingAuths) {
    if (pending.serverName === serverName) {
      return { state, url: pending.authorizationUrl };
    }
  }
  return null;
}

/**
 * Clear pending auth entries for a server.
 * @param {string} serverName
 */
export function clearPendingAuth(serverName) {
  for (const [state, pending] of pendingAuths) {
    if (pending.serverName === serverName) {
      pendingAuths.delete(state);
    }
  }
}

/**
 * Handle the OAuth callback: exchange the authorization code for tokens.
 *
 * @param {string} code - The authorization code from the callback.
 * @param {string} state - The state parameter from the callback.
 * @returns {Promise<{serverName: string, serverUrl: string}>}
 * @throws {Error} if the state is invalid or token exchange fails.
 */
export async function handleOAuthCallback(code, state) {
  const pending = pendingAuths.get(state);
  if (!pending) {
    throw new Error('Invalid or expired OAuth state parameter');
  }

  const { serverName, serverUrl } = pending;
  pendingAuths.delete(state);

  const provider = providers.get(serverName) || getOrCreateProvider(serverName, serverUrl);

  logMessage(`[mcp-center] Exchanging OAuth authorization code for tokens (${serverName})...`);

  const result = await auth(provider, {
    serverUrl,
    authorizationCode: code,
    fetchFn: provider.fetch,
  });

  if (result !== 'AUTHORIZED') {
    throw new Error('OAuth authorization code exchange did not result in tokens');
  }

  logMessage(`[mcp-center] OAuth tokens saved for "${serverName}"`);

  return { serverName, serverUrl };
}

/**
 * Check whether a server has stored OAuth tokens.
 * @param {string} serverName
 * @returns {boolean}
 */
export function hasStoredTokens(serverName) {
  const store = loadTokenStore();
  return !!store[serverName]?.tokens?.access_token;
}

/**
 * Remove stored OAuth credentials for a server.
 * @param {string} serverName
 */
export function clearStoredCredentials(serverName) {
  const store = loadTokenStore();
  delete store[serverName];
  saveTokenStore(store);
  clearPendingAuth(serverName);
  providers.get(serverName)?.fetch?.close().catch(error => logWarn('[mcp-center] Error closing OAuth proxy:', error));
  providers.delete(serverName);
  const refreshTimer = refreshTimers.get(serverName);
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimers.delete(serverName);
  logMessage(`[mcp-center] Cleared OAuth credentials for "${serverName}"`);
}

/**
 * Get the auth status for a server.
 * @param {string} serverName
 * @returns {{status: 'authorized'|'needs_auth'|'no_oauth', authUrl?: string}}
 */
export function getAuthStatus(serverName) {
  if (hasStoredTokens(serverName)) {
    return { status: 'authorized' };
  }
  const pending = getPendingAuth(serverName);
  if (pending) {
    return { status: 'needs_auth', authUrl: pending.url };
  }
  return { status: 'needs_auth', authUrl: null };
}
