import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Browser protocol tests use an explicitly synthetic GIS script and mocked auth
// endpoints. These do not claim a real Google login or token verification.
const base = (process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5180').replace(/\/$/, '');
const url = new URL(base);
assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use a local development UI.');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const client = 'synthetic-ui-test.apps.googleusercontent.com';
const token = 'synthetic-ui-protocol-token-not-a-google-token';
const checks = [];
const errors = [];
const session = (name = 'Synthetic Google UI') => ({ handler: { identity_id: 'synthetic-handler', login_name: 'synthetic-handler', display_name: name, installation_owner: false }, organizations: [], active_organization: null });
const mockScript = `window.__syntheticGIS = { initializations: [], callbacks: [] }; window.google = { accounts: { id: {
  initialize(options) { window.__syntheticGIS.initializations.push({ client_id: options.client_id, nonce: options.nonce, auto_select: options.auto_select, ux_mode: options.ux_mode }); window.__syntheticGIS.callbacks.push(options.callback); },
  renderButton(container) { const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Synthetic GIS test button'; container.append(button); }
} } };`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const state = { scripts: 0, config: 0, challenges: [], google: [], password: [], expiresIn: 60000, ...options };
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('https://accounts.google.com/gsi/client', async route => {
    state.scripts++;
    if (state.scriptGate) await state.scriptGate.promise;
    if (state.failScriptOnce && state.scripts === 1) { await route.abort(); return; }
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: mockScript });
  });
  await context.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/setup/status') return respond({ setup_required: true });
    if (path === '/api/session' && request.method() === 'GET') return respond({ error: { code: 'NO_SESSION', message: 'Synthetic unauthenticated test.' } }, 401);
    if (path === '/api/session/google/config') { state.config++; return respond(state.disabled ? { enabled: false } : { enabled: true, client_id: client }); }
    if (path === '/api/session/google/challenge') {
      assert.equal(request.method(), 'POST'); assert.equal(request.headers()['x-grimoire-csrf'], '1');
      const nonce = `synthetic-nonce-${state.challenges.length + 1}`;
      state.challenges.push(nonce);
      return respond({ client_id: client, nonce, expires_at: new Date(Date.now() + state.expiresIn).toISOString() });
    }
    if (path === '/api/session/google') {
      assert.equal(request.headers()['x-grimoire-csrf'], '1');
      state.google.push(request.postDataJSON());
      if (state.googleGate) await state.googleGate.promise;
      if (state.failGoogleOnce && state.google.length === 1) return respond({ error: { code: 'GOOGLE_TOKEN_INVALID', message: 'Synthetic token rejected; retry sign-in.' } }, 401);
      return respond(session());
    }
    if (path === '/api/session/login') {
      state.password.push(request.postDataJSON());
      if (state.passwordGate) await state.passwordGate.promise;
      return respond(session('Synthetic Password UI'));
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(base);
  await page.getByRole('heading', { name: 'Welcome to Grimoire.', exact: true }).waitFor();
  return { context, page, state };
}
async function prepare(page) {
  await page.getByRole('button', { name: 'Load Google sign-in', exact: true }).click();
  await page.getByRole('button', { name: 'Synthetic GIS test button', exact: true }).waitFor();
}
async function callback(page, index = -1, count = 1) {
  await page.evaluate(({ token, index, count }) => {
    const callback = window.__syntheticGIS.callbacks.at(index);
    for (let i = 0; i < count; i++) callback({ credential: token });
  }, { token, index, count });
}
async function password(page) {
  await page.locator('#login-name').fill('synthetic-password-handler');
  await page.locator('#handler-passphrase').fill('synthetic-passphrase-for-ui');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
try {
  {
    const { context, page, state } = await fixture({ disabled: true });
    await page.getByText('Google sign-in is not configured for this installation.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Use create account form', exact: true }).click();
    await page.getByText('Google sign-in is not configured for this installation.', { exact: true }).waitFor();
    assert.equal(state.scripts, 0); assert.equal(state.challenges.length, 0); assert.equal(state.google.length, 0);
    await page.getByRole('button', { name: 'Set up this installation', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: 'Google account access' }).count(), 0);
    await page.goto(`${base}/demo`);
    await page.locator('main').waitFor();
    assert.equal(state.scripts, 0); assert.equal(state.challenges.length, 0);
    checks.push('disabled configuration is truthful; normal signup, owner setup and public demo load no Google SDK');
    await context.close();
  }
  {
    const googleGate = deferred();
    const { context, page, state } = await fixture({ failScriptOnce: true, googleGate });
    await page.getByRole('button', { name: 'Load Google sign-in', exact: true }).waitFor();
    assert.equal(state.scripts, 0);
    await page.getByRole('button', { name: 'Load Google sign-in', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'could not load' }).waitFor();
    await page.getByRole('button', { name: 'Try Google again', exact: true }).click();
    await page.getByRole('button', { name: 'Synthetic GIS test button', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__syntheticGIS.initializations), [{ client_id: client, nonce: 'synthetic-nonce-1', auto_select: false, ux_mode: 'popup' }]);
    const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/session/google');
    await callback(page, -1, 2); await request;
    await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(state.password.length, 0); assert.equal(state.google.length, 1);
    googleGate.resolve();
    await page.getByRole('heading', { name: 'Name your organization.', exact: true }).waitFor();
    assert.deepEqual(state.google, [{ credential: token }]);
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(token));
    checks.push('explicit SDK loading recovers from failure; challenge binds official initialization; duplicate callbacks and password submission cannot race the Google session POST');
    await context.close();
  }
  {
    const passwordGate = deferred();
    const { context, page, state } = await fixture({ passwordGate });
    await prepare(page);
    const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/session/login');
    await password(page); await request;
    await callback(page);
    assert.equal(state.google.length, 0); assert.equal(state.password.length, 1);
    passwordGate.resolve();
    await page.getByRole('heading', { name: 'Name your organization.', exact: true }).waitFor();
    await callback(page);
    assert.equal(state.google.length, 0);
    checks.push('password completion invalidates an old Google callback before any Google session POST, including after unmount');
    await context.close();
  }
  {
    const { context, page, state } = await fixture({ failGoogleOnce: true });
    await prepare(page);
    await page.getByRole('button', { name: 'Use create account form', exact: true }).click();
    await callback(page, 0); assert.equal(state.google.length, 0);
    await prepare(page);
    await callback(page, 0); assert.equal(state.google.length, 0);
    await callback(page);
    await page.getByRole('alert').filter({ hasText: 'Synthetic token rejected' }).waitFor();
    await page.getByRole('button', { name: 'Try Google again', exact: true }).click();
    await page.getByRole('button', { name: 'Synthetic GIS test button', exact: true }).waitFor();
    assert.equal(state.scripts, 1); assert.equal(state.challenges.length, 3);
    await callback(page);
    await page.getByRole('heading', { name: 'Name your organization.', exact: true }).waitFor();
    assert.equal(state.google.length, 2);
    checks.push('mode changes ignore old callbacks; server rejection retries with a new nonce and a single shared SDK');
    await context.close();
  }
  {
    const { context, page, state } = await fixture({ expiresIn: 500 });
    await prepare(page);
    await page.getByRole('alert').filter({ hasText: 'Google sign-in expired' }).waitFor();
    await callback(page, 0); assert.equal(state.google.length, 0);
    state.expiresIn = 60000;
    await page.getByRole('button', { name: 'Try Google again', exact: true }).click();
    await page.getByRole('button', { name: 'Synthetic GIS test button', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Refresh Google sign-in', exact: true }).click();
    await page.getByRole('button', { name: 'Synthetic GIS test button', exact: true }).waitFor();
    assert.equal(state.challenges.length, 3);
    await callback(page, 1); assert.equal(state.google.length, 0);
    checks.push('expired challenges and closed-popup retries invalidate old callbacks and request fresh nonces');
    await context.close();
  }
  {
    const scriptGate = deferred();
    const { context, page, state } = await fixture({ scriptGate });
    const loading = page.waitForRequest('https://accounts.google.com/gsi/client');
    await page.getByRole('button', { name: 'Load Google sign-in', exact: true }).click(); await loading;
    await page.getByRole('button', { name: 'Set up this installation', exact: true }).click();
    scriptGate.resolve();
    await page.waitForFunction(() => Boolean(window.__syntheticGIS));
    assert.equal(state.challenges.length, 0); assert.equal(state.google.length, 0);
    assert.equal(await page.getByRole('region', { name: 'Google account access' }).count(), 0);
    checks.push('late SDK initialization after leaving the sign-in form creates no challenge, owner claim or authentication request');
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ kind: 'synthetic-google-ui-protocol-only', checks, page_errors: errors }, null, 2));
} finally { await browser.close(); }
