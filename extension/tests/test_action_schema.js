import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_ACTION_TYPES,
  validateAction,
  validateNavigationUrl
} from '../src/action_schema.js';

import {
  validateAction as executorValidateAction,
  validateNavigationUrl as executorValidateNavigationUrl,
  ALLOWED_ACTION_TYPES as executorAllowedTypes
} from '../src/action_executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contentScriptSource = fs.readFileSync(path.join(__dirname, '../src/content_script.js'), 'utf8');

function createContentScriptContext(extraGlobals = {}) {
  const sandbox = {
    console,
    Math,
    Set,
    String,
    Number,
    Object,
    Array,
    Date,
    Symbol,
    ...extraGlobals
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(contentScriptSource, sandbox);
  return sandbox;
}

test('Ticket 08 / C8: action_schema exports canonical ALLOWED_ACTION_TYPES set', () => {
  assert.ok(ALLOWED_ACTION_TYPES instanceof Set, 'ALLOWED_ACTION_TYPES must be a Set');
  const expectedTypes = ['click', 'type', 'input', 'scroll', 'wait', 'navigate', 'fill_secret', 'done'];
  for (const expected of expectedTypes) {
    assert.strictEqual(
      ALLOWED_ACTION_TYPES.has(expected),
      true,
      `ALLOWED_ACTION_TYPES must include canonical action: "${expected}"`
    );
  }
});

test('Ticket 08 / C8: validateNavigationUrl validates permitted schemes and rejects dangerous schemes', () => {
  // Valid http / https
  const httpRes = validateNavigationUrl('http://example.com/api');
  assert.strictEqual(httpRes.valid, true);
  assert.strictEqual(httpRes.url, 'http://example.com/api');

  const httpsRes = validateNavigationUrl('https://example.com/auth');
  assert.strictEqual(httpsRes.valid, true);

  // Dangerous / forbidden schemes
  const forbidden = [
    'javascript:alert(1)',
    'data:text/html,<b>xss</b>',
    'file:///etc/hosts',
    'chrome://settings',
    'chrome-extension://id/options.html'
  ];
  for (const bad of forbidden) {
    const res = validateNavigationUrl(bad);
    assert.strictEqual(res.valid, false, `Expected forbidden rejection for: ${bad}`);
    assert.match(res.error, /Forbidden URL scheme/i);
  }

  // Unsupported schemes
  assert.strictEqual(validateNavigationUrl('ftp://ftp.example.com').valid, false);
  assert.strictEqual(validateNavigationUrl('about:blank').valid, false);

  // Empty / invalid
  assert.strictEqual(validateNavigationUrl('').valid, false);
  assert.strictEqual(validateNavigationUrl(null).valid, false);
});

test('Ticket 08 / C8: validateAction validates schema invariants thoroughly', () => {
  // Object structure
  assert.strictEqual(validateAction(null).valid, false);
  assert.strictEqual(validateAction('click').valid, false);
  assert.strictEqual(validateAction({}).valid, false);

  // Unsupported type
  assert.strictEqual(validateAction({ type: 'unknown_type_xyz' }).valid, false);

  // Confidence bounds [0.0, 1.0]
  assert.strictEqual(validateAction({ type: 'wait', confidence: 1.1 }).valid, false);
  assert.strictEqual(validateAction({ type: 'wait', confidence: -0.1 }).valid, false);
  assert.strictEqual(validateAction({ type: 'wait', confidence: 0.5 }).valid, true);

  // Selector safety
  assert.strictEqual(validateAction({ type: 'click', target_selector: '<script>alert(1)</script>' }).valid, false);
  assert.strictEqual(validateAction({ type: 'click', target_selector: 'div[onclick="bad()"]' }).valid, false);
  assert.strictEqual(validateAction({ type: 'click', target_selector: '#valid-btn' }).valid, true);

  // BBox validity
  assert.strictEqual(validateAction({ type: 'click', target_bbox: [10, 20] }).valid, false);
  assert.strictEqual(validateAction({ type: 'click', target_bbox: [-1, 0, 50, 50] }).valid, false);
  assert.strictEqual(validateAction({ type: 'click', target_bbox: [0, 0, 50, 50] }).valid, true);

  // Target requirements for target-dependent actions
  assert.strictEqual(validateAction({ type: 'click' }).valid, false);
  assert.strictEqual(validateAction({ type: 'fill_secret' }).valid, false);
  assert.strictEqual(validateAction({ type: 'fill_secret', target_element_id: 'pwd' }).valid, false); // missing secret_key
  assert.strictEqual(validateAction({ type: 'fill_secret', target_element_id: 'pwd', secret_key: 'KEY' }).valid, true);

  // Navigate url validation
  assert.strictEqual(validateAction({ type: 'navigate' }).valid, false);
  assert.strictEqual(validateAction({ type: 'navigate', url: 'javascript:alert(1)' }).valid, false);
  assert.strictEqual(validateAction({ type: 'navigate', url: 'https://example.com' }).valid, true);
});

test('Ticket 08 / C8: action_executor uses centralized action_schema without validation drift', () => {
  assert.strictEqual(executorAllowedTypes, ALLOWED_ACTION_TYPES, 'action_executor must re-export identical ALLOWED_ACTION_TYPES');
  assert.strictEqual(executorValidateAction, validateAction, 'action_executor must use identical validateAction');
  assert.strictEqual(executorValidateNavigationUrl, validateNavigationUrl, 'action_executor must use identical validateNavigationUrl');
});

test('Ticket 08 / C8: content_script uses centralized action_schema', () => {
  const ctx = createContentScriptContext();
  assert.ok(ctx.ALLOWED_ACTION_TYPES instanceof Set, 'content_script must expose ALLOWED_ACTION_TYPES as a Set');
  assert.strictEqual(typeof ctx.validateAction, 'function', 'content_script must expose validateAction');
  assert.strictEqual(typeof ctx.validateNavigationUrl, 'function', 'content_script must expose validateNavigationUrl');

  // Verify content script validates identically
  assert.strictEqual(ctx.validateAction({ type: 'click', target_selector: '#btn' }).valid, true);
  assert.strictEqual(ctx.validateAction({ type: 'click' }).valid, false);
  assert.strictEqual(ctx.validateAction({ type: 'navigate', url: 'javascript:alert(1)' }).valid, false);
});

test('Ticket 08 / C8: Mutating ALLOWED_ACTION_TYPES is reflected across both executor and content_script without editing tests', () => {
  const customActionType = 'custom_drag_and_drop';
  const customAction = { type: customActionType };

  // 1. Initial state: unrecognized across schema, executor, and content script
  assert.strictEqual(ALLOWED_ACTION_TYPES.has(customActionType), false);
  assert.strictEqual(validateAction(customAction).valid, false);
  assert.strictEqual(executorValidateAction(customAction).valid, false);

  const ctxBefore = createContentScriptContext();
  assert.strictEqual(ctxBefore.ALLOWED_ACTION_TYPES.has(customActionType), false);
  assert.strictEqual(ctxBefore.validateAction(customAction).valid, false);

  try {
    // 2. Add custom action type to canonical ALLOWED_ACTION_TYPES set
    ALLOWED_ACTION_TYPES.add(customActionType);

    // 3. Immediately recognized by schema validator
    assert.strictEqual(ALLOWED_ACTION_TYPES.has(customActionType), true);
    assert.strictEqual(validateAction(customAction).valid, true);

    // 4. Immediately recognized by action_executor
    assert.strictEqual(executorAllowedTypes.has(customActionType), true);
    assert.strictEqual(executorValidateAction(customAction).valid, true);

    // 5. Immediately recognized by content_script
    const ctxAfter = createContentScriptContext();
    assert.strictEqual(ctxAfter.ALLOWED_ACTION_TYPES.has(customActionType), true);
    assert.strictEqual(ctxAfter.validateAction(customAction).valid, true);
  } finally {
    // 6. Cleanup: delete custom action type
    ALLOWED_ACTION_TYPES.delete(customActionType);
  }

  // 7. Verify clean reversion across all consumers
  assert.strictEqual(ALLOWED_ACTION_TYPES.has(customActionType), false);
  assert.strictEqual(validateAction(customAction).valid, false);
  assert.strictEqual(executorValidateAction(customAction).valid, false);

  const ctxReverted = createContentScriptContext();
  assert.strictEqual(ctxReverted.ALLOWED_ACTION_TYPES.has(customActionType), false);
  assert.strictEqual(ctxReverted.validateAction(customAction).valid, false);
});

test('Ticket 01: done action validates and performs round-trip across executor and content script', async () => {
  // 1. ALLOWED_ACTION_TYPES contains done
  assert.strictEqual(ALLOWED_ACTION_TYPES.has('done'), true);
  assert.strictEqual(executorAllowedTypes.has('done'), true);

  // 2. Validate done action object with type or action property
  const doneActionWithType = { type: 'done', reason: 'Task goal satisfied: profile submitted' };
  const valType = validateAction(doneActionWithType);
  assert.strictEqual(valType.valid, true);

  const doneActionWithAction = { action: 'done', reason: 'Visible order confirmation screen' };
  const valAction = validateAction(doneActionWithAction);
  assert.strictEqual(valAction.valid, true);

  const executorVal = executorValidateAction(doneActionWithType);
  assert.strictEqual(executorVal.valid, true);

  // 3. Content script validates done action
  const ctx = createContentScriptContext();
  assert.strictEqual(ctx.ALLOWED_ACTION_TYPES.has('done'), true);
  assert.strictEqual(ctx.validateAction(doneActionWithType).valid, true);

  // 4. Action executor round-trip: executeAction returns success with done type and reason
  const { executeAction } = await import('../src/action_executor.js');
  const execResult = await executeAction(doneActionWithType);
  assert.strictEqual(execResult.success, true);
  assert.strictEqual(execResult.action, 'done');
  assert.strictEqual(execResult.reason, 'Task goal satisfied: profile submitted');
});

