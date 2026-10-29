import { UI_HTML } from '../src/ui.js';

describe('management UI authentication', () => {
  it('stores the inbound token in session storage and sends it through the API wrapper', () => {
    expect(UI_HTML).toContain("sessionStorage.setItem(AUTH_TOKEN_KEY, token)");
    expect(UI_HTML).toContain("headers.set('Authorization', 'Bearer ' + token)");
    expect(UI_HTML).toContain('response.status === 401');
  });

  it('routes every literal management API request through apiFetch', () => {
    expect(UI_HTML).not.toMatch(/fetch\(['"]\/api\//);
    expect(UI_HTML).toMatch(/apiFetch\(['"]\/api\//);
  });
});

describe('management UI HTTP proxy support', () => {
  it('renders an optional proxy input with the example placeholder', () => {
    expect(UI_HTML).toContain('id="serverProxy"');
    expect(UI_HTML).toContain('placeholder="http://user:pass@127.0.0.1:7890"');
    expect(UI_HTML).toContain('Leave empty to connect directly');
  });

  it('validates HTTP and HTTPS proxy URLs only', () => {
    expect(UI_HTML).toContain('function parseProxyInput(raw)');
    expect(UI_HTML).toContain("u.protocol !== 'http:' && u.protocol !== 'https:'");
    expect(UI_HTML).toContain('Proxy URL must start with http:// or https://');
  });

  it('sends the proxy on save and capability probe only when set', () => {
    const save = UI_HTML.slice(UI_HTML.indexOf('async function saveServer'), UI_HTML.indexOf('function closeModal'));
    expect(save).toContain("parseProxyInput(document.getElementById('serverProxy').value)");
    expect(save).toContain('if (proxy.value) server.proxy = proxy.value;');
    const probe = UI_HTML.slice(UI_HTML.indexOf('function buildProbeConfig'), UI_HTML.indexOf('async function probeAndShowTools'));
    expect(probe).toContain('if (proxy.value) cfg.proxy = proxy.value;');
    expect(UI_HTML).toContain('try { cfg = buildProbeConfig(); }');
  });

  it('populates and clears the proxy field when editing and resetting', () => {
    expect(UI_HTML).toContain("document.getElementById('serverProxy').value = server.proxy || '';");
    expect(UI_HTML).toContain("document.getElementById('serverProxy').value = '';");
    // openAddModal resets the whole form, which clears the text input
    expect(UI_HTML).toContain("document.getElementById('serverForm').reset();");
  });

  it('keeps proxy credentials out of the server list summary', () => {
    expect(UI_HTML).toContain("' | Proxy: ' + describeProxy(s.proxy)");
    expect(UI_HTML).not.toContain("'Proxy: ' + s.proxy");
    expect(UI_HTML).toContain("return u.protocol + '//' + u.host;");
  });

  it('parses, validates and masks proxies correctly when executed', () => {
    const start = UI_HTML.indexOf('function parseProxyInput');
    const end = UI_HTML.indexOf('function buildProbeConfig');
    const { parseProxyInput, describeProxy } = new Function(
      UI_HTML.slice(start, end) + '; return { parseProxyInput, describeProxy };'
    )();

    expect(parseProxyInput('')).toEqual({ value: '' });
    expect(parseProxyInput('   ')).toEqual({ value: '' });
    expect(parseProxyInput(' http://user:pass@127.0.0.1:7890 ')).toEqual({ value: 'http://user:pass@127.0.0.1:7890' });
    expect(parseProxyInput('https://proxy.example.com:8443')).toEqual({ value: 'https://proxy.example.com:8443' });
    expect(parseProxyInput('socks5://127.0.0.1:1080').error).toMatch(/http:\/\/ or https:\/\//);
    expect(parseProxyInput('127.0.0.1:7890').error).toBeDefined();
    expect(parseProxyInput('not a url').error).toBeDefined();

    const label = describeProxy('http://user:secret@127.0.0.1:7890/path?token=x');
    expect(label).toBe('http://127.0.0.1:7890');
    expect(label).not.toContain('secret');
    expect(describeProxy('garbage')).toBe('******');
  });
});
