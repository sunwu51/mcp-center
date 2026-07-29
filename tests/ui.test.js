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
