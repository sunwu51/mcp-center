import { ProxyAgent, fetch } from 'undici';

export function validateProxy(proxy) {
  if (proxy === undefined || proxy === '') return true;
  if (typeof proxy !== 'string') return false;
  try {
    const url = new URL(proxy);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return false;
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return true;
  } catch {
    return false;
  }
}

/** Create a per-server fetch without changing the global proxy configuration. */
export function createProxyFetch(proxy) {
  if (!validateProxy(proxy)) {
    throw new Error('Invalid proxy URL: expected http://user:pass@host:port or https://host:port');
  }
  if (!proxy) return undefined;

  const url = new URL(proxy);
  const token = url.username || url.password
    ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`
    : undefined;
  url.username = '';
  url.password = '';
  const agent = new ProxyAgent({ uri: url.origin, token });
  const proxyFetch = (input, init) => fetch(input, { ...init, dispatcher: agent });
  proxyFetch.close = () => agent.destroy();
  return proxyFetch;
}
