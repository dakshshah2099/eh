/**
 * @fileoverview Comprehensive unit tests for Ticket 10 — DOM-Level Detector.
 * Tests detectSensitiveDomElements pure function against all required rules and schemas.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  detectSensitiveDomElements,
  evaluateElementSensitivity,
  normalizeBBox,
  getSelectorForNode,
  findSensitiveKeyword,
  mapKeywordToCategory,
  SENSITIVE_CATEGORIES,
  SENSITIVE_DOM_REGEX,
  AUTOCOMPLETE_PATTERNS
} from './dom_detector.js';

test('DOM Detector: Rule 1 - input[type=password] -> category: password', () => {
  const skeleton = {
    tag: 'input',
    type: 'password',
    selector: '#user-pass',
    bbox: [100, 200, 250, 40]
  };

  const results = detectSensitiveDomElements(skeleton);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    bbox: [100, 200, 250, 40],
    category: 'password',
    source: 'dom',
    confidence: 1.0,
    selector: '#user-pass'
  });
});

test('DOM Detector: Rule 2 - autocomplete attributes matching cc-*|email|tel', () => {
  const elements = [
    {
      tag: 'input',
      type: 'text',
      autocomplete: 'cc-number',
      selector: '#cc-num',
      bbox: [10, 20, 200, 30]
    },
    {
      tag: 'input',
      type: 'text',
      autocomplete: 'section-billing cc-csc',
      selector: '#cc-csc',
      bbox: [10, 60, 80, 30]
    },
    {
      tag: 'input',
      type: 'text',
      autocomplete: 'cc-exp',
      selector: '#cc-exp',
      bbox: [100, 60, 80, 30]
    },
    {
      tag: 'input',
      type: 'text',
      autocomplete: 'email',
      selector: '#ac-email',
      bbox: [10, 100, 200, 30]
    },
    {
      tag: 'input',
      type: 'text',
      autocomplete: 'tel',
      selector: '#ac-tel',
      bbox: [10, 140, 150, 30]
    },
    {
      tag: 'input',
      type: 'text',
      autocomplete: 'tel-national',
      selector: '#ac-tel-nat',
      bbox: [10, 180, 150, 30]
    },
    {
      tag: 'input',
      type: 'text',
      autocomplete: 'username',
      selector: '#ac-user',
      bbox: [10, 220, 150, 30]
    },
    {
      tag: 'input',
      type: 'text',
      autocomplete: 'off',
      selector: '#ac-off',
      bbox: [10, 260, 150, 30]
    }
  ];

  const results = detectSensitiveDomElements(elements);

  // username and off should not be flagged
  assert.equal(results.length, 6);

  assert.equal(results[0].category, 'card');
  assert.equal(results[0].selector, '#cc-num');

  assert.equal(results[1].category, 'card');
  assert.equal(results[1].selector, '#cc-csc');

  assert.equal(results[2].category, 'card');
  assert.equal(results[2].selector, '#cc-exp');

  assert.equal(results[3].category, 'email');
  assert.equal(results[3].selector, '#ac-email');

  assert.equal(results[4].category, 'phone');
  assert.equal(results[4].selector, '#ac-tel');

  assert.equal(results[5].category, 'phone');
  assert.equal(results[5].selector, '#ac-tel-nat');

  // Verify all entries conform to schema
  for (const r of results) {
    assert.equal(r.source, 'dom');
    assert.equal(r.confidence, 1.0);
    assert(Array.isArray(r.bbox) && r.bbox.length === 4);
    assert(typeof r.selector === 'string');
  }
});

test('DOM Detector: Rule 3 - type=email, tel, number (if labeled or named card/pin)', () => {
  const elements = [
    {
      tag: 'input',
      type: 'email',
      name: 'contact',
      selector: 'input[name="contact"]',
      bbox: [0, 0, 100, 20]
    },
    {
      tag: 'input',
      type: 'tel',
      name: 'cellphone',
      selector: 'input[name="cellphone"]',
      bbox: [0, 25, 100, 20]
    },
    {
      tag: 'input',
      type: 'number',
      name: 'card_cvv',
      selector: '#card-cvv-num',
      bbox: [0, 50, 50, 20]
    },
    {
      tag: 'input',
      type: 'number',
      name: 'atm_pin',
      selector: '#atm-pin-num',
      bbox: [0, 75, 50, 20]
    },
    {
      tag: 'input',
      type: 'number',
      placeholder: 'Enter 4-digit PIN',
      selector: '#placeholder-pin',
      bbox: [0, 100, 50, 20]
    },
    {
      tag: 'input',
      type: 'number',
      ariaLabel: 'Credit card security code',
      selector: '#aria-card-code',
      bbox: [0, 125, 50, 20]
    },
    // Non-sensitive number inputs should NOT be flagged
    {
      tag: 'input',
      type: 'number',
      name: 'quantity',
      selector: '#item-quantity',
      bbox: [0, 150, 50, 20]
    },
    {
      tag: 'input',
      type: 'number',
      name: 'user_age',
      selector: '#user-age',
      bbox: [0, 175, 50, 20]
    },
    {
      tag: 'input',
      type: 'number',
      placeholder: 'Zip code',
      selector: '#zip-code',
      bbox: [0, 200, 50, 20]
    }
  ];

  const results = detectSensitiveDomElements(elements);
  assert.equal(results.length, 6);

  assert.equal(results[0].category, 'email');
  assert.equal(results[0].selector, 'input[name="contact"]');

  assert.equal(results[1].category, 'phone');
  assert.equal(results[1].selector, 'input[name="cellphone"]');

  assert.equal(results[2].category, 'card');
  assert.equal(results[2].selector, '#card-cvv-num');

  assert.equal(results[3].category, 'pin');
  assert.equal(results[3].selector, '#atm-pin-num');

  assert.equal(results[4].category, 'pin');
  assert.equal(results[4].selector, '#placeholder-pin');

  assert.equal(results[5].category, 'card');
  assert.equal(results[5].selector, '#aria-card-code');
});

test('DOM Detector: Rule 4 - regex matching ssn|social|card|cvv|cvc|otp|pan|pin|password|secret|tax', () => {
  const testCases = [
    { node: { tag: 'input', name: 'user_ssn', selector: '#ssn-1' }, expectedCat: 'ssn' },
    { node: { tag: 'input', id: 'social_security_number', selector: '#social_security_number' }, expectedCat: 'ssn' },
    { node: { tag: 'input', placeholder: 'Social Security #', selector: '#ssn-ph' }, expectedCat: 'ssn' },
    { node: { tag: 'input', ariaLabel: 'Social Security Number', selector: '#ssn-al' }, expectedCat: 'ssn' },
    { node: { tag: 'input', name: 'credit_card', selector: '#cc-1' }, expectedCat: 'card' },
    { node: { tag: 'input', id: 'cvv', selector: '#cvv' }, expectedCat: 'card' },
    { node: { tag: 'input', placeholder: 'CVC / CVV code', selector: '#cvc-ph' }, expectedCat: 'card' },
    { node: { tag: 'input', name: 'pan_number', selector: '#pan-1' }, expectedCat: 'card' },
    { node: { tag: 'input', name: 'sms_otp', selector: '#otp-1' }, expectedCat: 'otp' },
    { node: { tag: 'input', id: 'user_pin', selector: '#user_pin' }, expectedCat: 'pin' },
    { node: { tag: 'input', name: 'login_password', selector: '#pwd-1' }, expectedCat: 'password' },
    { node: { tag: 'input', name: 'client_secret', selector: '#sec-1' }, expectedCat: 'password' },
    { node: { tag: 'input', placeholder: 'Tax Identification Number (TIN)', selector: '#tax-1' }, expectedCat: 'tax' }
  ];

  for (const { node, expectedCat } of testCases) {
    const results = detectSensitiveDomElements(node);
    assert.equal(results.length, 1, `Failed to detect node matching ${expectedCat}: ${JSON.stringify(node)}`);
    assert.equal(results[0].category, expectedCat);
    assert.equal(results[0].source, 'dom');
    assert.equal(results[0].confidence, 1.0);
  }
});

test('DOM Detector: False positive resistance (shipping, pantry, syntax, spin, company)', () => {
  const nonSensitiveElements = [
    { tag: 'input', name: 'shipping_address', selector: '#ship' },
    { tag: 'input', name: 'billing_company', selector: '#company' },
    { tag: 'input', name: 'pantry_items', selector: '#pantry' },
    { tag: 'input', name: 'syntax_highlighter', selector: '#syntax' },
    { tag: 'input', name: 'spinner_value', selector: '#spin' },
    { tag: 'input', name: 'country_code', selector: '#country' },
    { tag: 'input', name: 'first_name', selector: '#first_name' },
    { tag: 'input', name: 'last_name', selector: '#last_name' }
  ];

  const results = detectSensitiveDomElements(nonSensitiveElements);
  assert.equal(results.length, 0);
});

test('DOM Detector: Nested DOM tree hierarchy traversal', () => {
  const tree = {
    tag: 'body',
    bbox: [0, 0, 1024, 768],
    children: [
      {
        tag: 'header',
        children: [
          { tag: 'h1', text: 'Checkout', bbox: [20, 20, 200, 30] }
        ]
      },
      {
        tag: 'form',
        id: 'checkout-form',
        selector: '#checkout-form',
        bbox: [20, 80, 500, 400],
        children: [
          {
            tag: 'div',
            children: [
              {
                tag: 'label',
                text: 'Password',
                children: []
              },
              {
                tag: 'input',
                type: 'password',
                id: 'pwd-field',
                selector: '#pwd-field',
                bbox: [20, 120, 200, 32]
              }
            ]
          },
          {
            tag: 'div',
            children: [
              {
                tag: 'input',
                type: 'text',
                name: 'card_number',
                selector: 'input[name="card_number"]',
                bbox: [20, 170, 200, 32]
              }
            ]
          },
          {
            tag: 'div',
            children: [
              {
                tag: 'input',
                type: 'text',
                name: 'shipping_address',
                selector: 'input[name="shipping_address"]',
                bbox: [20, 220, 200, 32]
              }
            ]
          }
        ]
      }
    ]
  };

  const detections = detectSensitiveDomElements(tree);
  assert.equal(detections.length, 2);

  assert.equal(detections[0].selector, '#pwd-field');
  assert.equal(detections[0].category, 'password');
  assert.deepEqual(detections[0].bbox, [20, 120, 200, 32]);

  assert.equal(detections[1].selector, 'input[name="card_number"]');
  assert.equal(detections[1].category, 'card');
  assert.deepEqual(detections[1].bbox, [20, 170, 200, 32]);
});

test('DOM Detector: Handles envelopes ({ skeleton }, { tree }, { elements })', () => {
  const envelope1 = {
    skeleton: {
      tag: 'input',
      type: 'password',
      id: 'env-pwd',
      bbox: [10, 10, 100, 30]
    }
  };
  const res1 = detectSensitiveDomElements(envelope1);
  assert.equal(res1.length, 1);
  assert.equal(res1[0].selector, '#env-pwd');

  const envelope2 = {
    elements: [
      { tag: 'input', type: 'email', id: 'env-email', bbox: [20, 20, 100, 30] },
      { tag: 'input', type: 'text', name: 'first_name', bbox: [20, 60, 100, 30] }
    ]
  };
  const res2 = detectSensitiveDomElements(envelope2);
  assert.equal(res2.length, 1);
  assert.equal(res2[0].selector, '#env-email');
});

test('DOM Detector: BBox normalization and fallback selector generation', () => {
  // Object bbox { x, y, width, height }
  const nodeWithObjBox = {
    tag: 'input',
    type: 'password',
    name: 'secret_box',
    bbox: { x: 50, y: 75, width: 220, height: 35 }
  };
  const resObj = detectSensitiveDomElements(nodeWithObjBox);
  assert.deepEqual(resObj[0].bbox, [50, 75, 220, 35]);
  assert.equal(resObj[0].selector, 'input[name="secret_box"]');

  // Node without bbox or selector
  const nodeNoBbox = {
    tag: 'input',
    type: 'password'
  };
  const resNoBox = detectSensitiveDomElements(nodeNoBbox);
  assert.deepEqual(resNoBox[0].bbox, [0, 0, 0, 0]);
  assert.equal(resNoBox[0].selector, 'input[type="password"]');
});

test('DOM Detector: Empty / null / invalid input safety', () => {
  assert.deepEqual(detectSensitiveDomElements(null), []);
  assert.deepEqual(detectSensitiveDomElements(undefined), []);
  assert.deepEqual(detectSensitiveDomElements([]), []);
  assert.deepEqual(detectSensitiveDomElements({}), []);
  assert.deepEqual(detectSensitiveDomElements('not an object'), []);
  assert.deepEqual(detectSensitiveDomElements(12345), []);
});

test('DOM Detector: Custom categorization options (telCategory, pinCategory, taxCategory, otpCategory)', () => {
  const elements = [
    { tag: 'input', type: 'tel', id: 'phone-field' },
    { tag: 'input', type: 'number', name: 'pin', id: 'pin-field' },
    { tag: 'input', name: 'otp_code', id: 'otp-field' },
    { tag: 'input', name: 'tax_number', id: 'tax-field' }
  ];

  // Default
  const def = detectSensitiveDomElements(elements);
  assert.equal(def[0].category, 'phone');
  assert.equal(def[1].category, 'pin');
  assert.equal(def[2].category, 'otp');
  assert.equal(def[3].category, 'tax');

  // Custom options
  const custom = detectSensitiveDomElements(elements, {
    telCategory: 'tel',
    pinCategory: 'password',
    otpCategory: 'two-factor',
    taxCategory: 'ssn'
  });
  assert.equal(custom[0].category, 'tel');
  assert.equal(custom[1].category, 'password');
  assert.equal(custom[2].category, 'two-factor');
  assert.equal(custom[3].category, 'ssn');
});

test('DOM Detector: Integration with extractDomSkeleton from content_script', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const contentScriptSource = fs.readFileSync(path.join(__dirname, 'content_script.js'), 'utf8');

  // Create isolated mock DOM environment
  const sandbox = {
    console,
    Math,
    Set,
    String,
    Number,
    Object,
    Array,
    Date
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(contentScriptSource, sandbox);

  // Build a synthetic DOM tree
  function createMockNode(tag, attrs = {}, rect = [0, 0, 100, 30]) {
    return {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: attrs.id || '',
      type: attrs.type || '',
      attributes: { ...attrs },
      children: [],
      childNodes: [],
      getAttribute(k) { return this.attributes[k.toLowerCase()] ?? null; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k.toLowerCase()); },
      getBoundingClientRect() {
        return { left: rect[0], top: rect[1], width: rect[2], height: rect[3], right: rect[0] + rect[2], bottom: rect[1] + rect[3] };
      }
    };
  }

  const root = createMockNode('body', {}, [0, 0, 1024, 768]);
  const form = createMockNode('form', { id: 'payment-form' }, [10, 10, 400, 300]);
  const emailInput = createMockNode('input', { type: 'email', id: 'user-email', autocomplete: 'email' }, [20, 20, 250, 32]);
  const passInput = createMockNode('input', { type: 'password', id: 'user-pass' }, [20, 60, 250, 32]);
  const cardInput = createMockNode('input', { type: 'text', id: 'card-num', autocomplete: 'cc-number' }, [20, 100, 250, 32]);
  const submitBtn = createMockNode('button', { type: 'submit' }, [20, 140, 100, 32]);

  root.children.push(form);
  form.children.push(emailInput, passInput, cardInput, submitBtn);

  // Extract skeleton via content_script logic
  const skeleton = sandbox.extractDomSkeleton(root);
  assert(skeleton !== null, 'extractDomSkeleton should return a structured tree');

  // Detect sensitive elements from extracted skeleton
  const detections = detectSensitiveDomElements(skeleton);
  assert.equal(detections.length, 3);

  const categories = detections.map(d => d.category);
  assert(categories.includes('email'));
  assert(categories.includes('password'));
  assert(categories.includes('card'));

  for (const d of detections) {
    assert.equal(d.source, 'dom');
    assert.equal(d.confidence, 1.0);
    assert(Array.isArray(d.bbox) && d.bbox.length === 4);
    assert(typeof d.selector === 'string');
  }
});
