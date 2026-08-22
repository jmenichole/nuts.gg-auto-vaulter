const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = join(__dirname, '..');
const script = readFileSync(join(root, 'tiltcheck-nuts-autovault.user.js'), 'utf8');
const page = readFileSync(join(root, 'index.html'), 'utf8');

test('tip box defaults to checked for new installs', () => {
  const defaults = script.match(/function defaults\(\) \{[\s\S]*?autoTipEnabled:\s*(true|false)/);
  assert.ok(defaults, 'defaults() should declare autoTipEnabled');
  assert.equal(defaults[1], 'true');
});

test('panel still has the tip checkbox', () => {
  assert.match(script, /id="nvAutoTip"/);
  assert.match(script, /const tipChecked = config\.autoTipEnabled \? 'checked' : ''/);
});

test('install page tells people the tip starts checked and covers phone install', () => {
  assert.match(page, /Starts checked/i);
  assert.match(page, /Violentmonkey/);
  assert.match(page, /bookmark/i);
  assert.match(page, /da\.gd\/avn/);
});
