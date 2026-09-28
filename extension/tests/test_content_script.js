import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptSource = fs.readFileSync(path.join(__dirname, '../src/content_script.js'), 'utf8');

function createContext(extraGlobals = {}) {
  const sandbox = {
    console,
    Math,
    Set,
    String,
    Number,
    Object,
    Array,
    Date,
    ...extraGlobals
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(scriptSource, sandbox);
  return sandbox;
}

// Mock DOM factory for Node.js testing environment
function createMockElement({
  tagName = 'div',
  id = '',
  attributes = {},
  style = {},
  textContent = '',
  innerText = '',
  value = '',
  placeholder = '',
  children = [],
  rect = { left: 0, top: 0, width: 100, height: 50 },
  isContentEditable = false,
  nodeType = 1
} = {}) {
  const el = {
    nodeType,
    tagName: tagName.toUpperCase(),
    id,
    attributes: { ...attributes },
    style: { ...style },
    textContent,
    innerText: innerText || textContent,
    value,
    placeholder,
    children: [],
    childNodes: [],
    parentElement: null,
    parentNode: null,
    previousElementSibling: null,
    nextElementSibling: null,
    previousSibling: null,
    nextSibling: null,
    isContentEditable,
    listeners: {},
    eventsFired: [],
    focused: false,
    scrollLeft: 0,
    scrollTop: 0,
    lastScroll: null,
    getAttribute(name) {
      return this.attributes[name.toLowerCase()] ?? null;
    },
    setAttribute(name, val) {
      this.attributes[name.toLowerCase()] = String(val);
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name.toLowerCase());
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
    },
    addEventListener(type, fn) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      if (this.listeners[type]) {
        this.listeners[type] = this.listeners[type].filter(f => f !== fn);
      }
    },
    dispatchEvent(event) {
      this.eventsFired.push(event);
      if (typeof this['on' + event.type] === 'function') {
        this['on' + event.type](event);
      }
      if (this.listeners[event.type]) {
        for (const fn of this.listeners[event.type]) {
          fn(event);
        }
      }
      return !event.defaultPrevented;
    },
    focus() {
      this.focused = true;
    },
    scrollTo(opts = {}) {
      if (typeof opts.left === 'number') this.scrollLeft = opts.left;
      if (typeof opts.top === 'number') this.scrollTop = opts.top;
      this.lastScroll = { action: 'scrollTo', ...opts };
    },
    scrollBy(opts = {}) {
      if (typeof opts.left === 'number') this.scrollLeft += opts.left;
      if (typeof opts.top === 'number') this.scrollTop += opts.top;
      this.lastScroll = { action: 'scrollBy', ...opts };
    },
    click() {
      const ev = { type: 'click', bubbles: true, cancelable: true, clientX: 0, clientY: 0 };
      this.dispatchEvent(ev);
    }
  };

  // Wire up children
  for (const child of children) {
    el.children.push(child);
    el.childNodes.push(child);
    child.parentElement = el;
    child.parentNode = el;
  }

  for (let i = 0; i < el.children.length; i++) {
    if (i > 0) {
      el.children[i].previousElementSibling = el.children[i - 1];
      el.children[i - 1].nextElementSibling = el.children[i];
    }
  }

  for (let i = 0; i < el.childNodes.length; i++) {
    if (i > 0) {
      el.childNodes[i].previousSibling = el.childNodes[i - 1];
      el.childNodes[i - 1].nextSibling = el.childNodes[i];
    }
  }

  return el;
}

test('getCssSelector generates correct selectors', () => {
  const ctx = createContext();

  const root = createMockElement({ tagName: 'body' });
  const div1 = createMockElement({ tagName: 'div' });
  const div2 = createMockElement({ tagName: 'div' });
  const btn = createMockElement({ tagName: 'button', id: 'submit-btn' });
  const input = createMockElement({ tagName: 'input', attributes: { type: 'text' } });

  div1.children.push(btn);
  btn.parentElement = div1;
  div2.children.push(input);
  input.parentElement = div2;

  root.children.push(div1, div2);
  div1.parentElement = root;
  div2.parentElement = root;
  div2.previousElementSibling = div1;
  div1.nextElementSibling = div2;

  ctx.document = { body: root };

  assert.strictEqual(ctx.getCssSelector(btn), '#submit-btn');
  const inputSel = ctx.getCssSelector(input);
  assert.match(inputSel, /div:nth-of-type\(2\) > input/);
});

test('getXPath generates correct xpath expression', () => {
  const ctx = createContext();

  const root = createMockElement({ tagName: 'body' });
  const form = createMockElement({ tagName: 'form' });
  const btn = createMockElement({ tagName: 'button' });

  form.children.push(btn);
  btn.parentNode = form;
  root.children.push(form);
  form.parentNode = root;

  ctx.document = { body: root };

  const xpath = ctx.getXPath(btn);
  assert.strictEqual(xpath, '/html/body/form[1]/button[1]');
});

test('getRole identifies implicit and explicit roles', () => {
  const ctx = createContext();

  const explicit = createMockElement({ tagName: 'div', attributes: { role: 'dialog' } });
  assert.strictEqual(ctx.getRole(explicit), 'dialog');

  const btn = createMockElement({ tagName: 'button' });
  assert.strictEqual(ctx.getRole(btn), 'button');

  const link = createMockElement({ tagName: 'a', attributes: { href: 'https://example.com' } });
  assert.strictEqual(ctx.getRole(link), 'link');

  const checkbox = createMockElement({ tagName: 'input', attributes: { type: 'checkbox' } });
  assert.strictEqual(ctx.getRole(checkbox), 'checkbox');

  const passwordInput = createMockElement({ tagName: 'input', attributes: { type: 'password' } });
  assert.strictEqual(ctx.getRole(passwordInput), 'textbox');
});

test('getAriaLabel extracts label from aria-label, title, or alt', () => {
  const ctx = createContext();

  const elWithAria = createMockElement({ tagName: 'button', attributes: { 'aria-label': 'Close Dialog' } });
  assert.strictEqual(ctx.getAriaLabel(elWithAria), 'Close Dialog');

  const imgWithAlt = createMockElement({ tagName: 'img', attributes: { alt: 'Company Logo' } });
  assert.strictEqual(ctx.getAriaLabel(imgWithAlt), 'Company Logo');

  const elWithTitle = createMockElement({ tagName: 'span', attributes: { title: 'Tooltip Info' } });
  assert.strictEqual(ctx.getAriaLabel(elWithTitle), 'Tooltip Info');
});

test('getBoundingBox extracts [x, y, w, h]', () => {
  const ctx = createContext();

  const el = createMockElement({
    tagName: 'div',
    rect: { left: 12.345, top: 45.678, width: 200.12, height: 100.99 }
  });
  const bbox = ctx.getBoundingBox(el);
  assert.deepStrictEqual([...bbox], [12.35, 45.68, 200.12, 100.99]);
});

test('extractDomSkeleton traverses visible tree and prunes hidden nodes', () => {
  const ctx = createContext();

  const hiddenChild = createMockElement({
    tagName: 'span',
    textContent: 'Invisible secret',
    style: { display: 'none' }
  });

  const visibleButton = createMockElement({
    tagName: 'button',
    id: 'login-btn',
    textContent: 'Log In',
    attributes: { type: 'submit' },
    rect: { left: 50, top: 120, width: 80, height: 32 }
  });

  const emailInput = createMockElement({
    tagName: 'input',
    id: 'email-field',
    attributes: { type: 'email', name: 'user_email', placeholder: 'Enter email' },
    rect: { left: 50, top: 70, width: 200, height: 30 }
  });

  const scriptTag = createMockElement({
    tagName: 'script',
    textContent: 'console.log("script")'
  });

  const card = createMockElement({
    tagName: 'div',
    id: 'login-card',
    children: [hiddenChild, emailInput, visibleButton, scriptTag],
    rect: { left: 40, top: 50, width: 250, height: 150 }
  });

  const body = createMockElement({
    tagName: 'body',
    children: [card],
    rect: { left: 0, top: 0, width: 1024, height: 768 }
  });

  ctx.document = { body };

  // Extract skeleton
  const rawSkeleton = ctx.extractDomSkeleton(body);
  const skeleton = JSON.parse(JSON.stringify(rawSkeleton));

  assert.ok(skeleton, 'Skeleton should not be null');
  assert.strictEqual(skeleton.tag, 'body');
  assert.strictEqual(skeleton.children.length, 1);

  const cardNode = skeleton.children[0];
  assert.strictEqual(cardNode.tag, 'div');
  assert.strictEqual(cardNode.id, 'login-card');
  // script and hiddenChild should be pruned!
  assert.strictEqual(cardNode.children.length, 2);

  const [inputNode, btnNode] = cardNode.children;
  assert.strictEqual(inputNode.tag, 'input');
  assert.strictEqual(inputNode.type, 'email');
  assert.strictEqual(inputNode.name, 'user_email');
  assert.strictEqual(inputNode.placeholder, 'Enter email');
  assert.strictEqual(inputNode.role, 'textbox');
  assert.deepStrictEqual(inputNode.bbox, [50, 70, 200, 30]);

  assert.strictEqual(btnNode.tag, 'button');
  assert.strictEqual(btnNode.type, 'submit');
  assert.strictEqual(btnNode.text, 'Log In');
  assert.strictEqual(btnNode.role, 'button');
  assert.strictEqual(btnNode.selector, '#login-btn');
  assert.deepStrictEqual(btnNode.bbox, [50, 120, 80, 32]);

  // Flatten
  const rawFlattened = ctx.flattenSkeleton(rawSkeleton);
  const flattened = JSON.parse(JSON.stringify(rawFlattened));
  assert.strictEqual(flattened.length, 2);
  assert.strictEqual(flattened[0].id, 'email-field');
  assert.strictEqual(flattened[1].id, 'login-btn');
});

test('Message listener handles EXTRACT_DOM_SKELETON', () => {
  let registeredListener = null;
  const mockChrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          registeredListener = fn;
        }
      }
    }
  };

  const body = createMockElement({
    tagName: 'body',
    children: [
      createMockElement({
        tagName: 'button',
        id: 'test-btn',
        textContent: 'Click me',
        rect: { left: 10, top: 10, width: 60, height: 25 }
      })
    ]
  });

  const ctx = createContext({
    chrome: mockChrome,
    document: { body },
    innerWidth: 1024,
    innerHeight: 768,
    scrollX: 0,
    scrollY: 0
  });

  assert.ok(registeredListener, 'Message listener must be registered');

  let responseData = null;
  const wasAsync = registeredListener({ type: 'EXTRACT_DOM_SKELETON' }, {}, (res) => {
    responseData = res;
  });

  assert.strictEqual(wasAsync, true);
  assert.ok(responseData);
  assert.strictEqual(responseData.success, true);
  assert.ok(responseData.skeleton);
  assert.strictEqual(responseData.skeleton.children[0].id, 'test-btn');
  assert.strictEqual(responseData.elements.length, 1);
  assert.strictEqual(responseData.elements[0].id, 'test-btn');
  assert.strictEqual(responseData.viewport.width, 1024);
});

// Tests for Ticket 06: Action Execution (Click & Scroll)

function setupActionTestEnv() {
  const btn = createMockElement({
    tagName: 'button',
    id: 'submit-button',
    textContent: 'Submit Form',
    rect: { left: 100, top: 200, width: 80, height: 40 }
  });

  const textInput = createMockElement({
    tagName: 'input',
    id: 'search-input',
    rect: { left: 10, top: 10, width: 200, height: 35 }
  });
  textInput.value = '';
  textInput.type = 'text';
  textInput.name = 'search';

  const pwdInput = createMockElement({
    tagName: 'input',
    id: 'password-input',
    rect: { left: 10, top: 60, width: 200, height: 35 }
  });
  pwdInput.value = '';
  pwdInput.type = 'password';
  pwdInput.name = 'password';

  const scrollContainer = createMockElement({
    tagName: 'div',
    id: 'scroll-box',
    rect: { left: 20, top: 50, width: 300, height: 200 }
  });

  const body = createMockElement({
    tagName: 'body',
    children: [scrollContainer, btn, textInput, pwdInput],
    rect: { left: 0, top: 0, width: 1024, height: 768 }
  });

  const allElements = [body, scrollContainer, btn, textInput, pwdInput];

  const mockDoc = {
    body,
    documentElement: {
      scrollLeft: 0,
      scrollTop: 0
    },
    querySelector(sel) {
      if (sel.startsWith('#')) {
        const id = sel.slice(1);
        return allElements.find(el => el.id === id) || null;
      }
      return allElements.find(el => el.tagName.toLowerCase() === sel.toLowerCase()) || null;
    },
    evaluate(xpath) {
      const parts = xpath.split('/').filter(Boolean);
      const targetTag = parts[parts.length - 1]?.replace(/\[\d+\]/, '').toLowerCase();
      const node = allElements.find(el => el.tagName.toLowerCase() === targetTag);
      return { singleNodeValue: node || null };
    },
    elementFromPoint(x, y) {
      let matched = null;
      for (const el of allElements) {
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          matched = el;
        }
      }
      return matched;
    }
  };

  let registeredListener = null;
  const mockChrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          registeredListener = fn;
        }
      }
    }
  };

  const mockWindow = {
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1024,
    innerHeight: 768,
    lastScroll: null,
    scrollTo(opts = {}) {
      if (typeof opts.left === 'number') this.scrollX = opts.left;
      if (typeof opts.top === 'number') this.scrollY = opts.top;
      this.lastScroll = { action: 'scrollTo', ...opts };
    },
    scrollBy(opts = {}) {
      if (typeof opts.left === 'number') this.scrollX += opts.left;
      if (typeof opts.top === 'number') this.scrollY += opts.top;
      this.lastScroll = { action: 'scrollBy', ...opts };
    }
  };

  const ctx = createContext({
    chrome: mockChrome,
    document: mockDoc,
    ...mockWindow
  });

  return { ctx, btn, textInput, pwdInput, scrollContainer, mockDoc, mockWindow, getListener: () => registeredListener };
}

test('resolveTarget finds element via selector, xpath, bbox, coordinates, or element ref', () => {
  const { ctx, btn } = setupActionTestEnv();

  // Selector
  const elBySelector = ctx.resolveTarget({ target_selector: '#submit-button' });
  assert.strictEqual(elBySelector, btn);

  // Selector shorthand
  const elByStr = ctx.resolveTarget('#submit-button');
  assert.strictEqual(elByStr, btn);

  // XPath
  const elByXPath = ctx.resolveTarget({ target_xpath: '/html/body/button' });
  assert.strictEqual(elByXPath, btn);

  // Bounding box center: rect is [100, 200, 80, 40], center is (140, 220)
  const elByBbox = ctx.resolveTarget({ target_bbox: [100, 200, 80, 40] });
  assert.strictEqual(elByBbox, btn);

  // Point coordinates
  const elByPoint = ctx.resolveTarget({ point: { x: 140, y: 220 } });
  assert.strictEqual(elByPoint, btn);

  // Direct element
  const elDirect = ctx.resolveTarget({ element: btn });
  assert.strictEqual(elDirect, btn);

  // Non-matching target returns null
  const elMissing = ctx.resolveTarget({ target_selector: '#non-existent' });
  assert.strictEqual(elMissing, null);
});

test('executeClick focuses target and dispatches mousedown, mouseup, click in order', async () => {
  const { ctx, btn } = setupActionTestEnv();

  const result = await ctx.executeClick({ target_selector: '#submit-button' });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.action, 'click');
  assert.strictEqual(result.target.id, 'submit-button');
  assert.strictEqual(btn.focused, true, 'Element should have been focused');

  // Verify events fired
  assert.strictEqual(btn.eventsFired.length, 3, 'Should have fired 3 events');
  assert.strictEqual(btn.eventsFired[0].type, 'mousedown');
  assert.strictEqual(btn.eventsFired[1].type, 'mouseup');
  assert.strictEqual(btn.eventsFired[2].type, 'click');

  // Coordinates should be at center: rect left=100, top=200, w=80, h=40 -> cx=140, cy=220
  assert.strictEqual(btn.eventsFired[0].clientX, 140);
  assert.strictEqual(btn.eventsFired[0].clientY, 220);
  assert.strictEqual(btn.eventsFired[2].clientX, 140);
  assert.strictEqual(btn.eventsFired[2].clientY, 220);
});

test('executeClick resolves target by bounding box', async () => {
  const { ctx, btn } = setupActionTestEnv();

  const result = await ctx.executeClick({ target_bbox: [100, 200, 80, 40] });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.target.id, 'submit-button');
  assert.strictEqual(btn.focused, true);
  assert.strictEqual(btn.eventsFired.length, 3);
  assert.strictEqual(result.target.coordinates.x, 140);
  assert.strictEqual(result.target.coordinates.y, 220);
});

test('executeClick throws error on missing target element', async () => {
  const { ctx } = setupActionTestEnv();

  await assert.rejects(
    async () => {
      await ctx.executeClick({ target_selector: '#missing-element' });
    },
    /Target element not found/
  );
});

test('executeScroll handles window absolute, delta, and directional scroll', async () => {
  const { ctx } = setupActionTestEnv();

  // Absolute scroll
  const resAbsolute = await ctx.executeScroll({ top: 350, left: 50, behavior: 'smooth' });
  assert.strictEqual(resAbsolute.success, true);
  assert.strictEqual(resAbsolute.target, 'window');
  assert.strictEqual(ctx.scrollY, 350);
  assert.strictEqual(ctx.scrollX, 50);

  // Delta scroll
  const resDelta = await ctx.executeScroll({ deltaY: 100, deltaX: 20 });
  assert.strictEqual(resDelta.success, true);
  assert.strictEqual(ctx.scrollY, 450);
  assert.strictEqual(ctx.scrollX, 70);

  // Directional scroll (down)
  const resDown = await ctx.executeScroll({ direction: 'down', distance: 200 });
  assert.strictEqual(resDown.success, true);
  assert.strictEqual(ctx.scrollY, 650);

  // Directional scroll (up)
  const resUp = await ctx.executeScroll({ direction: 'up', distance: 150 });
  assert.strictEqual(resUp.success, true);
  assert.strictEqual(ctx.scrollY, 500);
});

test('executeScroll handles container element scroll', async () => {
  const { ctx, scrollContainer } = setupActionTestEnv();

  // Absolute scroll on container
  const res = await ctx.executeScroll({
    target_selector: '#scroll-box',
    top: 120,
    behavior: 'smooth'
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.target, 'element');
  assert.strictEqual(scrollContainer.scrollTop, 120);

  // Delta scroll on container
  await ctx.executeScroll({
    target_selector: '#scroll-box',
    deltaY: 50
  });
  assert.strictEqual(scrollContainer.scrollTop, 170);
});

test('executeAction and executeActions dispatch click, scroll, and multiple actions', async () => {
  const { ctx, btn } = setupActionTestEnv();

  // Single click
  const clickRes = await ctx.executeAction({
    type: 'click',
    target_selector: '#submit-button'
  });
  assert.strictEqual(clickRes.success, true);
  assert.strictEqual(btn.focused, true);

  // Single scroll
  const scrollRes = await ctx.executeAction({
    type: 'scroll',
    top: 250
  });
  assert.strictEqual(scrollRes.success, true);
  assert.strictEqual(ctx.scrollY, 250);

  // Multiple sequential actions
  btn.focused = false;
  btn.eventsFired = [];
  const multiRes = await ctx.executeActions([
    { type: 'scroll', top: 50 },
    { type: 'click', target_selector: '#submit-button' }
  ]);
  assert.strictEqual(multiRes.success, true);
  assert.strictEqual(multiRes.results.length, 2);
  assert.strictEqual(ctx.scrollY, 50);
  assert.strictEqual(btn.focused, true);

  // Unsupported action throws
  await assert.rejects(
    async () => {
      await ctx.executeAction({ type: 'unknown_action' });
    },
    /Unsupported action type/
  );
});

test('Message listener handles ACTION_EXECUTE from background script', async () => {
  const { btn, getListener } = setupActionTestEnv();
  const listener = getListener();
  assert.ok(listener, 'Message listener should be registered');

  // Test click action message
  let clickResponse = null;
  listener(
    {
      type: 'ACTION_EXECUTE',
      action: {
        type: 'click',
        target_selector: '#submit-button'
      }
    },
    {},
    (res) => {
      clickResponse = res;
    }
  );

  // Wait a microtask for async processing
  await new Promise(r => setTimeout(r, 10));

  assert.ok(clickResponse, 'Response should have been received');
  assert.strictEqual(clickResponse.success, true);
  assert.strictEqual(clickResponse.action, 'click');
  assert.strictEqual(btn.focused, true);

  // Test scroll action message
  let scrollResponse = null;
  listener(
    {
      type: 'ACTION_EXECUTE',
      action: {
        type: 'scroll',
        top: 400
      }
    },
    {},
    (res) => {
      scrollResponse = res;
    }
  );

  await new Promise(r => setTimeout(r, 10));
  assert.ok(scrollResponse);
  assert.strictEqual(scrollResponse.success, true);
  assert.strictEqual(scrollResponse.action, 'scroll');

  // Test failed action message returns success: false
  let failResponse = null;
  listener(
    {
      type: 'ACTION_EXECUTE',
      action: {
        type: 'click',
        target_selector: '#missing-btn'
      }
    },
    {},
    (res) => {
      failResponse = res;
    }
  );

  await new Promise(r => setTimeout(r, 10));
  assert.ok(failResponse);
  assert.strictEqual(failResponse.success, false);
  assert.match(failResponse.error, /Target element not found/);
});

test('content_script: executeType simulates typing, dispatches events and enforces safety', async () => {
  const { ctx, textInput, pwdInput } = setupActionTestEnv();

  // Safety check blocks password field
  await assert.rejects(
    async () => {
      await ctx.executeType('#password-input', 'topsecret');
    },
    /Safety Refusal/
  );

  // Safety override allows password field
  const authRes = await ctx.executeType('#password-input', 'topsecret', { allowSensitive: true });
  assert.strictEqual(authRes.success, true);
  assert.strictEqual(pwdInput.value, 'topsecret');

  // Normal typing into text input
  const typeRes = await ctx.executeType({ target_selector: '#search-input', text: 'shoes' });
  assert.strictEqual(typeRes.success, true);
  assert.strictEqual(textInput.value, 'shoes');
  assert.strictEqual(textInput.focused, true);

  // Verify events dispatched
  const eventTypes = textInput.eventsFired.map(e => e.type);
  assert.ok(eventTypes.includes('keydown'));
  assert.ok(eventTypes.includes('beforeinput'));
  assert.ok(eventTypes.includes('input'));
  assert.ok(eventTypes.includes('keyup'));
  assert.ok(eventTypes.includes('change'));

  // Typing by bbox
  textInput.value = '';
  textInput.eventsFired = [];
  const bboxRes = await ctx.executeType({ target_bbox: [10, 10, 200, 35], text: 'laptop' });
  assert.strictEqual(bboxRes.success, true);
  assert.strictEqual(textInput.value, 'laptop');
});

test('content_script: Message listener handles type action via ACTION_EXECUTE', async () => {
  const { textInput, getListener } = setupActionTestEnv();
  const listener = getListener();

  let response = null;
  textInput.value = '';
  listener(
    {
      type: 'ACTION_EXECUTE',
      action: {
        type: 'type',
        target_selector: '#search-input',
        text: 'headphones'
      }
    },
    {},
    (res) => {
      response = res;
    }
  );

  await new Promise(r => setTimeout(r, 10));
  assert.ok(response);
  assert.strictEqual(response.success, true);
  assert.strictEqual(response.action, 'type');
  assert.strictEqual(textInput.value, 'headphones');
});
