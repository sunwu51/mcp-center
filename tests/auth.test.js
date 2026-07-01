import {
  getAuthConfig,
  isAuthorizedRequest,
  shouldProtectHttpPath,
} from '../src/auth.js';

function makeReq({ authorization, remoteAddress = '203.0.113.10' } = {}) {
  return {
    headers: authorization ? { authorization } : {},
    socket: { remoteAddress },
  };
}

describe('inbound auth helpers', () => {
  it('disables auth when MCP_CENTER_AUTH_TOKEN is not set', () => {
    const config = getAuthConfig({});
    expect(config.enabled).toBe(false);
    expect(shouldProtectHttpPath('/mcp', config)).toBe(false);
    expect(isAuthorizedRequest(makeReq(), { config })).toBe(true);
  });

  it('protects MCP and API paths when auth is enabled', () => {
    const config = getAuthConfig({ MCP_CENTER_AUTH_TOKEN: 'secret' });
    expect(shouldProtectHttpPath('/mcp', config)).toBe(true);
    expect(shouldProtectHttpPath('/mcp/session-id', config)).toBe(true);
    expect(shouldProtectHttpPath('/api/servers', config)).toBe(true);
    expect(shouldProtectHttpPath('/ui', config)).toBe(false);
    expect(shouldProtectHttpPath('/ws/agent', config)).toBe(false);
  });

  it('accepts a matching bearer token', () => {
    const config = getAuthConfig({ MCP_CENTER_AUTH_TOKEN: 'secret' });
    const req = makeReq({ authorization: 'Bearer secret' });
    expect(isAuthorizedRequest(req, { config })).toBe(true);
  });

  it('rejects missing or invalid bearer tokens', () => {
    const config = getAuthConfig({ MCP_CENTER_AUTH_TOKEN: 'secret' });
    expect(isAuthorizedRequest(makeReq(), { config })).toBe(false);
    expect(isAuthorizedRequest(makeReq({ authorization: 'Bearer wrong' }), { config })).toBe(false);
    expect(isAuthorizedRequest(makeReq({ authorization: 'Basic secret' }), { config })).toBe(false);
  });
});
