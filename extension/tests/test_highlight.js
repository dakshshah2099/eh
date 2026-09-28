import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contentScriptSource = fs.readFileSync(path.join(__dirname, '../src/content_script.js'), 'utf8');

function createMockDomEnvironment() {
  const elements = new Map();

  class MockElement {
    constructor(tagName, id = '', className = '') {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.className = className;
      this.attributes = new Map();
      this.style = {
        _props: new Map(),
        setProperty(name, val, priority) {
          this._props.set(name, val);
          this[name] = val;
        },
        getPropertyValue(name) {
          return this._props.get(name) || '';
        },
        removeProperty(name) {
          this._props.delete(name);
          delete this[name];
        }
      };
      this.dataset = {};
      this.children = [];
      this.parentElement = null;
      if (id) elements.set(`#${id}`, this);
    }

    getAttribute(name) {
      return this.attributes.get(name) || null;
    }

    setAttribute(name, val) {
      this.attributes.set(name, String(val));
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[key] = String(val);
      }
    }

    hasAttribute(name) {
      return this.attributes.has(name);
    }

    removeAttribute(name) {
      this.attributes.delete(name);
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        delete this.dataset[key];
      }
    }

    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    }

    remove() {
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this);
        if (idx !== -1) {
          this.parentElement.children.splice(idx, 1);
        }
        this.parentElement = null;
      }
    }

    getBoundingClientRect() {
      return { top: 100, left: 50, width: 200, height: 40 };
    }
  }

  const body = new MockElement('body');
  const doc = {
    body,
    getElementById(id) {
      return elements.get(`#${id}`) || body.children.find(c => c.id === id) || null;
    },
    querySelector(sel) {
      return elements.get(sel) || null;
    },
    querySelectorAll(sel) {
      const results = [];
      function traverse(node) {
        if (sel === '[data-privacy-lens-highlight]' && node.hasAttribute && node.hasAttribute('data-privacy-lens-highlight')) {
          results.push(node);
        }
        for (const child of node.children || []) {
          traverse(child);
        }
      }
      traverse(body);
      return results;
    },
    createElement(tag) {
      return new MockElement(tag);
    },
    elementFromPoint() {
      return null;
    }
  };

  const win = {
    document: doc,
    scrollY: 0,
    scrollX: 0,
    addEventListener() {},
    removeEventListener() {}
  };

  return { doc, win, body, elements, MockElement };
}

test('PII Highlighting: apply, toggle, and clear lifecycle', () => {
  const { doc, win, body, elements, MockElement } = createMockDomEnvironment();

  // Create sample form elements
  const pwdInput = new MockElement('input', 'password');
  pwdInput.type = 'password';
  body.appendChild(pwdInput);

  const cardInput = new MockElement('input', 'card-number');
  cardInput.type = 'text';
  body.appendChild(cardInput);

  const sandbox = {
    console,
    Math,
    Set,
    String,
    Number,
    Object,
    Array,
    Date,
    document: doc,
    window: win,
    globalThis: win
  };

  vm.createContext(sandbox);
  vm.runInContext(contentScriptSource, sandbox);

  assert.equal(typeof sandbox.applyPiiHighlights, 'function');
  assert.equal(typeof sandbox.clearPiiHighlights, 'function');
  assert.equal(typeof sandbox.togglePiiHighlights, 'function');
  assert.equal(typeof sandbox.getPiiHighlightStatus, 'function');

  // Test Initial Status
  let status = sandbox.getPiiHighlightStatus();
  assert.equal(status.active, false);
  assert.equal(status.count, 0);

  // Apply Highlights
  const regions = [
    { selector: '#password', category: 'password', bbox: [50, 100, 200, 40] },
    { selector: '#card-number', category: 'card', bbox: [50, 160, 200, 40] }
  ];

  const applyRes = sandbox.applyPiiHighlights(regions);
  assert.equal(applyRes.success, true);
  assert.equal(applyRes.active, true);
  assert.equal(applyRes.count, 2);

  // Verify elements have data attributes and outlines
  assert.equal(pwdInput.dataset.privacyLensHighlight, 'password');
  assert.ok(pwdInput.style.outline.includes('#ef4444'), 'Password outline should be red');

  assert.equal(cardInput.dataset.privacyLensHighlight, 'card');
  assert.ok(cardInput.style.outline.includes('#f97316'), 'Card outline should be orange');

  // Verify container was created
  const container = doc.getElementById('privacy-lens-pii-container');
  assert.ok(container, 'Container div should exist in DOM');
  assert.equal(container.children.length, 2, 'Two badges should be inside container');
  assert.ok(container.children[0].textContent.includes('PASSWORD'));
  assert.ok(container.children[1].textContent.includes('CREDIT CARD'));

  // Test Status
  status = sandbox.getPiiHighlightStatus();
  assert.equal(status.active, true);
  assert.equal(status.count, 2);

  // Toggle Highlights (should turn off)
  const toggleOffRes = sandbox.togglePiiHighlights(regions);
  assert.equal(toggleOffRes.active, false);
  assert.equal(toggleOffRes.count, 0);

  // Verify cleanup
  assert.equal(pwdInput.dataset.privacyLensHighlight, undefined);
  assert.equal(pwdInput.style.outline, '');
  assert.equal(doc.getElementById('privacy-lens-pii-container'), null);

  // Toggle Highlights (should turn on)
  const toggleOnRes = sandbox.togglePiiHighlights(regions);
  assert.equal(toggleOnRes.active, true);
  assert.equal(toggleOnRes.count, 2);
  assert.ok(doc.getElementById('privacy-lens-pii-container'));

  // Explicit Clear
  const clearRes = sandbox.clearPiiHighlights();
  assert.equal(clearRes.active, false);
  assert.equal(clearRes.count, 0);
  assert.equal(doc.getElementById('privacy-lens-pii-container'), null);
});
