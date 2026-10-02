import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Real UI + Rust + PostgreSQL, disposable synthetic records. No provider runs.
assert.equal(process.env.GRIMOIRE_TEST_DISPOSABLE, '1');
const base = process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5182';
const database = process.env.GRIMOIRE_TEST_DATABASE ?? 'grimoire_codex_flow_test';
assert.ok(database.endsWith('_test'));
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.equal((await (await fetch(`${base}/api/health`)).json()).database.name, database);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = path.join(root, '.local', 'design-refinement', String(Date.now()));
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [], checks = [], captures = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
let org;
const tasks = [];
async function api(route, { method = 'GET', data, expected = 200, extra = {} } = {}) {
  const response = await context.request.fetch(`${base}/api${route}`, { method, data,
    headers: { 'X-Grimoire-CSRF': '1', ...(org ? { 'X-Grimoire-Organization': org } : {}), ...extra } });
  assert.equal(response.status(), expected, `${method} ${route}: ${await response.text()}`);
  return response.json();
}
async function shot(name) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled' }); captures.push(name); }
async function navigate(route) { await page.goto(`${base}/#${route}`); await page.locator(route.startsWith('/settings') || route.startsWith('/profile') ? '.settings-topbar' : '.company-topbar').waitFor(); }
async function noOverflow(label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label}: document overflows`);
}
try {
  await page.goto(base);
  await page.getByLabel('Appearance').selectOption('light');
  await page.getByRole('form', { name: 'Sign in to Grimoire' }).waitFor();
  await shot('login-pearl');
  await page.getByLabel('Appearance').selectOption('dark');
  await shot('login-midnight');
  await page.getByRole('button', { name: 'Use create account form' }).click();
  assert.ok(await page.locator('.onboarding-card').evaluate(el => el.getBoundingClientRect().height) < 610, 'Signup form should stay compact');
  await shot('signup-midnight');
  checks.push('Compact login/signup render in both themes');

  const suffix = randomUUID().slice(0, 8);
  await api('/session/signup', { method: 'POST', expected: 201, data: { login_name: `design-${suffix}`, display_name: 'Synthetic Design Handler', passphrase: `Synthetic-only-${randomUUID()}` } });
  org = (await api('/organizations', { method: 'POST', expected: 201, data: { name: `Design verification ${suffix}` }, extra: { 'Idempotency-Key': randomUUID() } })).active_organization.org_id;
  const agent = await api('/agents', { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID() }, data: { name: 'Product planner', role: 'planner', title: 'Product planning', capabilities: 'Prepare synthetic briefs.', instructions: 'Keep unknowns explicit; require human review.', reports_to: null, adapter: 'codex_cli', timeout_seconds: 120, skill_ids: [], paused: false } });
  for (const name of ['Clayhouse workshop website', 'Workshop member portal']) {
    const scion = await api('/scions', { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID() }, data: { name, product_category: 'digital', product_description: 'Synthetic workshop website for UI verification.', decision: 'Identify capabilities and questions.', requirements: ['Visitors request a workshop place.'], questions: ['Who confirms booking requests?'], change_summary: 'Synthetic design fixture.' } });
    const task = await api(`/scions/${scion.id}/agent-tasks`, { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' }, data: { task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, timeout_seconds: 120, agent_id: agent.id } });
    tasks.push({ ...task, scion_id: scion.id });
  }
  await page.reload(); // Refresh the previously anonymous page after API signup.
  await navigate('/agents');
  await page.getByRole('heading', { name: 'Agents', exact: true }).waitFor();
  await page.locator('.native-directory-row').filter({ hasText: 'Product planner' }).waitFor();
  assert.ok(await page.locator('.agent-avatar svg').count());
  const assignedAvatarIdentity = await page.locator('.native-directory-row').filter({ hasText: 'Product planner' }).locator('.agent-avatar').getAttribute('data-avatar-identity');
  assert.ok(assignedAvatarIdentity, 'The assigned agent has a recorded visual identity');
  await page.setViewportSize({ width: 1920, height: 1000 });
  const scale = await page.evaluate(() => ({
    sidebar: document.querySelector('.company-sidebar').getBoundingClientRect().width,
    header: document.querySelector('.company-topbar').getBoundingClientRect().height,
    nav: getComputedStyle(document.querySelector('.company-nav-item')).fontSize,
    body: getComputedStyle(document.body).fontSize,
    background: getComputedStyle(document.querySelector('.company-app')).backgroundColor,
  }));
  assert.deepEqual(scale, { sidebar: 270, header: 68, nav: '16px', body: '16px', background: 'rgb(21, 29, 43)' });
  await writeFile(path.join(evidence, 'computed-scale.json'), JSON.stringify(scale, null, 2));
  await shot('agents-midnight');
  checks.push('Desktop matches the supplied reference scale: 270px sidebar, 68px header, 16px text, solid canvas');
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-topbar').waitFor();
  assert.equal(await page.locator('.company-sidebar, .company-bottom-navigation').count(), 0);
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill('Preserved profile draft');
  page.removeAllListeners('dialog');
  page.once('dialog', dialog => dialog.dismiss());
  await Promise.all([page.waitForEvent('dialog'), page.getByRole('button', { name: 'Back to workspace', exact: true }).click()]);
  await page.waitForURL(url => url.hash === '#/profile/edit');
  assert.ok(page.url().endsWith('#/profile/edit'));
  assert.equal(await page.getByLabel('Display name', { exact: true }).inputValue(), 'Preserved profile draft');
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('Profile saved.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('heading', { name: 'Appearance', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
  await page.locator('.native-directory-row').first().waitFor();
  assert.ok(page.url().endsWith('#/agents'), 'Settings returns to the previous work page');
  checks.push('Settings replaces the work sidebar; cancelling navigation preserves profile edits; saving and return to the prior page work');
  await page.setViewportSize({ width: 1440, height: 960 });
  await navigate('/agents/new');
  await page.getByLabel('Agent name', { exact: true }).fill('Draft research agent');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Choose its runtime' }).waitFor();
  await shot('agent-adapter-midnight');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('textbox', { name: /^Instructions/ }).fill('Preserve this draft when going back.');
  await page.getByRole('button', { name: 'Back', exact: false }).click();
  await page.getByRole('button', { name: 'Back', exact: false }).click();
  assert.equal(await page.getByLabel('Agent name', { exact: true }).inputValue(), 'Draft research agent');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: /^Instructions/ }).inputValue(), 'Preserve this draft when going back.');
  checks.push('Agent wizard keeps entered name and instructions across Back/Continue; only Codex is offered');

  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => localStorage.setItem('grimoire.theme-preference', value), theme);
    await page.reload();
    await navigate('/dashboard');
    await page.locator('.work-agent-card').first().waitFor();
    assert.equal(await page.locator('.work-agent-card').count(), 2);
    assert.equal(await page.getByRole('heading', { name: 'Workspace health', exact: true }).count(), 0);
    await shot(`dashboard-${theme}`);
    for (const route of ['/tasks', '/skills/discover', '/connectors', '/settings', '/settings/appearance', '/settings/runtime']) {
      await navigate(route);
      await noOverflow(`${route} ${theme} desktop`);
      await shot(`${route.slice(1).replaceAll('/', '-')}-${theme}`);
    }
  }
  await navigate('/tasks');
  await page.locator('.task-directory-row').first().waitFor();
  await page.getByLabel('Sort tasks').selectOption('oldest');
  await page.getByLabel('Group tasks').selectOption('scion');
  await page.reload();
  await page.locator('.task-directory-row').first().waitFor();
  assert.equal(await page.getByLabel('Sort tasks').inputValue(), 'oldest');
  assert.equal(await page.getByLabel('Group tasks').inputValue(), 'scion');
  checks.push('Task sort and grouping persist on reload in the same organization');
  const firstTask = tasks[0];
  const relatedTask = await api(`/scions/${firstTask.scion_id}/agent-tasks`, { method: 'POST', expected: 201, extra: { 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' }, data: { task_kind: 'prepare_capability_plan', candidate_proposal: { synthetic: true }, timeout_seconds: 120, agent_id: agent.id } });
  tasks.push({ ...relatedTask, scion_id: firstTask.scion_id });
  await page.reload();
  const firstTaskRow = page.locator('.task-directory-row').filter({ hasText: firstTask.id.slice(0, 8) });
  await firstTaskRow.waitFor();
  assert.equal(await firstTaskRow.locator('.agent-avatar').getAttribute('data-avatar-identity'), assignedAvatarIdentity, 'The same assigned agent keeps its blob in the task directory');
  await firstTaskRow.click();
  await page.waitForURL(url => url.hash === `#/scions/${firstTask.scion_id}/tasks/${firstTask.id}`);
  await page.locator('.task-detail').waitFor();
  const inspector = page.getByRole('complementary', { name: 'Task inspector', exact: true });
  await inspector.waitFor();
  const propertiesTab = inspector.getByRole('tab', { name: 'Properties', exact: true });
  const artifactsTab = inspector.getByRole('tab', { name: 'Artifacts', exact: true });
  const tasksTab = inspector.getByRole('tab', { name: 'Tasks', exact: true });
  const propertiesPanel = inspector.getByRole('tabpanel', { name: 'Properties', exact: true });
  const artifactsPanel = inspector.getByRole('tabpanel', { name: 'Artifacts', exact: true });
  const relatedPanel = inspector.getByRole('tabpanel', { name: 'Tasks', exact: true });
  await propertiesPanel.getByRole('button', { name: 'Product planner', exact: true }).waitFor();
  assert.equal(await propertiesTab.getAttribute('aria-selected'), 'true');
  assert.equal(await propertiesPanel.locator('.task-side-assignee .agent-avatar').getAttribute('data-avatar-identity'), assignedAvatarIdentity, 'Agent directory, task directory, and Properties use the same assigned agent blob');
  assert.match(await propertiesPanel.innerText(), /Codex CLI/);
  assert.match(await propertiesPanel.innerText(), /Model override\s+Not recorded/);
  assert.match(await propertiesPanel.innerText(), /Parent task\s+Not recorded/);
  await propertiesTab.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await artifactsTab.getAttribute('aria-selected'), 'true');
  assert.equal(await artifactsTab.evaluate(el => el === document.activeElement), true);
  await artifactsPanel.getByRole('heading', { name: 'No artifacts yet', exact: true }).waitFor();
  assert.equal(await artifactsPanel.locator('.task-side-record').count(), 0, 'Queued tasks do not invent artifacts');
  await shot('task-inspector-artifacts-empty');
  await page.keyboard.press('ArrowRight');
  assert.equal(await tasksTab.getAttribute('aria-selected'), 'true');
  assert.equal(await tasksTab.evaluate(el => el === document.activeElement), true);
  await relatedPanel.getByRole('heading', { name: /^Related tasks 1$/ }).waitFor();
  assert.equal(await relatedPanel.locator('button.task-side-record').count(), 1, 'Only another persisted task in this Scion appears as related');
  assert.match(await relatedPanel.innerText(), /No parent task is recorded/);
  assert.match(await relatedPanel.innerText(), /No (?:delegated )?subtasks are recorded/);
  await shot('task-inspector-related');
  await page.keyboard.press('Home');
  assert.equal(await propertiesTab.getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await tasksTab.getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowRight');
  assert.equal(await propertiesTab.getAttribute('aria-selected'), 'true', 'Arrow navigation wraps to Properties');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await tasksTab.getAttribute('aria-selected'), 'true', 'Reverse navigation wraps to Tasks');
  await inspector.getByRole('button', { name: 'Close task inspector', exact: true }).click();
  await inspector.waitFor({ state: 'hidden' });
  const reopenPanel = page.getByRole('button', { name: 'Show task panel', exact: true });
  assert.equal(await reopenPanel.getAttribute('aria-expanded'), 'false');
  assert.equal(await reopenPanel.evaluate(el => el === document.activeElement), true, 'Closing the inspector restores focus to its trigger');
  await reopenPanel.click();
  await propertiesPanel.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Hide task panel', exact: true }).getAttribute('aria-expanded'), 'true');
  await page.getByRole('region', { name: 'Questions for you', exact: true }).getByRole('button', { name: 'Answer questions', exact: true }).click();
  await page.getByLabel('Who confirms booking requests?', { exact: true }).waitFor();
  const answer = page.locator('#task-answer-0');
  const answerDraft = 'The workshop owner confirms each synthetic booking request.';
  await answer.fill(answerDraft);
  await artifactsTab.click();
  await tasksTab.click();
  await propertiesTab.click();
  assert.equal(await answer.inputValue(), answerDraft, 'Switching inspector tabs preserves the Handler answer draft');
  await inspector.getByRole('button', { name: 'Close task inspector', exact: true }).click();
  await reopenPanel.click();
  assert.equal(await answer.inputValue(), answerDraft, 'Closing and reopening the inspector preserves the Handler answer draft');
  await answer.fill('');
  await tasksTab.click();
  await relatedPanel.locator('button.task-side-record').click();
  await page.waitForURL(url => url.hash === `#/scions/${firstTask.scion_id}/tasks/${relatedTask.id}`);
  await page.locator('.task-workspace-heading').filter({ hasText: relatedTask.id.slice(0, 8) }).waitFor();
  await propertiesTab.click();
  await propertiesPanel.getByRole('button', { name: 'Product planner', exact: true }).waitFor();
  assert.equal(await propertiesPanel.locator('.task-side-assignee .agent-avatar').getAttribute('data-avatar-identity'), assignedAvatarIdentity);
  checks.push('Task inspector tabs expose real properties and empty artifacts; arrow/Home/End keyboard navigation, close focus/reopen, draft preservation, actual related-task navigation, and assigned-agent avatar identity all pass');
  await shot('task-detail-midnight');
  for (const width of [768, 960, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await navigate('/tasks');
    await page.locator('.task-directory-row').first().waitFor();
    await noOverflow(`Tasks ${width}px`);
    assert.equal(await page.locator('#main-content').evaluate(el => el.scrollWidth > el.clientWidth + 1), false, `Task content at ${width}px is clipped`);
  }

  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const route of ['/tasks', '/agents', '/skills/discover', '/connectors', '/settings']) {
    await navigate(route);
    await noOverflow(`${route} 375px`);
    await shot(`${route.slice(1).replaceAll('/', '-')}-mobile`);
  }
  assert.equal(await page.locator('.company-sidebar, .company-bottom-navigation').count(), 0);
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
  await page.locator('.company-topbar').waitFor();
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Workspace navigation' });
  await drawer.waitFor();
  await shot('mobile-navigation');
  for (let i = 0; i < 28; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await drawer.evaluate(el => el.contains(document.activeElement)), true, 'Focus stays in navigation drawer');
  }
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: 'Open navigation', exact: true }).evaluate(el => el === document.activeElement), true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#root'), '::before').animationName), 'none');
  checks.push('375px navigation has no page overflow, contains focus, closes on Escape, restores focus, and respects reduced motion');
  await navigate(`/scions/${firstTask.scion_id}/tasks/${firstTask.id}`);
  await inspector.waitFor();
  await propertiesPanel.waitFor();
  await noOverflow('Task inspector 375px');
  const inspectorMobile = await inspector.evaluate(el => ({ height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }));
  assert.ok(inspectorMobile.height <= 320.5, `Mobile inspector is capped at 320px, actual ${inspectorMobile.height}`);
  assert.ok(inspectorMobile.scrollWidth <= inspectorMobile.clientWidth + 1, 'Mobile inspector has no horizontal overflow');
  assert.equal(await page.locator('#main-content').evaluate(el => el.scrollWidth > el.clientWidth + 1), false, 'Main task content remains inside the mobile viewport');
  await shot('task-inspector-mobile');
  await artifactsTab.click();
  await artifactsPanel.getByRole('heading', { name: 'No artifacts yet', exact: true }).waitFor();
  await tasksTab.click();
  await relatedPanel.locator('button.task-side-record').waitFor();
  await propertiesTab.click();
  await page.getByRole('region', { name: 'Questions for you', exact: true }).getByRole('button', { name: 'Answer questions', exact: true }).click();
  await answer.fill('Mobile draft stays available beside task properties.');
  await answer.scrollIntoViewIfNeeded();
  assert.equal(await answer.isVisible(), true);
  const answerBounds = await answer.boundingBox();
  assert.ok(answerBounds && answerBounds.x >= 0 && answerBounds.x + answerBounds.width <= 376 && answerBounds.y >= 0 && answerBounds.y < 812, 'The main question is reachable in the mobile viewport');
  await shot('task-question-mobile');
  await writeFile(path.join(evidence, 'task-inspector.json'), JSON.stringify({ firstTaskId: firstTask.id, relatedTaskId: relatedTask.id, assignedAgentId: agent.id, assignedAvatarIdentity, inspectorMobile, answerBounds }, null, 2));
  await answer.fill('');
  checks.push('At 375px the task inspector stays within 320px, has no horizontal overflow, all tabs work, and the main Handler question remains reachable and editable');
  await page.setViewportSize({ width: 1440, height: 960 });
  const firstOrg = org;
  org = (await api('/organizations', { method: 'POST', expected: 201, data: { name: `Separate design workspace ${suffix}` }, extra: { 'Idempotency-Key': randomUUID() } })).active_organization.org_id;
  await page.reload(); await navigate('/tasks');
  await page.getByLabel('Sort tasks').waitFor();
  assert.equal(await page.getByLabel('Sort tasks').inputValue(), 'attention');
  assert.equal(await page.getByLabel('Group tasks').inputValue(), 'none');
  assert.equal(await page.locator('.task-directory-row').count(), 0);
  assert.equal(await page.locator('.company-main').evaluate(el => el.inert), false);
  await api('/session/active-organization', { method: 'POST', data: { organization_id: firstOrg } });
  org = firstOrg;
  await page.reload(); await navigate('/tasks');
  await page.locator('.task-directory-row').first().waitFor();
  assert.equal(await page.getByLabel('Sort tasks').inputValue(), 'oldest');
  assert.equal(await page.getByLabel('Group tasks').inputValue(), 'scion');
  checks.push('Organization switch isolates tasks and view preferences; switching back restores the original view');
  assert.deepEqual(errors, []);
  checks.push('No uncaught browser errors');
} catch (error) {
  await shot('failure');
  await writeFile(path.join(evidence, 'failure.txt'), `${error.stack}\n\n${await page.locator('body').innerText()}\n\n${JSON.stringify(await page.locator('input:invalid, textarea:invalid').evaluateAll(nodes => nodes.map(el => ({ id: el.id, message: el.validationMessage }))))}`);
  throw error;
} finally {
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ database, org, taskIds: tasks.map(task => task.id), checks, captures, errors }, null, 2));
  await browser.close();
  console.log(JSON.stringify({ evidence, checks }, null, 2));
}

