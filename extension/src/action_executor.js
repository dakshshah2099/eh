/**
 * Privacy Lens Agent - Action Executor
 *
 * Implements action execution (Click & Scroll) on DOM elements
 * based on target bounding box, CSS selector, or XPath.
 */

import {
  saveSecretToVault,
  deleteSecretFromVault,
  getSecretValue,
  clearSecretVault
} from './secret_vault.js';
import {
  classifyActionRisk,
  enforceConfirmationGate,
  ConfirmationRequired,
  ConfirmationDeclined,
  ConfirmationRequiredError,
  ConfirmationDeclinedError,
  RISK_TIERS,
  HIGH_RISK_PATTERNS,
  executeWithRiskGate
} from './action_policy.js';

/**
 * Translates coordinates between canvas scaled space and browser viewport space.
 * @param {{x: number, y: number}|number[]} coords - Coordinate point [x, y] or {x, y}
 * @param {object} [options={}] - Scaling options { scale, image: { scale, width, height }, viewport: { width, height } }
 * @param {string} [fromSpace='canvas_scaled'] - Source coordinate space ('canvas_scaled' or 'viewport')
 * @returns {{x: number, y: number}} Converted viewport coordinates
 */
export function convertCoordinates(coords, options = {}, fromSpace = 'canvas_scaled') {
  if (!coords) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  if (Array.isArray(coords)) {
    x = Number(coords[0]) || 0;
    y = Number(coords[1]) || 0;
  } else if (typeof coords === 'object') {
    x = Number(coords.x ?? coords.clientX ?? coords.left ?? 0);
    y = Number(coords.y ?? coords.clientY ?? coords.top ?? 0);
  }

  const scale = Number(options.scale || options.image?.scale || 1.0);
  if (scale <= 0 || scale === 1.0) {
    return { x: Math.round(x), y: Math.round(y) };
  }

  if (fromSpace === 'canvas_scaled') {
    return {
      x: Math.round(x / scale),
      y: Math.round(y / scale)
    };
  } else if (fromSpace === 'viewport') {
    return {
      x: Math.round(x * scale),
      y: Math.round(y * scale)
    };
  }

  return { x: Math.round(x), y: Math.round(y) };
}

import {
  ALLOWED_ACTION_TYPES,
  validateNavigationUrl,
  validateAction
} from './action_schema.js';

export { ALLOWED_ACTION_TYPES, validateNavigationUrl, validateAction };


// Local in-memory / session vault for secret credentials
const _secretVault = new Map();

/**
 * Stores a credential secret in the local browser vault.
 * Secrets never leave the extension.
 * @param {string} alias - Alias key (e.g., 'ACCOUNT_PASSWORD', 'LOGIN_SECRET')
 * @param {string} value - Cleartext secret value
 */
export function setLocalSecret(alias, value) {
  if (!alias) throw new Error('Secret alias must be provided');
  const key = String(alias);
  const val = String(value || '');
  _secretVault.set(key, val);
  if (typeof chrome !== 'undefined' && chrome.storage?.session?.set) {
    try {
      chrome.storage.session.set({ [`secret_${key}`]: val, [key]: val });
    } catch (_) {}
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    saveSecretToVault(key, val).catch(() => {});
  }
}

/**
 * Retrieves a credential secret from local storage / memory.
 * @param {string} alias
 * @returns {Promise<string|null>}
 */
export async function getLocalSecret(alias) {
  if (!alias) return null;
  const key = String(alias);
  if (_secretVault.has(key)) {
    return _secretVault.get(key);
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.session?.get) {
    try {
      const res = await chrome.storage.session.get([`secret_${key}`, key]);
      if (res && res[`secret_${key}`]) {
        return res[`secret_${key}`];
      }
      if (res && res[key]) {
        return res[key];
      }
    } catch (_) {}
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const val = await getSecretValue(key);
      if (val != null) {
        return val;
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Deletes a credential secret from local vault.
 * @param {string} alias
 */
export function deleteLocalSecret(alias) {
  if (!alias) return;
  const key = String(alias);
  _secretVault.delete(key);
  if (typeof chrome !== 'undefined' && chrome.storage?.session?.remove) {
    try {
      chrome.storage.session.remove([`secret_${key}`, key]);
    } catch (_) {}
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    deleteSecretFromVault(key).catch(() => {});
  }
}

/**
 * Clears stored secrets from local vault.
 */
export function clearLocalSecrets() {
  _secretVault.clear();
  if (typeof chrome !== 'undefined' && chrome.storage?.session?.clear) {
    try { chrome.storage.session.clear(); } catch (_) {}
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    clearSecretVault().catch(() => {});
  }
}

/**
 * Computes center coordinates { x, y } from target specification.
 *
 * @param {Object} target - Locator or action parameter
 * @returns {{ x: number, y: number }|null}
 */
export function getCenterCoordinates(target) {
  if (!target || typeof target !== 'object') return null;

  if (Array.isArray(target) && target.length >= 2) {
    const x = target[0] || 0;
    const y = target[1] || 0;
    const w = target[2] || 0;
    const h = target[3] || 0;
    return {
      x: x + w / 2,
      y: y + h / 2
    };
  }

  if (typeof target.x === 'number' && typeof target.y === 'number') {
    return { x: target.x, y: target.y };
  }

  const pt = target.point || target.coordinates;
  if (Array.isArray(pt) && pt.length >= 2) {
    return { x: pt[0], y: pt[1] };
  }
  if (pt && typeof pt === 'object') {
    if (typeof pt.x === 'number' && typeof pt.y === 'number') {
      return { x: pt.x, y: pt.y };
    }
    if (typeof pt.clientX === 'number' && typeof pt.clientY === 'number') {
      return { x: pt.clientX, y: pt.clientY };
    }
  }

  const bbox = target.target_bbox || target.bbox;
  if (Array.isArray(bbox) && bbox.length >= 2) {
    const x = bbox[0] || 0;
    const y = bbox[1] || 0;
    const w = bbox[2] || 0;
    const h = bbox[3] || 0;
    return {
      x: x + w / 2,
      y: y + h / 2
    };
  }

  if (bbox && typeof bbox === 'object') {
    const x = bbox.x ?? bbox.left ?? 0;
    const y = bbox.y ?? bbox.top ?? 0;
    const w = bbox.width ?? bbox.w ?? 0;
    const h = bbox.height ?? bbox.h ?? 0;
    return {
      x: x + w / 2,
      y: y + h / 2
    };
  }

  return null;
}

/**
 * Resolves a DOM element from various locator strategies:
 * - Direct element
 * - CSS selector (target_selector, selector)
 * - XPath (target_xpath, xpath)
 * - Bounding box center (target_bbox, bbox) via document.elementFromPoint
 * - Coordinate point via document.elementFromPoint
 *
 * @param {Object|Element|string} target - Locator specification
 * @returns {Element|null} The resolved DOM element or null
 */
export function resolveTarget(target) {
  if (!target) return null;

  if (typeof Element !== 'undefined' && target instanceof Element) {
    return target;
  }
  if (target.nodeType === 1) {
    return target;
  }
  if (target.element && (target.element.nodeType === 1 || (typeof Element !== 'undefined' && target.element instanceof Element))) {
    return target.element;
  }

  if (typeof target === 'string') {
    return resolveTarget({ selector: target });
  }

  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return null;

  // 1. Try element_id / target_element_id first (ticket 06 - primary target)
  const elementId = target.target_element_id || target.element_id || target.id;
  if (elementId && typeof elementId === 'string') {
    try {
      if (typeof doc.getElementById === 'function') {
        const el = doc.getElementById(elementId);
        if (el) return el;
      }
      if (typeof doc.querySelector === 'function') {
        const cleanId = elementId.replace(/["'\\]/g, '');
        const el = doc.querySelector(`[data-element-id="${cleanId}"], [id="${cleanId}"]`);
        if (el) return el;
      }
    } catch (_) {}
  }

  // 2. Try CSS selector with safety check (reject script injection / dangerous constructs)
  const selector = target.target_selector || target.selector || target.cssSelector;
  if (selector && typeof selector === 'string') {
    const isDangerous = /<script|javascript:|on\w+=/i.test(selector);
    if (!isDangerous) {
      try {
        if (typeof doc.querySelector === 'function') {
          const el = doc.querySelector(selector);
          if (el) return el;
        }
      } catch (e) {
        console.warn('[ActionExecutor] querySelector failed for:', selector, e);
      }
    }
  }

  // 2. Try XPath
  const xpath = target.target_xpath || target.xpath;
  if (xpath && typeof xpath === 'string') {
    try {
      if (typeof doc.evaluate === 'function') {
        const xpathType = (typeof XPathResult !== 'undefined' && XPathResult.FIRST_ORDERED_NODE_TYPE)
          ? XPathResult.FIRST_ORDERED_NODE_TYPE
          : 9;
        const result = doc.evaluate(xpath, doc, null, xpathType, null);
        if (result && result.singleNodeValue) {
          return result.singleNodeValue;
        }
      }
    } catch (e) {
      console.warn('[ActionExecutor] XPath failed for:', xpath, e);
    }
  }

  // 3. Try Bounding Box center or point via elementFromPoint
  const coords = getCenterCoordinates(target);
  if (coords && typeof doc.elementFromPoint === 'function') {
    const el = doc.elementFromPoint(coords.x, coords.y);
    if (el) return el;
  }

  return null;
}

/**
 * Dispatches click action on a resolved element.
 * Focuses element and fires mousedown, mouseup, and click MouseEvents.
 *
 * @param {Object} params - Click parameters (target_selector, target_bbox, etc.)
 * @returns {Promise<Object>} Execution result
 */
export async function executeClick(params = {}) {
  const targetEl = resolveTarget(params);
  if (!targetEl) {
    throw new Error(`Target element not found for click: ${JSON.stringify(params)}`);
  }

  // Determine coordinates
  let coords = getCenterCoordinates(params);
  if (!coords && typeof targetEl.getBoundingClientRect === 'function') {
    const rect = targetEl.getBoundingClientRect();
    coords = {
      x: (rect.left || 0) + (rect.width || 0) / 2,
      y: (rect.top || 0) + (rect.height || 0) / 2
    };
  }
  const clientX = coords ? coords.x : 0;
  const clientY = coords ? coords.y : 0;

  // 1. Focus element
  if (typeof targetEl.focus === 'function') {
    try {
      targetEl.focus();
    } catch (_) {}
  }

  // 2. Dispatch MouseEvents
  const win = typeof window !== 'undefined' ? window : null;
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: win,
    detail: 1,
    clientX,
    clientY,
    screenX: clientX,
    screenY: clientY,
    button: 0,
    buttons: 1
  };

  const createMouseEvent = (type, init = {}) => {
    if (typeof MouseEvent === 'function') {
      try {
        return new MouseEvent(type, init);
      } catch (_) {}
    }
    return {
      type,
      bubbles: init.bubbles ?? true,
      cancelable: init.cancelable ?? true,
      composed: init.composed ?? true,
      detail: init.detail ?? 1,
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
      screenX: init.screenX ?? 0,
      screenY: init.screenY ?? 0,
      button: init.button ?? 0,
      buttons: init.buttons ?? 0,
      view: init.view ?? null,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }
    };
  };

  const downEvent = createMouseEvent('mousedown', eventInit);
  const upEvent = createMouseEvent('mouseup', { ...eventInit, buttons: 0 });
  const clickEvent = createMouseEvent('click', { ...eventInit, buttons: 0 });

  let dispatched = false;
  if (typeof targetEl.dispatchEvent === 'function') {
    targetEl.dispatchEvent(downEvent);
    targetEl.dispatchEvent(upEvent);
    targetEl.dispatchEvent(clickEvent);
    dispatched = true;
  }

  if (!dispatched && typeof targetEl.click === 'function') {
    targetEl.click();
  }

  return {
    success: true,
    action: 'click',
    target: {
      tagName: targetEl.tagName,
      id: targetEl.id || null,
      coordinates: { x: clientX, y: clientY }
    }
  };
}

/**
 * Dispatches scroll action on window or container element.
 *
 * @param {Object} params - Scroll parameters
 * @returns {Promise<Object>} Execution result
 */
export async function executeScroll(params = {}) {
  const win = typeof window !== 'undefined' ? window : null;
  const doc = typeof document !== 'undefined' ? document : null;

  let container = null;
  if (params.target_selector || params.selector || params.target_bbox || params.bbox || params.element) {
    container = resolveTarget(params);
  }

  const behavior = params.behavior || 'smooth';

  let deltaX = params.deltaX ?? params.dx ?? null;
  let deltaY = params.deltaY ?? params.dy ?? null;

  if (params.direction) {
    const dir = String(params.direction).toLowerCase();
    const viewportHeight = (win && win.innerHeight) ? win.innerHeight : 768;
    const viewportWidth = (win && win.innerWidth) ? win.innerWidth : 1024;
    const distance = params.distance ?? Math.round(viewportHeight * 0.8);

    if (dir === 'down') deltaY = distance;
    else if (dir === 'up') deltaY = -distance;
    else if (dir === 'right') deltaX = params.distance ?? Math.round(viewportWidth * 0.8);
    else if (dir === 'left') deltaX = -(params.distance ?? Math.round(viewportWidth * 0.8));
  }

  let top = params.top ?? params.y ?? params.scrollTop ?? null;
  let left = params.left ?? params.x ?? params.scrollLeft ?? null;

  if (container) {
    if (deltaX !== null || deltaY !== null) {
      const dX = deltaX ?? 0;
      const dY = deltaY ?? 0;
      if (typeof container.scrollBy === 'function') {
        container.scrollBy({ left: dX, top: dY, behavior });
      } else {
        if (typeof container.scrollLeft === 'number') container.scrollLeft += dX;
        if (typeof container.scrollTop === 'number') container.scrollTop += dY;
      }
    } else if (top !== null || left !== null) {
      const targetTop = top ?? (container.scrollTop || 0);
      const targetLeft = left ?? (container.scrollLeft || 0);
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({ top: targetTop, left: targetLeft, behavior });
      } else {
        if (top !== null) container.scrollTop = top;
        if (left !== null) container.scrollLeft = left;
      }
    }

    return {
      success: true,
      action: 'scroll',
      target: 'element',
      element: {
        tagName: container.tagName,
        id: container.id || null
      },
      scroll: {
        scrollLeft: container.scrollLeft || 0,
        scrollTop: container.scrollTop || 0
      }
    };
  }

  if (deltaX !== null || deltaY !== null) {
    const dX = deltaX ?? 0;
    const dY = deltaY ?? 0;
    if (win && typeof win.scrollBy === 'function') {
      win.scrollBy({ left: dX, top: dY, behavior });
    } else if (win && typeof win.scrollTo === 'function') {
      win.scrollTo({
        left: (win.scrollX || 0) + dX,
        top: (win.scrollY || 0) + dY,
        behavior
      });
    } else if (doc && doc.documentElement) {
      if (typeof doc.documentElement.scrollLeft === 'number') doc.documentElement.scrollLeft += dX;
      if (typeof doc.documentElement.scrollTop === 'number') doc.documentElement.scrollTop += dY;
    }
  } else if (top !== null || left !== null) {
    const targetTop = top ?? (win ? (win.scrollY || 0) : 0);
    const targetLeft = left ?? (win ? (win.scrollX || 0) : 0);
    if (win && typeof win.scrollTo === 'function') {
      win.scrollTo({ top: targetTop, left: targetLeft, behavior });
    } else if (doc && doc.documentElement) {
      if (top !== null) doc.documentElement.scrollTop = top;
      if (left !== null) doc.documentElement.scrollLeft = left;
    }
  }

  const scrollX = win ? (win.scrollX || 0) : (doc?.documentElement?.scrollLeft || 0);
  const scrollY = win ? (win.scrollY || 0) : (doc?.documentElement?.scrollTop || 0);

  return {
    success: true,
    action: 'scroll',
    target: 'window',
    scroll: {
      scrollX,
      scrollY
    }
  };
}

/**
 * Detects whether a DOM element or text contains sensitive/redacted information.
 * Refuses typing into password, credit card, ssn, or [REDACTED_*] fields
 * unless authorized by options or task parameters.
 *
 * @param {Element|null} element - Target DOM element
 * @param {string} [text=''] - Text to be typed
 * @param {Object} [options={}] - Execution options
 * @returns {boolean} True if field/text is sensitive/redacted and not explicitly authorized
 */
export function isSensitiveField(element, text = '', options = {}) {
  const isAuthorized = Boolean(
    options.allowSensitive ||
    options.force ||
    options.overrideSensitive ||
    options.taskParameters?.allowSensitive ||
    options.task_parameters?.allowSensitive
  );
  if (isAuthorized) {
    return false;
  }

  // Check if text to type contains redaction markers
  if (typeof text === 'string' && /\[REDACTED(?:_[A-Z0-9]+)?\]/i.test(text)) {
    return true;
  }

  if (!element) return false;

  // 1. Password input type
  const type = (element.type || (typeof element.getAttribute === 'function' ? element.getAttribute('type') : '') || '').toLowerCase();
  if (type === 'password') {
    return true;
  }

  // 2. Sensitive autocomplete attributes
  const autocomplete = (element.autocomplete || (typeof element.getAttribute === 'function' ? element.getAttribute('autocomplete') : '') || '').toLowerCase();
  const sensitiveAutocompletes = [
    'current-password', 'new-password', 'cc-number', 'cc-csc', 'cc-exp',
    'cc-exp-month', 'cc-exp-year', 'cc-type', 'transaction-amount', 'bday', 'sex', 'ssn'
  ];
  if (sensitiveAutocompletes.some(attr => autocomplete.includes(attr))) {
    return true;
  }

  // 3. Name, ID, Class, Placeholder, Aria-label pattern matching
  const name = (element.name || (typeof element.getAttribute === 'function' ? element.getAttribute('name') : '') || '').toLowerCase();
  const id = (element.id || (typeof element.getAttribute === 'function' ? element.getAttribute('id') : '') || '').toLowerCase();
  const placeholder = (element.placeholder || (typeof element.getAttribute === 'function' ? element.getAttribute('placeholder') : '') || '').toLowerCase();
  const ariaLabel = ((typeof element.getAttribute === 'function' ? element.getAttribute('aria-label') : '') || '').toLowerCase();
  const className = (typeof element.className === 'string' ? element.className : '').toLowerCase();

  const sensitivePattern = /(password|passwd|pwd|passcode|secret|credit[-_]?card|card[-_]?num|cvv|cvc|security[-_]?code|ssn|social[-_]?sec)/i;

  if (
    sensitivePattern.test(name) ||
    sensitivePattern.test(id) ||
    sensitivePattern.test(placeholder) ||
    sensitivePattern.test(ariaLabel) ||
    sensitivePattern.test(className)
  ) {
    return true;
  }

  // 4. Data attributes indicating redacted or sensitive
  if (
    (typeof element.getAttribute === 'function' && element.getAttribute('data-sensitive') === 'true') ||
    (typeof element.getAttribute === 'function' && element.getAttribute('data-redacted') === 'true') ||
    (typeof element.getAttribute === 'function' && element.getAttribute('data-privacy') === 'redacted')
  ) {
    return true;
  }

  // 5. Existing element value / text containing [REDACTED_*]
  const val = element.value || element.textContent || '';
  if (/\[REDACTED(?:_[A-Z0-9]+)?\]/i.test(val)) {
    return true;
  }

  return false;
}

/**
 * Executes a simulated typing action into a target input, textarea, or editable element.
 * Resolves target via selector, xpath, bbox, point, or direct element.
 * Enforces critical safety checks against sensitive/redacted fields.
 * Dispatches focus, beforeinput, input, keydown, keyup, and change events.
 *
 * @param {Object|Element|string} target - Target locator or action parameters
 * @param {string} [text] - Text to type
 * @param {Object} [options={}] - Options (clearFirst, delay, allowSensitive, blurAfter, etc.)
 * @returns {Promise<Object>} Execution result
 */
export async function executeType(target, text, options = {}) {
  let targetParam = target;
  let textToType = text;
  let opts = options || {};

  // Support executeType(params) where params = { target, text, ... }
  if (
    typeof target === 'object' &&
    target !== null &&
    !Array.isArray(target) &&
    !(typeof Element !== 'undefined' && target instanceof Element) &&
    target.nodeType !== 1 &&
    text === undefined
  ) {
    targetParam = target.target || target.element || target;
    textToType = target.text ?? target.value ?? '';
    opts = { ...target, ...options };
  } else if (text !== undefined) {
    textToType = String(text);
  } else {
    textToType = '';
  }

  const targetEl = resolveTarget(targetParam);
  if (!targetEl) {
    throw new Error(`Target element not found for type: ${JSON.stringify(targetParam)}`);
  }

  // CRITICAL SAFETY CHECK
  if (isSensitiveField(targetEl, textToType, opts)) {
    const err = new Error(`Safety Refusal: Refusing to type into sensitive/redacted field or type redacted data without explicit authorization.`);
    err.refused = true;
    err.sensitive = true;
    throw err;
  }

  // 1. Focus element
  if (typeof targetEl.focus === 'function') {
    try {
      targetEl.focus();
    } catch (_) {}
  }

  const win = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null);

  const createKeyboardEvent = (type, key, init = {}) => {
    if (win && typeof win.KeyboardEvent === 'function') {
      try {
        return new win.KeyboardEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          key,
          code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
          charCode: key.charCodeAt(0),
          keyCode: key.charCodeAt(0),
          which: key.charCodeAt(0),
          view: win,
          ...init
        });
      } catch (_) {}
    }
    return {
      type,
      bubbles: init.bubbles ?? true,
      cancelable: init.cancelable ?? true,
      composed: init.composed ?? true,
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }
    };
  };

  const createInputEvent = (type, data, inputType = 'insertText', init = {}) => {
    if (win && typeof win.InputEvent === 'function') {
      try {
        return new win.InputEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          data,
          inputType,
          view: win,
          ...init
        });
      } catch (_) {}
    }
    return {
      type,
      bubbles: init.bubbles ?? true,
      cancelable: init.cancelable ?? true,
      composed: init.composed ?? true,
      data,
      inputType,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }
    };
  };

  const createEvent = (type, init = {}) => {
    if (win && typeof win.Event === 'function') {
      try {
        return new win.Event(type, {
          bubbles: true,
          cancelable: false,
          composed: true,
          ...init
        });
      } catch (_) {}
    }
    return {
      type,
      bubbles: init.bubbles ?? true,
      cancelable: init.cancelable ?? false,
      composed: init.composed ?? true,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }
    };
  };

  // Optional clear previous value
  if (opts.clearFirst) {
    if (typeof targetEl.value === 'string') {
      targetEl.value = '';
    } else if (typeof targetEl.textContent === 'string') {
      targetEl.textContent = '';
    }
  }

  // Simulate typing character by character
  const chars = Array.from(textToType);
  for (const char of chars) {
    // keydown
    const downEv = createKeyboardEvent('keydown', char);
    if (typeof targetEl.dispatchEvent === 'function') {
      targetEl.dispatchEvent(downEv);
    }

    // beforeinput
    const beforeInputEv = createInputEvent('beforeinput', char, 'insertText');
    if (typeof targetEl.dispatchEvent === 'function') {
      targetEl.dispatchEvent(beforeInputEv);
    }

    // update value
    if (typeof targetEl.value === 'string') {
      targetEl.value += char;
    } else if (typeof targetEl.textContent === 'string') {
      targetEl.textContent += char;
    }

    // input
    const inputEv = createInputEvent('input', char, 'insertText');
    if (typeof targetEl.dispatchEvent === 'function') {
      targetEl.dispatchEvent(inputEv);
    }

    // keyup
    const upEv = createKeyboardEvent('keyup', char);
    if (typeof targetEl.dispatchEvent === 'function') {
      targetEl.dispatchEvent(upEv);
    }

    if (opts.delay && opts.delay > 0) {
      await new Promise(r => setTimeout(r, opts.delay));
    }
  }

  // change event
  const changeEv = createEvent('change');
  if (typeof targetEl.dispatchEvent === 'function') {
    targetEl.dispatchEvent(changeEv);
  }

  if (opts.blurAfter && typeof targetEl.blur === 'function') {
    try {
      targetEl.blur();
    } catch (_) {}
  }

  return {
    success: true,
    action: 'type',
    target: {
      tagName: targetEl.tagName,
      id: targetEl.id || null
    },
    textTyped: textToType,
    value: targetEl.value ?? targetEl.textContent ?? textToType
  };
}

/**
 * Executes secret fill from the local extension vault.
 * Cleartext secret values NEVER leave the browser and are never present in planner payloads.
 *
 * @param {object} params - { target, target_element_id, secret_key, ... }
 * @returns {Promise<object>} Execution result
 */
export async function executeFillSecret(params = {}) {
  const secretKey = params.secret_key || params.secret_alias || params.secretKey;
  if (!secretKey) {
    throw new Error('fill_secret action requires a secret_key alias');
  }

  const secretValue = await getLocalSecret(secretKey);
  if (secretValue === null || secretValue === undefined) {
    throw new Error(`Vault Error: Secret "${secretKey}" not found in local credential vault`);
  }

  const targetEl = resolveTarget(params);
  if (!targetEl) {
    throw new Error(`Target element not found for fill_secret: ${JSON.stringify(params)}`);
  }

  // Authorize fill for this internal secret execution
  const fillResult = await executeType(targetEl, secretValue, {
    ...params,
    allowSensitive: true,
    force: true
  });

  return {
    success: true,
    action: 'fill_secret',
    target: fillResult.target,
    secret_key: secretKey,
    // Do NOT return the raw secret in the return value to prevent accidental logging/leakage
    filled: true
  };
}

/**
 * Executes browser navigation to a validated destination URL.
 * Strictly verifies the URL using the centralized validator.
 * Invokes chrome.tabs.update if extension API is available,
 * or window.location / globalThis.location in browser DOM contexts.
 *
 * @param {Object} params - Navigation parameters ({ url, target_url, tabId, ... })
 * @returns {Promise<Object>} Execution result
 */
export async function executeNavigate(params = {}) {
  const rawUrl = params.url || params.target_url;
  const urlValidation = validateNavigationUrl(rawUrl);
  if (!urlValidation.valid) {
    throw new Error(`Navigation rejected: ${urlValidation.error}`);
  }

  const validUrl = urlValidation.url;
  let navigated = false;

  // 1. Chrome extension tabs API
  if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.update === 'function') {
    const tabId = params.tabId ?? params.tab_id;
    if (tabId != null) {
      await chrome.tabs.update(tabId, { url: validUrl });
    } else {
      await chrome.tabs.update({ url: validUrl });
    }
    navigated = true;
  } else if (typeof window !== 'undefined' && window.location) {
    // 2. DOM / Window location
    if (typeof window.location.assign === 'function') {
      window.location.assign(validUrl);
    } else {
      window.location.href = validUrl;
    }
    navigated = true;
  } else if (typeof globalThis !== 'undefined' && globalThis.location) {
    if (typeof globalThis.location.assign === 'function') {
      globalThis.location.assign(validUrl);
    } else {
      globalThis.location.href = validUrl;
    }
    navigated = true;
  }

  return {
    success: true,
    action: 'navigate',
    url: validUrl,
    navigated
  };
}

/**
 * Dispatches an action object to the appropriate executor.
 * Validates action before execution, classifies risk, and enforces confirmation gate.
 *
 * @param {Object} action - Action definition (type: 'click'|'scroll'|'type'|'fill_secret'|'navigate'|'wait', params...)
 * @param {Object} [options={}] - Options including onConfirmAction callback, context, etc.
 * @returns {Promise<Object>} Execution result
 */
export async function executeAction(action, options = {}) {
  if (!action) {
    throw new Error('No action provided');
  }

  const actionData = (action.action && typeof action.action === 'object')
    ? { ...action.action, ...action }
    : action;

  // Strict schema validation check
  const valResult = validateAction(actionData);
  if (!valResult.valid) {
    throw new Error(`Action schema validation failed: ${valResult.error}`);
  }

  // Ticket 07 / C7: Action-risk policy classification & confirmation gate
  const policyContext = options.context || { task: options.task || actionData.task, ui_elements: options.ui_elements || options.uiElements };
  classifyActionRisk(actionData, policyContext);
  await enforceConfirmationGate(actionData, options);

  if (action !== actionData && typeof action === 'object') {
    try {
      action.risk = actionData.risk;
      action.requires_confirmation = actionData.requires_confirmation;
      if (actionData.confirmed) action.confirmed = true;
    } catch (_) {}
  }

  const rawType = actionData.type || actionData.action || action.type;
  const type = String(rawType).toLowerCase();

  switch (type) {
    case 'click':
      return await executeClick(actionData);
    case 'scroll':
      return await executeScroll(actionData);
    case 'type':
    case 'input':
      return await executeType(actionData);
    case 'fill_secret':
      return await executeFillSecret(actionData);
    case 'navigate':
      return await executeNavigate(actionData);
    case 'wait':
      const ms = Number(actionData.delay_ms || actionData.ms || 500);
      await new Promise(r => setTimeout(r, ms));
      return { success: true, action: 'wait', duration: ms };
    case 'done':
      return { success: true, action: 'done', reason: actionData.reason || '' };
    default:
      throw new Error(`Unsupported action type: "${type}"`);
  }
}

/**
 * Executes a single action or a list of actions sequentially.
 * Enforces max actions per response cap (default: 10).
 * Passes options (including onConfirmAction) to executeAction.
 *
 * @param {Object|Array<Object>} actions - Action or array of actions
 * @param {object} [options={}] - Options { maxActions: 10, onConfirmAction, ... }
 * @returns {Promise<Object>} Execution result(s)
 */
export async function executeActions(actions, options = {}) {
  if (!actions) {
    throw new Error('No actions provided');
  }

  const list = Array.isArray(actions) ? actions : [actions];
  if (list.length === 0) {
    return { success: true, results: [] };
  }

  const maxActions = options.maxActions ?? 10;
  if (list.length > maxActions) {
    throw new Error(`Exceeded max actions per response cap: ${list.length} > ${maxActions}`);
  }

  const results = [];
  for (const act of list) {
    const res = await executeAction(act, options);
    results.push(res);
  }

  return results.length === 1 ? results[0] : { success: true, results };
}

export {
  classifyActionRisk,
  enforceConfirmationGate,
  ConfirmationRequired,
  ConfirmationDeclined,
  ConfirmationRequiredError,
  ConfirmationDeclinedError,
  RISK_TIERS,
  HIGH_RISK_PATTERNS,
  executeWithRiskGate
};

