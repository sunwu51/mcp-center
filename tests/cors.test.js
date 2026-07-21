import { handleCorsPreflight } from '../src/cors.js';

function makeResponse() {
  return {
    headers: {},
    statusCode: null,
    ended: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end() {
      this.ended = true;
    },
  };
}

describe('HTTP CORS', () => {
  it('adds CORS headers to normal requests without ending the response', () => {
    const req = { method: 'POST', headers: {} };
    const res = makeResponse();

    expect(handleCorsPreflight(req, res)).toBe(false);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(res.headers['Access-Control-Allow-Headers']).toContain('Authorization');
    expect(res.headers['Access-Control-Allow-Headers']).toContain('MCP-Session-ID');
    expect(res.headers['Access-Control-Expose-Headers']).toContain('MCP-Session-ID');
    expect(res.ended).toBe(false);
  });

  it('answers preflight before route authentication', () => {
    const req = {
      method: 'OPTIONS',
      headers: { 'access-control-request-private-network': 'true' },
    };
    const res = makeResponse();

    expect(handleCorsPreflight(req, res)).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.headers['Access-Control-Allow-Private-Network']).toBe('true');
    expect(res.ended).toBe(true);
  });
});
