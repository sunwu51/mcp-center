const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = [
  'Accept',
  'Authorization',
  'Content-Type',
  'Last-Event-ID',
  'MCP-Protocol-Version',
  'MCP-Session-ID',
].join(', ');
const EXPOSED_HEADERS = [
  'Location',
  'MCP-Session-ID',
  'WWW-Authenticate',
].join(', ');

export function applyCorsHeaders(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

export function handleCorsPreflight(req, res) {
  applyCorsHeaders(req, res);
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204);
  res.end();
  return true;
}
