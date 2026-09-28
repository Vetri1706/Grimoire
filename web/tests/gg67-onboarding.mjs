import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const base = process.env.GRIMOIRE_WEB_URL ?? 'http://127.0.0.1:5173';
const evidence = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/evidence');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('pageerror', error => errors.push(error.message));
page.on('requestfailed', request => errors.push(`request failed: ${request.url()} ${request.failure()?.errorText ?? ''}`));
page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });

await page.goto(base, { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: 'Set up your Handler identity.' }).waitFor();
await page.screenshot({ path: resolve(evidence, 'gg67-onboarding-desktop.png'), fullPage: true });
await page.locator('#handler-name').fill('Browser Test Owner');
await page.locator('#login-name').fill('browser-owner');
await page.locator('#handler-passphrase').fill('browser-test-passphrase');
await page.getByRole('button', { name: /Create Handler identity/ }).click();

await page.getByRole('heading', { name: 'Name your organization.' }).waitFor();
await page.locator('#organization-name').fill('Browser Alpha');
await page.getByRole('button', { name: /Create organization/ }).click();
await page.getByRole('heading', { name: 'No cases yet.' }).waitFor();
await page.screenshot({ path: resolve(evidence, 'gg67-empty-workspace-desktop.png'), fullPage: true });

await page.getByRole('button', { name: /Create a case/ }).click();
await page.locator('#name').fill('Browser First Scion');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await page.screenshot({ path: resolve(evidence, 'gg67-first-scion-narrow.png'), fullPage: true });
await page.getByRole('button', { name: /Save intake draft/ }).click();
await page.getByText('Browser First Scion', { exact: true }).first().waitFor();

await page.setViewportSize({ width: 1440, height: 1000 });
await page.getByRole('button', { name: 'Create another organization' }).click();
await page.locator('#organization-name').fill('Browser Beta');
await page.getByRole('button', { name: /Create organization/ }).click();
await page.getByRole('heading', { name: 'No cases yet.' }).waitFor();
await page.screenshot({ path: resolve(evidence, 'gg67-second-organization-desktop.png'), fullPage: true });

await page.locator('.workspace-switch select').selectOption({ label: 'Browser Alpha' });
await page.getByText('Browser First Scion', { exact: true }).waitFor();
await page.setViewportSize({ width: 390, height: 844 });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(300);
await page.getByText('Browser First Scion', { exact: true }).waitFor();
await page.screenshot({ path: resolve(evidence, 'gg67-returned-workspace-narrow.png'), fullPage: true });

const result = {
  url: page.url(),
  title: await page.title(),
  firstScionVisible: await page.getByText('Browser First Scion', { exact: true }).isVisible(),
  screenshots: 5,
  consoleErrors: errors,
};
await browser.close();
console.log(JSON.stringify(result));
if (errors.length) process.exitCode = 1;
