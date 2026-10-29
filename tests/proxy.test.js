import { createServer } from 'http';
import { connect } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProxyFetch, validateProxy } from '../src/proxy.js';
import { loadServer, probeServer, callTool, closeAllServers } from '../src/loader.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { getOrCreateProvider } from '../src/oauth.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

describe('HTTP MCP proxy', () => {
  let target;
  let proxy;
  let proxyUrl;
  let targetUrl;
  let tunnels;
  let requests;
  let expectedAuth;
  let expireSession;
  const sockets = new Set();

  beforeAll(async () => {
    target = createServer(async (req, res) => {
      requests.push({ method: req.method, headers: req.headers });
      if (req.method === 'GET') {
        res.writeHead(405).end();
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString());
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (expireSession && message.method === 'tools/call') {
        expireSession = false;
        res.writeHead(404).end();
        return;
      }
      let result;
      switch (message.method) {
        case 'initialize':
          result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'proxy-test', version: '1.0.0' } };
          break;
        case 'tools/list': result = { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }; break;
        case 'tools/call': result = { content: [{ type: 'text', text: message.params.arguments.message }] }; break;
        case 'resources/list': result = { resources: [] }; break;
        case 'resources/templates/list': result = { resourceTemplates: [] }; break;
        case 'prompts/list': result = { prompts: [] }; break;
        default: result = {};
      }
      const response = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
      if (message.method === 'tools/call') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`event: message\ndata: ${response}\n\n`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'proxy-test-session' });
      res.end(response);
    });
    await listen(target);
    targetUrl = `http://127.0.0.1:${target.address().port}/mcp`;
    proxy = createServer((req, res) => res.writeHead(405).end());
    proxy.on('connect', (req, socket, head) => {
      tunnels.push({ address: req.url, authorization: req.headers['proxy-authorization'] });
      if (req.headers['proxy-authorization'] !== expectedAuth) {
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');
        return;
      }
      // The deliberately unresolvable MCP hostname is resolved only by this proxy.
      const upstream = connect(target.address().port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
    });
    proxy.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await listen(proxy);
    proxyUrl = `http://user:p%40ss@127.0.0.1:${proxy.address().port}`;
  });

  beforeEach(() => {
    tunnels = [];
    requests = [];
    expectedAuth = `Basic ${Buffer.from('user:p@ss').toString('base64')}`;
    expireSession = false;
  });

  afterEach(async () => {
    await closeAllServers();
    for (const socket of sockets) socket.destroy();
  });

  afterAll(async () => {
    await Promise.all([close(proxy), close(target)]);
  });

  it('loads, streams, calls tools, and reconnects through an authenticated proxy', async () => {
    await loadServer({ name: 'proxied', url: 'http://mcp.invalid/mcp', proxy: proxyUrl, httpHeaders: { 'X-Mcp-Test': 'preserved' } });
    expireSession = true;
    const result = await callTool('proxied_echo', { message: 'through proxy' });
    expect(result.content[0].text).toBe('through proxy');
    expect(tunnels.length).toBeGreaterThan(0);
    expect(tunnels.every(t => t.address === 'mcp.invalid:80' && t.authorization === expectedAuth)).toBe(true);
    expect(requests.some(r => r.method === 'GET')).toBe(true);
    expect(requests.every(r => !r.headers['proxy-authorization'] && r.headers['x-mcp-test'] === 'preserved')).toBe(true);
  });

  it('uses the proxy for capability probes', async () => {
    const result = await probeServer({ name: 'probe', url: 'http://mcp.invalid/mcp', proxy: proxyUrl });
    expect(result.tools[0].name).toBe('echo');
    expect(tunnels.length).toBeGreaterThan(0);
  });

  it('supports proxies without credentials', async () => {
    expectedAuth = undefined;
    const result = await probeServer({ name: 'anonymous', url: 'http://mcp.invalid/mcp', proxy: `http://127.0.0.1:${proxy.address().port}` });
    expect(result.tools[0].name).toBe('echo');
    expect(tunnels.every(t => t.authorization === undefined)).toBe(true);
  });

  it('does not fall back to direct access when proxy authentication fails', async () => {
    expectedAuth = 'invalid';
    await expect(probeServer({ name: 'denied', url: targetUrl, proxy: proxyUrl })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it('leaves servers without a proxy on the direct connection path', async () => {
    const result = await probeServer({ name: 'direct', url: targetUrl });
    expect(result.tools[0].name).toBe('echo');
    expect(tunnels).toHaveLength(0);
    expect(createProxyFetch('')).toBeUndefined();
    expect(createProxyFetch()).toBeUndefined();
  });

  it('updates OAuth proxy fetch when configuration changes', async () => {
    const provider = getOrCreateProvider('proxy-provider-test', targetUrl, proxyUrl);
    const initialFetch = provider.fetch;
    expect(typeof initialFetch).toBe('function');
    const response = await initialFetch('http://oauth.invalid/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'token' }),
    });
    expect(response.ok).toBe(true);
    await response.json();
    expect(tunnels.some(t => t.address === 'oauth.invalid:80')).toBe(true);
    expect(getOrCreateProvider('proxy-provider-test', targetUrl, proxyUrl).fetch).toBe(initialFetch);
    expect(getOrCreateProvider('proxy-provider-test', targetUrl).fetch).toBeUndefined();
  });
});

describe('proxy configuration validation', () => {
  it.each([undefined, '', 'http://127.0.0.1:7890', 'https://user:pass@proxy.example:443'])('accepts %s', proxy => {
    expect(validateProxy(proxy)).toBe(true);
  });

  it.each([null, 123, {}, '127.0.0.1:7890', 'socks5://127.0.0.1:7890', 'http://', 'http://user:%zz@localhost:7890'])('rejects %s without exposing credentials', proxy => {
    expect(validateProxy(proxy)).toBe(false);
    expect(() => createProxyFetch(proxy)).toThrow('Invalid proxy URL');
  });

  it('round-trips proxy settings and rejects invalid settings on save', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-proxy-'));
    try {
      const path = join(dir, 'mcp.json');
      const config = { servers: [{ name: 'proxied', url: 'https://mcp.example/mcp', proxy: 'http://user:pass@127.0.0.1:7890' }] };
      saveConfig(config, path);
      expect(loadConfig(path)).toEqual(config);
      expect(() => saveConfig({ servers: [{ ...config.servers[0], proxy: 'bad' }] }, path)).toThrow('Invalid config object');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
