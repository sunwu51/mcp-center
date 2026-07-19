import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
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
   */
  constructor(serverName, serverUrl) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
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
    store[this.serverName].tokens = tokens;
    saveTokenStore(store);
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
 * @returns {FileOAuthClientProvider}
 */
export function getOrCreateProvider(serverName, serverUrl) {
  if (!providers.has(serverName)) {
    providers.set(serverName, new FileOAuthClientProvider(serverName, serverUrl));
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

  const provider = getOrCreateProvider(serverName, serverUrl);

  logMessage(`[mcp-center] Exchanging OAuth authorization code for tokens (${serverName})...`);

  const result = await auth(provider, {
    serverUrl,
    authorizationCode: code,
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
  providers.delete(serverName);
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
