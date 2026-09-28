import assert from 'node:assert';
import test from 'node:test';
import {
  resolveTarget,
  getCenterCoordinates,
  executeClick,
  executeScroll,
  executeType,
  isSensitiveField,
  executeAction,
  executeActions
} from './action_executor.js';

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
