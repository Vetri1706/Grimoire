import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultLayout, layoutStorageKey, normalizeLayout, readLayout, resizeFromKey, serializeLayout } from './layout-preferences.ts';

test('untrusted saved geometry is bounded and invalid preferences return defaults', () => {
  assert.deepEqual(readLayout('{broken'), defaultLayout);
  assert.deepEqual(normalizeLayout({ sidebarWidth: -3, inspectorWidth: 999, inspectorDock: 'floating', inspectorSide: 'left' }), { sidebarWidth: 208, inspectorWidth: 520, inspectorDock: 'right', inspectorSide: 'right' });
  assert.equal(normalizeLayout({ sidebarWidth: Number.NaN }).sidebarWidth, 270);
  assert.equal(normalizeLayout({ inspectorWidth: '520' }).inspectorWidth, 340);
  assert.equal(normalizeLayout({ inspectorWidth: 350.6 }).inspectorWidth, 351);
});

test('hidden inspector remembers its dock and serialized data includes geometry only', () => {
  const value = normalizeLayout({ inspectorDock: 'hidden', inspectorSide: 'left' });
  assert.equal(value.inspectorSide, 'left');
  assert.deepEqual(Object.keys(JSON.parse(serializeLayout({ ...value, token: 'private', source: 'private', tasks: [] } as typeof value))).sort(), ['inspectorDock', 'inspectorSide', 'inspectorWidth', 'sidebarWidth']);
});

test('organization and user storage scopes cannot collide', () => {
  assert.notEqual(layoutStorageKey('one', 'two:three'), layoutStorageKey('one:two', 'three'));
  assert.notEqual(layoutStorageKey('one', 'org'), layoutStorageKey('two', 'org'));
  assert.notEqual(layoutStorageKey('one', 'org'), layoutStorageKey('one', 'other'));
});

test('keyboard resizing follows the moved edge, clamps widths and supports reset', () => {
  assert.equal(resizeFromKey('ArrowRight', 270, 1, 208, 420, 270), 278);
  assert.equal(resizeFromKey('ArrowLeft', 340, -1, 280, 520, 340), 348);
  assert.equal(resizeFromKey('ArrowRight', 510, 1, 280, 520, 340, true), 520);
  assert.equal(resizeFromKey('Home', 340, 1, 280, 520, 340), 280);
  assert.equal(resizeFromKey('End', 340, 1, 280, 520, 340), 520);
  assert.equal(resizeFromKey('Enter', 510, 1, 280, 520, 340), 340);
  assert.equal(resizeFromKey('Tab', 340, 1, 280, 520, 340), null);
});
