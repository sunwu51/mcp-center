import { timingSafeEqual } from 'crypto';

export function getAuthConfig(env = process.env) {
  const token = env.MCP_CENTER_AUTH_TOKEN;
  return {
    enabled: typeof token === 'string' && token.length > 0,
    token,
  };
}

function safeEquals(a, b) {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function extractBearerToken(req) {
  const value = req.headers?.authorization;
  if (typeof value !== 'string') return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export function isAuthorizedRequest(req, options = {}) {
  const config = options.config || getAuthConfig();
  if (!config.enabled) return true;

  const bearerToken = extractBearerToken(req);
  if (bearerToken && safeEquals(bearerToken, config.token)) {
    return true;
  }

  return false;
}

export function shouldProtectHttpPath(pathname, config = getAuthConfig()) {
  if (!config.enabled) return false;
  if (pathname === '/mcp' || pathname.startsWith('/mcp/')) return true;
  if (pathname === '/api' || pathname.startsWith('/api/')) return true;
  if (pathname === '/fs/upload') return true;
  return false;
}

export function writeUnauthorized(res) {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer',
  });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}
