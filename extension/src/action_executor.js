/**
 * Privacy Lens Agent - Action Executor
 *
 * Implements action execution (Click & Scroll) on DOM elements
 * based on target bounding box, CSS selector, or XPath.
 */

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

  // 1. Try CSS selector
  const selector = target.target_selector || target.selector || target.cssSelector;
  if (selector && typeof selector === 'string') {
    try {
      if (typeof doc.querySelector === 'function') {
        const el = doc.querySelector(selector);
        if (el) return el;
      }
    } catch (e) {
      console.warn('[ActionExecutor] querySelector failed for:', selector, e);
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
 * Dispatches an action object to the appropriate executor.
 *
 * @param {Object} action - Action definition (type: 'click'|'scroll'|'type', params...)
 * @returns {Promise<Object>} Execution result
 */
export async function executeAction(action) {
  if (!action) {
    throw new Error('No action provided');
  }

  const actionData = (action.action && typeof action.action === 'object')
    ? { ...action.action, ...action }
    : action;

  const rawType = actionData.type || actionData.action || action.type;
  if (!rawType) {
    throw new Error('Action type not specified');
  }

  const type = String(rawType).toLowerCase();

  switch (type) {
    case 'click':
      return await executeClick(actionData);
    case 'scroll':
      return await executeScroll(actionData);
    case 'type':
    case 'input':
      return await executeType(actionData);
    default:
      throw new Error(`Unsupported action type: "${type}"`);
  }
}

/**
 * Executes a single action or a list of actions sequentially.
 *
 * @param {Object|Array<Object>} actions - Action or array of actions
 * @returns {Promise<Object>} Execution result(s)
 */
export async function executeActions(actions) {
  if (!actions) {
    throw new Error('No actions provided');
  }

  const list = Array.isArray(actions) ? actions : [actions];
  if (list.length === 0) {
    return { success: true, results: [] };
  }

  const results = [];
  for (const act of list) {
    const res = await executeAction(act);
    results.push(res);
  }

  return results.length === 1 ? results[0] : { success: true, results };
}
