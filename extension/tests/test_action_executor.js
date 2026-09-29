import assert from 'node:assert';
import test from 'node:test';
import {
  resolveTarget,
  getCenterCoordinates,
  convertCoordinates,
  validateAction,
  setLocalSecret,
  getLocalSecret,
  clearLocalSecrets,
  executeClick,
  executeScroll,
  executeType,
  executeFillSecret,
  isSensitiveField,
  executeAction,
  executeActions
} from '../src/action_executor.js';


function createMockElement({
  tagName = 'div',
  id = '',
  attributes = {},
  rect = { left: 0, top: 0, width: 100, height: 50 }
} = {}) {
  const el = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    id,
    attributes: { ...attributes },
    eventsFired: [],
    focused: false,
    scrollLeft: 0,
    scrollTop: 0,
    getBoundingClientRect() {
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height
      };
    },
    dispatchEvent(ev) {
      this.eventsFired.push(ev);
      return true;
    },
    focus() {
      this.focused = true;
    },
    scrollTo(opts = {}) {
      if (typeof opts.left === 'number') this.scrollLeft = opts.left;
      if (typeof opts.top === 'number') this.scrollTop = opts.top;
    },
    scrollBy(opts = {}) {
      if (typeof opts.left === 'number') this.scrollLeft += opts.left;
      if (typeof opts.top === 'number') this.scrollTop += opts.top;
    }
  };
  return el;
}

test('action_executor module: getCenterCoordinates calculates correctly', () => {
  const coords1 = getCenterCoordinates({ target_bbox: [10, 20, 100, 50] });
  assert.deepStrictEqual(coords1, { x: 60, y: 45 });

  const coords2 = getCenterCoordinates({ point: [30, 40] });
  assert.deepStrictEqual(coords2, { x: 30, y: 40 });

  const coords3 = getCenterCoordinates({ x: 15, y: 25 });
  assert.deepStrictEqual(coords3, { x: 15, y: 25 });
});

test('action_executor module: executeClick and executeScroll work as expected', async () => {
  const btn = createMockElement({
    tagName: 'button',
    id: 'test-btn',
    rect: { left: 10, top: 20, width: 60, height: 30 }
  });

  // Mock global document
  const origDoc = globalThis.document;
  const origWin = globalThis.window;

  globalThis.document = {
    querySelector(sel) {
      if (sel === '#test-btn') return btn;
      return null;
    },
    elementFromPoint(x, y) {
      if (x >= 10 && x <= 70 && y >= 20 && y <= 50) return btn;
      return null;
    }
  };

  globalThis.window = {
    scrollX: 0,
    scrollY: 0,
    innerHeight: 800,
    innerWidth: 1000,
    scrollTo(opts = {}) {
      if (typeof opts.left === 'number') this.scrollX = opts.left;
      if (typeof opts.top === 'number') this.scrollY = opts.top;
    },
    scrollBy(opts = {}) {
      if (typeof opts.left === 'number') this.scrollX += opts.left;
      if (typeof opts.top === 'number') this.scrollY += opts.top;
    }
  };

  try {
    // Click by selector
    const clickRes = await executeClick({ target_selector: '#test-btn' });
    assert.strictEqual(clickRes.success, true);
    assert.strictEqual(btn.focused, true);
    assert.strictEqual(btn.eventsFired.length, 3);
    assert.strictEqual(btn.eventsFired[0].type, 'mousedown');
    assert.strictEqual(btn.eventsFired[1].type, 'mouseup');
    assert.strictEqual(btn.eventsFired[2].type, 'click');

    // Click by bbox
    btn.focused = false;
    btn.eventsFired = [];
    const clickBboxRes = await executeClick({ target_bbox: [10, 20, 60, 30] });
    assert.strictEqual(clickBboxRes.success, true);
    assert.strictEqual(btn.focused, true);
    assert.strictEqual(btn.eventsFired.length, 3);

    // Scroll
    const scrollRes = await executeScroll({ top: 500, behavior: 'smooth' });
    assert.strictEqual(scrollRes.success, true);
    assert.strictEqual(globalThis.window.scrollY, 500);

    // Action dispatcher
    const actionsRes = await executeActions([
      { type: 'scroll', deltaY: 50 },
      { type: 'click', target_selector: '#test-btn' }
    ]);
    assert.strictEqual(actionsRes.success, true);
    assert.strictEqual(globalThis.window.scrollY, 550);
  } finally {
    globalThis.document = origDoc;
    globalThis.window = origWin;
  }
});

test('action_executor module: isSensitiveField detects passwords, credit cards, SSNs and [REDACTED_*]', () => {
  // Password input
  const pwdInput = {
    nodeType: 1,
    type: 'password',
    getAttribute(k) { return k === 'type' ? 'password' : null; }
  };
  assert.strictEqual(isSensitiveField(pwdInput), true);

  // Credit card autocomplete
  const ccInput = {
    nodeType: 1,
    type: 'text',
    autocomplete: 'cc-number',
    getAttribute(k) { return k === 'autocomplete' ? 'cc-number' : null; }
  };
  assert.strictEqual(isSensitiveField(ccInput), true);

  // SSN name / placeholder
  const ssnInput = {
    nodeType: 1,
    type: 'text',
    name: 'user_ssn',
    placeholder: 'Social Security Number',
    getAttribute(k) { return k === 'name' ? 'user_ssn' : null; }
  };
  assert.strictEqual(isSensitiveField(ssnInput), true);

  // Marked as [REDACTED_*]
  const redactedInput = {
    nodeType: 1,
    type: 'text',
    value: '[REDACTED_SECRET]',
    getAttribute() { return null; }
  };
  assert.strictEqual(isSensitiveField(redactedInput), true);

  // Text contains [REDACTED_PASSWORD]
  const normalInput = {
    nodeType: 1,
    type: 'text',
    name: 'search_query',
    getAttribute() { return null; }
  };
  assert.strictEqual(isSensitiveField(normalInput, '[REDACTED_PASSWORD]'), true);
  assert.strictEqual(isSensitiveField(normalInput, 'normal text'), false);

  // Authorization override
  assert.strictEqual(isSensitiveField(pwdInput, 'secret', { allowSensitive: true }), false);
  assert.strictEqual(isSensitiveField(pwdInput, 'secret', { force: true }), false);
  assert.strictEqual(isSensitiveField(pwdInput, 'secret', { taskParameters: { allowSensitive: true } }), false);
});

test('action_executor module: executeType simulates typing with full event dispatch and safety enforcement', async () => {
  function createInputMock({ id = 'input-1', type = 'text', name = 'query', value = '', rect = { left: 5, top: 10, width: 200, height: 40 } } = {}) {
    return {
      nodeType: 1,
      tagName: 'INPUT',
      id,
      type,
      name,
      value,
      eventsFired: [],
      focused: false,
      getAttribute(k) {
        if (k === 'type') return this.type;
        if (k === 'name') return this.name;
        if (k === 'id') return this.id;
        return null;
      },
      focus() { this.focused = true; },
      blur() { this.focused = false; },
      dispatchEvent(ev) {
        this.eventsFired.push(ev);
        return true;
      },
      getBoundingClientRect() {
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          right: rect.left + rect.width,
          bottom: rect.top + rect.height
        };
      }
    };
  }

  const textInput = createInputMock({ id: 'search-input', type: 'text', name: 'search' });
  const pwdInput = createInputMock({ id: 'password-input', type: 'password', name: 'password' });

  const origDoc = globalThis.document;
  const origWin = globalThis.window;

  globalThis.document = {
    querySelector(sel) {
      if (sel === '#search-input') return textInput;
      if (sel === '#password-input') return pwdInput;
      return null;
    },
    evaluate(xpath) {
      if (xpath.includes('search-input')) return { singleNodeValue: textInput };
      return { singleNodeValue: null };
    },
    elementFromPoint(x, y) {
      if (x >= 5 && x <= 205 && y >= 10 && y <= 50) return textInput;
      return null;
    }
  };

  globalThis.window = {
    KeyboardEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.key = init.key;
        this.bubbles = init.bubbles ?? true;
      }
    },
    InputEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.data = init.data;
        this.inputType = init.inputType;
        this.bubbles = init.bubbles ?? true;
      }
    },
    Event: class {
      constructor(type, init = {}) {
        this.type = type;
        this.bubbles = init.bubbles ?? true;
      }
    }
  };

  try {
    // 1. Safety refusal on password field
    await assert.rejects(
      async () => {
        await executeType({ target_selector: '#password-input', text: 'my-secret-pass' });
      },
      (err) => {
        assert.match(err.message, /Safety Refusal/);
        assert.strictEqual(err.refused, true);
        return true;
      }
    );

    // 2. Override on sensitive field succeeds
    const overrideRes = await executeType(
      { target_selector: '#password-input', text: 'auth-secret' },
      undefined,
      { allowSensitive: true }
    );
    assert.strictEqual(overrideRes.success, true);
    assert.strictEqual(pwdInput.value, 'auth-secret');

    // 3. Normal typing by selector
    const resSel = await executeType('#search-input', 'hello');
    assert.strictEqual(resSel.success, true);
    assert.strictEqual(textInput.focused, true);
    assert.strictEqual(textInput.value, 'hello');

    // Verify dispatched events: focus + (keydown, beforeinput, input, keyup)*5 + change = 21 events
    const eventTypes = textInput.eventsFired.map(e => e.type);
    assert.ok(eventTypes.includes('keydown'));
    assert.ok(eventTypes.includes('beforeinput'));
    assert.ok(eventTypes.includes('input'));
    assert.ok(eventTypes.includes('keyup'));
    assert.ok(eventTypes.includes('change'));

    // 4. Typing by bbox with clearFirst
    textInput.eventsFired = [];
    const resBbox = await executeType(
      { target_bbox: [5, 10, 200, 40], text: 'abc', clearFirst: true }
    );
    assert.strictEqual(resBbox.success, true);
    assert.strictEqual(textInput.value, 'abc');

    // 5. Typing by xpath
    textInput.eventsFired = [];
    const resXpath = await executeType(
      { target_xpath: '//*[@id="search-input"]', text: 'xyz', clearFirst: true }
    );
    assert.strictEqual(resXpath.success, true);
    assert.strictEqual(textInput.value, 'xyz');

    // 6. executeAction dispatcher with type action
    textInput.eventsFired = [];
    const actionRes = await executeAction({
      type: 'type',
      target_selector: '#search-input',
      text: 'search query',
      clearFirst: true
    });
    assert.strictEqual(actionRes.success, true);
    assert.strictEqual(textInput.value, 'search query');
  } finally {
    globalThis.document = origDoc;
    globalThis.window = origWin;
  }
});

test('Ticket 06 / B7: convertCoordinates accurately translates between spaces', () => {
  // 1. canvas_scaled to viewport
  const vpCoords = convertCoordinates({ x: 384, y: 216 }, { scale: 0.5 }, 'canvas_scaled');
  assert.deepStrictEqual(vpCoords, { x: 768, y: 432 });

  // 2. viewport to canvas_scaled
  const canvasCoords = convertCoordinates([768, 432], { scale: 0.5 }, 'viewport');
  assert.deepStrictEqual(canvasCoords, { x: 384, y: 216 });

  // 3. scale 1.0 identity
  const idCoords = convertCoordinates({ x: 100, y: 200 }, { scale: 1.0 });
  assert.deepStrictEqual(idCoords, { x: 100, y: 200 });
});

test('Ticket 06 / B7: validateAction rejects malformed or dangerous actions', () => {
  // Reject non-object
  assert.strictEqual(validateAction(null).valid, false);

  // Reject unsupported action type
  assert.strictEqual(validateAction({ type: 'eval_js' }).valid, false);

  // Reject invalid confidence range (<0 or >1)
  assert.strictEqual(validateAction({ type: 'click', target_selector: '#btn', confidence: 1.5 }).valid, false);
  assert.strictEqual(validateAction({ type: 'click', target_selector: '#btn', confidence: -0.1 }).valid, false);
  assert.strictEqual(validateAction({ type: 'click', target_selector: '#btn', confidence: 0.85 }).valid, true);

  // Reject unsafe script injection in selector
  assert.strictEqual(validateAction({ type: 'click', target_selector: '<script>alert(1)</script>' }).valid, false);
  assert.strictEqual(validateAction({ type: 'click', target_selector: 'div[onclick="javascript:evil()"]' }).valid, false);
  assert.strictEqual(validateAction({ type: 'click', target_selector: 'button.primary-btn' }).valid, true);

  // Reject invalid bbox format or negative values
  assert.strictEqual(validateAction({ type: 'click', target_bbox: [10, 20] }).valid, false);
  assert.strictEqual(validateAction({ type: 'click', target_bbox: [-10, 20, 100, 50] }).valid, false);
  assert.strictEqual(validateAction({ type: 'click', target_bbox: [10, 20, 100, 50] }).valid, true);

  // Reject missing target for click
  assert.strictEqual(validateAction({ type: 'click' }).valid, false);
  assert.strictEqual(validateAction({ type: 'click', target_element_id: 'btn_submit' }).valid, true);
});

test('Ticket 06 / B7: resolveTarget prioritizes target_element_id over fragile bbox/selectors', () => {
  const origDoc = globalThis.document;
  try {
    const elById = createMockElement({ tagName: 'button', id: 'target_submit' });
    const elByQuery = createMockElement({ tagName: 'button', id: 'generic_btn' });

    globalThis.document = {
      getElementById(id) {
        if (id === 'target_submit') return elById;
        return null;
      },
      querySelector(sel) {
        if (sel === '#target_submit' || sel === '[id="target_submit"]') return elById;
        return elByQuery;
      },
      elementFromPoint() {
        return elByQuery;
      }
    };

    // Primary target_element_id resolves directly to elById even if other locators point elsewhere
    const resolved = resolveTarget({
      target_element_id: 'target_submit',
      target_selector: '#different_button',
      target_bbox: [0, 0, 50, 50]
    });
    assert.strictEqual(resolved, elById);
  } finally {
    globalThis.document = origDoc;
  }
});

test('Ticket 06 / B7: executeActions caps maximum actions per response', async () => {
  const excessiveActions = Array.from({ length: 15 }, () => ({
    type: 'wait',
    delay_ms: 10
  }));

  await assert.rejects(
    async () => await executeActions(excessiveActions, { maxActions: 10 }),
    /Exceeded max actions per response cap/
  );
});

test('Ticket 09 / B9: Capability-based secret autofill executes without leaking cleartext credentials', async () => {
  const origDoc = globalThis.document;
  const origWin = globalThis.window;
  clearLocalSecrets();

  try {
    const pwdInput = createMockElement({
      tagName: 'input',
      id: 'user_password',
      attributes: { type: 'password', name: 'password' }
    });
    pwdInput.value = '';

    globalThis.document = {
      getElementById(id) {
        if (id === 'user_password') return pwdInput;
        return null;
      },
      querySelector(sel) {
        if (sel.includes('user_password')) return pwdInput;
        return null;
      }
    };
    globalThis.window = {
      document: globalThis.document
    };

    // 1. Store secret in local vault only
    const SECRET_ALIAS = 'ACCOUNT_PASSWORD';
    const RAW_SECRET = 'SuperSecretP@ssw0rd!';
    setLocalSecret(SECRET_ALIAS, RAW_SECRET);

    // 2. Direct executeType without authorization is rejected
    await assert.rejects(
      async () => await executeType(pwdInput, RAW_SECRET),
      /Safety Refusal/
    );

    // 3. Planner payload emits only secret token/alias: "ACCOUNT_PASSWORD"
    const plannerAction = {
      type: 'fill_secret',
      target_element_id: 'user_password',
      secret_key: SECRET_ALIAS
    };

    // Assert that RAW_SECRET is never present in action payload
    const serializedAction = JSON.stringify(plannerAction);
    assert.strictEqual(serializedAction.includes(RAW_SECRET), false);
    assert.strictEqual(serializedAction.includes(SECRET_ALIAS), true);

    // 4. Execute fill_secret via action executor
    const res = await executeAction(plannerAction);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.action, 'fill_secret');
    assert.strictEqual(res.secret_key, SECRET_ALIAS);
    // Value in DOM element is populated accurately
    assert.strictEqual(pwdInput.value, RAW_SECRET);
    // Raw secret is not leaked in return result
    assert.strictEqual(res.value, undefined);

    // 5. Unknown secret key raises vault error
    await assert.rejects(
      async () => await executeAction({
        type: 'fill_secret',
        target_element_id: 'user_password',
        secret_key: 'NONEXISTENT_KEY'
      }),
      /Vault Error/
    );
  } finally {
    clearLocalSecrets();
    globalThis.document = origDoc;
    globalThis.window = origWin;
  }
});

