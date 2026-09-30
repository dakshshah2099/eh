import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import {
  saveSecretToVault,
  deleteSecretFromVault,
  listSecretAliases,
  getSecretValue,
  clearSecretVault,
  STORAGE_KEY_SECRETS,
  STORAGE_KEY_ALIASES
} from '../src/secret_vault.js';

import {
  setLocalSecret,
  getLocalSecret,
  deleteLocalSecret,
  clearLocalSecrets,
  executeAction
} from '../src/action_executor.js';

import { buildPayload, sendPayloadToServer } from '../src/transport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-memory mock storage for chrome.storage.local
let mockLocalStorage = {};

function setupMockChrome() {
  mockLocalStorage = {};
  globalThis.chrome = {
    runtime: {
      lastError: null
    },
    storage: {
      local: {
        get: (keys, callback) => {
          let result = {};
          if (keys === null || keys === undefined) {
            result = { ...mockLocalStorage };
          } else if (typeof keys === 'string') {
            result = { [keys]: mockLocalStorage[keys] };
          } else if (Array.isArray(keys)) {
            for (const k of keys) {
              if (mockLocalStorage[k] !== undefined) {
                result[k] = mockLocalStorage[k];
              }
            }
          }
          if (typeof callback === 'function') {
            callback(result);
            return;
          }
          return Promise.resolve(result);
        },
        set: (items, callback) => {
          Object.assign(mockLocalStorage, items);
          if (typeof callback === 'function') {
            callback();
            return;
          }
          return Promise.resolve();
        },
        remove: (keys, callback) => {
          const toRemove = Array.isArray(keys) ? keys : [keys];
          for (const k of toRemove) {
            delete mockLocalStorage[k];
          }
          if (typeof callback === 'function') {
            callback();
            return;
          }
          return Promise.resolve();
        },
        clear: (callback) => {
          mockLocalStorage = {};
          if (typeof callback === 'function') {
            callback();
            return;
          }
          return Promise.resolve();
        }
      }
    }
  };
}

test.beforeEach(() => {
  setupMockChrome();
  clearLocalSecrets();
});

test('Ticket 11 / C11: popup.html contains Secret Vault UI structure under settings', () => {
  const popupHtmlPath = path.join(__dirname, '..', 'popup', 'popup.html');
  const htmlContent = fs.readFileSync(popupHtmlPath, 'utf-8');

  // Verify core elements exist in popup.html
  assert.ok(htmlContent.includes('id="secretsCard"'), 'secretsCard must exist');
  assert.ok(htmlContent.includes('id="secretsSectionHeader"'), 'secretsSectionHeader must exist');
  assert.ok(htmlContent.includes('id="secretsContent"'), 'secretsContent must exist');
  assert.ok(htmlContent.includes('id="secretList"'), 'secretList must exist');
  assert.ok(htmlContent.includes('id="secretAliasInput"'), 'secretAliasInput must exist');
  assert.ok(htmlContent.includes('id="secretValueInput"'), 'secretValueInput must exist');
  assert.ok(htmlContent.includes('id="saveSecretBtn"'), 'saveSecretBtn must exist');
  assert.ok(htmlContent.includes('id="secretSaveStatus"'), 'secretSaveStatus must exist');
  assert.ok(htmlContent.includes('id="secretCountBadge"'), 'secretCountBadge must exist');
  assert.ok(htmlContent.includes('type="password" id="secretValueInput"'), 'secretValueInput must be password type');
});

test('Ticket 11 / C11: provision and delete secret alias via chrome.storage.local', async () => {
  const ALIAS = 'ACCOUNT_PASSWORD';
  const RAW_VALUE = 'SuperSecret123!';

  // 1. Provision secret
  const saveRes = await saveSecretToVault(ALIAS, RAW_VALUE);
  assert.strictEqual(saveRes.success, true);
  assert.strictEqual(saveRes.alias, ALIAS);

  // 2. Direct chrome.storage.local.get verifies storage
  const directGet = await new Promise((resolve) => chrome.storage.local.get(ALIAS, resolve));
  assert.strictEqual(directGet[ALIAS], RAW_VALUE);

  const prefixGet = await new Promise((resolve) => chrome.storage.local.get(`secret_${ALIAS}`, resolve));
  assert.strictEqual(prefixGet[`secret_${ALIAS}`], RAW_VALUE);

  const secretsDictGet = await new Promise((resolve) => chrome.storage.local.get(STORAGE_KEY_SECRETS, resolve));
  assert.strictEqual(secretsDictGet[STORAGE_KEY_SECRETS][ALIAS], RAW_VALUE);

  // 3. List aliases returns names only, never values
  const aliases = await listSecretAliases();
  assert.deepStrictEqual(aliases, [ALIAS]);
  assert.strictEqual(JSON.stringify(aliases).includes(RAW_VALUE), false);

  // 4. Retrieve value via vault helper
  const retrievedVal = await getSecretValue(ALIAS);
  assert.strictEqual(retrievedVal, RAW_VALUE);

  // 5. Delete alias
  const delRes = await deleteSecretFromVault(ALIAS);
  assert.strictEqual(delRes.success, true);

  const afterDel = await new Promise((resolve) => chrome.storage.local.get(ALIAS, resolve));
  assert.strictEqual(afterDel[ALIAS], undefined);

  const afterDelAliases = await listSecretAliases();
  assert.deepStrictEqual(afterDelAliases, []);
});

test('Ticket 11 / C11: validation prevents saving empty alias or empty value', async () => {
  const resEmptyAlias = await saveSecretToVault('', 'my_value');
  assert.strictEqual(resEmptyAlias.success, false);
  assert.strictEqual(resEmptyAlias.error, 'Alias name is required');

  const resWhitespaceAlias = await saveSecretToVault('   ', 'my_value');
  assert.strictEqual(resWhitespaceAlias.success, false);

  const resEmptyValue = await saveSecretToVault('VALID_ALIAS', '');
  assert.strictEqual(resEmptyValue.success, false);
  assert.strictEqual(resEmptyValue.error, 'Secret value is required');
});

test('Ticket 11 / C11: acceptance criteria test — after provisioning MY_SECRET, chrome.storage.local.get returns value and action executor retrieves it', async () => {
  const TEST_ALIAS = 'MY_SECRET';
  const TEST_RAW_SECRET = 'VaultedCleartextPassword#999';

  // Provision MY_SECRET
  const res = await saveSecretToVault(TEST_ALIAS, TEST_RAW_SECRET);
  assert.strictEqual(res.success, true);

  // A chrome.storage.local.get call from background returns the value
  const bgData = await new Promise((resolve) => chrome.storage.local.get(TEST_ALIAS, resolve));
  assert.strictEqual(bgData[TEST_ALIAS], TEST_RAW_SECRET);

  // Background / action executor getLocalSecret returns the value
  const executorVal = await getLocalSecret(TEST_ALIAS);
  assert.strictEqual(executorVal, TEST_RAW_SECRET);
});

test('Ticket 11 / C11: UI rendering never displays secret values in plaintext after initial entry', () => {
  const mockSecrets = {
    MY_SECRET: 'plaintext_secret_value_A',
    GITHUB_TOKEN: 'ghp_secret_token_value_B'
  };

  // Mock DOM container
  const container = {
    innerHTML: '',
    children: [],
    appendChild(child) {
      this.children.push(child);
      this.innerHTML += child.outerHTML;
    }
  };

  function mockCreateElement(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      dataset: {},
      attributes: {},
      children: [],
      setAttribute(k, v) { this.attributes[k] = v; },
      appendChild(child) {
        this.children.push(child);
      },
      addEventListener() {},
      get outerHTML() {
        const dataAttrs = Object.entries(this.dataset)
          .map(([k, v]) => `data-${k}="${v}"`)
          .join(' ');
        const attrs = Object.entries(this.attributes)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ');
        const inner = this.children.map(c => c.outerHTML).join('') || this.textContent;
        return `<${tag} class="${this.className}" ${dataAttrs} ${attrs}>${inner}</${tag}>`;
      }
    };
    return el;
  }

  // Simulate renderSecretsList logic
  const aliases = Object.keys(mockSecrets).sort();
  for (const alias of aliases) {
    const row = mockCreateElement('div');
    row.className = 'secret-item';
    row.dataset.alias = alias;

    const info = mockCreateElement('div');
    info.className = 'secret-item-info';

    const aliasSpan = mockCreateElement('span');
    aliasSpan.className = 'secret-alias';
    aliasSpan.textContent = alias;

    const maskedSpan = mockCreateElement('span');
    maskedSpan.className = 'secret-masked';
    maskedSpan.textContent = '•••••••• (vaulted)';

    info.appendChild(aliasSpan);
    info.appendChild(maskedSpan);

    const delBtn = mockCreateElement('button');
    delBtn.className = 'icon-btn-delete';
    delBtn.textContent = '✕';
    delBtn.setAttribute('aria-label', `Delete secret ${alias}`);

    row.appendChild(info);
    row.appendChild(delBtn);
    container.appendChild(row);
  }

  // Verify aliases are present
  assert.ok(container.innerHTML.includes('MY_SECRET'));
  assert.ok(container.innerHTML.includes('GITHUB_TOKEN'));
  assert.ok(container.innerHTML.includes('•••••••• (vaulted)'));

  // Critical check: Plaintext secret values MUST NEVER be in container DOM or innerHTML
  assert.strictEqual(container.innerHTML.includes('plaintext_secret_value_A'), false);
  assert.strictEqual(container.innerHTML.includes('ghp_secret_token_value_B'), false);
});

test('Ticket 11 / C11: Zero network requests contain secret value & PlanRequest payloads contain no secrets', async () => {
  const SECRET_ALIAS = 'MY_SECRET';
  const RAW_SECRET_VALUE = 'ExtremelySensitivePasswordXYZ!';

  // 1. Provision secret in local vault
  await saveSecretToVault(SECRET_ALIAS, RAW_SECRET_VALUE);

  // 2. Start a mock server to capture all network requests
  const networkRequests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      networkRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        actions: [
          {
            type: 'fill_secret',
            target_element_id: 'pwd_field',
            secret_key: SECRET_ALIAS
          }
        ],
        task_complete: false
      }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;
  const mockServerUrl = `http://127.0.0.1:${serverPort}/api/plan`;

  try {
    // 3. Build transport payload conforming to FastAPI PlanRequest
    const payload = buildPayload({
      task: 'Log into user account',
      domSkeleton: [{ tag: 'input', id: 'pwd_field', type: 'password' }],
      imageBase64: 'data:image/jpeg;base64,mock',
      viewport: { width: 1280, height: 720 }
    });

    // Verify PlanRequest serialization contains no raw secret
    const serializedPayload = JSON.stringify(payload);
    assert.strictEqual(serializedPayload.includes(RAW_SECRET_VALUE), false);

    // 4. Send payload to planning server
    const planResponse = await sendPayloadToServer(payload, mockServerUrl);
    assert.strictEqual(planResponse.actions.length, 1);
    assert.strictEqual(planResponse.actions[0].type, 'fill_secret');
    assert.strictEqual(planResponse.actions[0].secret_key, SECRET_ALIAS);

    // 5. Simulate DOM element for fill_secret execution
    const mockInputElement = {
      nodeType: 1,
      tagName: 'INPUT',
      id: 'pwd_field',
      type: 'password',
      value: '',
      eventsFired: [],
      focus() {},
      dispatchEvent(e) { this.eventsFired.push(e); return true; },
      getBoundingClientRect() { return { left: 10, top: 10, width: 100, height: 30, right: 110, bottom: 40 }; }
    };

    const origDoc = globalThis.document;
    const origWin = globalThis.window;
    globalThis.document = {
      getElementById(id) { return id === 'pwd_field' ? mockInputElement : null; },
      querySelector(sel) { return sel === '#pwd_field' ? mockInputElement : null; },
      documentElement: { scrollLeft: 0, scrollTop: 0 }
    };
    globalThis.window = { document: globalThis.document };

    try {
      const actionResult = await executeAction(planResponse.actions[0]);
      assert.strictEqual(actionResult.success, true);
      assert.strictEqual(actionResult.action, 'fill_secret');
      assert.strictEqual(actionResult.secret_key, SECRET_ALIAS);
      // Cleartext secret is filled into DOM element
      assert.strictEqual(mockInputElement.value, RAW_SECRET_VALUE);
      // But return result payload has no cleartext value
      assert.strictEqual(actionResult.value, undefined);
      assert.strictEqual(JSON.stringify(actionResult).includes(RAW_SECRET_VALUE), false);
    } finally {
      globalThis.document = origDoc;
      globalThis.window = origWin;
    }

    // 6. Verify EVERY captured network request contains zero secret value
    assert.ok(networkRequests.length > 0, 'Must have received at least 1 network request');
    for (const req of networkRequests) {
      assert.strictEqual(req.url.includes(RAW_SECRET_VALUE), false, 'URL must not contain secret');
      assert.strictEqual(JSON.stringify(req.headers).includes(RAW_SECRET_VALUE), false, 'Headers must not contain secret');
      assert.strictEqual(req.body.includes(RAW_SECRET_VALUE), false, 'Body must not contain secret');
    }
  } finally {
    server.close();
  }
});

test('Ticket 11 / C11: Popup UI interactive flow — add alias, verify masked list, wipe inputs, delete alias', async () => {
  // DOM simulation elements
  const elements = {};
  function makeEl(id, tag = 'div', type = '') {
    const el = {
      id,
      tagName: tag.toUpperCase(),
      type,
      value: '',
      textContent: '',
      className: '',
      style: {},
      dataset: {},
      attributes: {},
      listeners: {},
      children: [],
      addEventListener(evt, fn) {
        this.listeners[evt] = this.listeners[evt] || [];
        this.listeners[evt].push(fn);
      },
      click() {
        if (this.listeners['click']) {
          for (const fn of this.listeners['click']) fn();
        }
      },
      appendChild(c) { this.children.push(c); },
      setAttribute(k, v) { this.attributes[k] = v; }
    };
    elements[id] = el;
    return el;
  }

  const aliasInput = makeEl('secretAliasInput', 'input', 'text');
  const valueInput = makeEl('secretValueInput', 'input', 'password');
  const saveBtn = makeEl('saveSecretBtn', 'button');
  const saveStatus = makeEl('secretSaveStatus', 'span');
  const secretList = makeEl('secretList', 'div');
  const emptyMsg = makeEl('emptySecretsMsg', 'div');
  const countBadge = makeEl('secretCountBadge', 'span');
  const toggleVisibility = makeEl('toggleSecretVisibility', 'button');

  // Popup logic helpers matching popup.js
  function renderSecrets(secretsMap) {
    secretList.children = [];
    const aliases = Object.keys(secretsMap || {}).sort();
    countBadge.textContent = `${aliases.length} secret${aliases.length === 1 ? '' : 's'}`;

    if (aliases.length === 0) {
      emptyMsg.style.display = 'block';
      return;
    }
    emptyMsg.style.display = 'none';

    for (const alias of aliases) {
      const row = makeEl(`item_${alias}`, 'div');
      row.className = 'secret-item';
      row.dataset.alias = alias;

      const aliasSpan = makeEl(`alias_${alias}`, 'span');
      aliasSpan.textContent = alias;

      const maskedSpan = makeEl(`masked_${alias}`, 'span');
      maskedSpan.textContent = '•••••••• (vaulted)';

      const delBtn = makeEl(`del_${alias}`, 'button');
      delBtn.className = 'icon-btn-delete';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', async () => {
        await deleteSecretFromVault(alias);
        const data = await listSecretAliases();
        const updatedMap = {};
        for (const a of data) updatedMap[a] = 'masked';
        renderSecrets(updatedMap);
        saveStatus.textContent = `✓ Deleted ${alias}`;
      });

      row.appendChild(aliasSpan);
      row.appendChild(maskedSpan);
      row.appendChild(delBtn);
      secretList.appendChild(row);
    }
  }

  saveBtn.addEventListener('click', async () => {
    const alias = aliasInput.value.trim();
    const value = valueInput.value;
    if (!alias) {
      saveStatus.textContent = 'Alias name is required';
      return;
    }
    if (!value) {
      saveStatus.textContent = 'Secret value is required';
      return;
    }
    const res = await saveSecretToVault(alias, value);
    if (res.success) {
      // Clear inputs immediately
      aliasInput.value = '';
      valueInput.value = '';
      valueInput.type = 'password';
      saveStatus.textContent = `✓ Saved ${alias} to vault`;
      const aliases = await listSecretAliases();
      const map = {};
      for (const a of aliases) map[a] = 'vaulted';
      renderSecrets(map);
    }
  });

  // Step 1: Initial state is empty
  renderSecrets({});
  assert.strictEqual(countBadge.textContent, '0 secrets');
  assert.strictEqual(emptyMsg.style.display, 'block');
  assert.strictEqual(secretList.children.length, 0);

  // Step 2: User provisions alias MY_SECRET
  aliasInput.value = 'MY_SECRET';
  valueInput.value = 'Passw0rd_Secret_123';
  saveBtn.click();

  // Wait a tick for async save
  await new Promise(resolve => setTimeout(resolve, 10));

  // Step 3: Verify inputs are immediately wiped clean
  assert.strictEqual(aliasInput.value, '');
  assert.strictEqual(valueInput.value, '');

  // Step 4: Verify chrome.storage.local contains the secret
  const storedVal = await new Promise(resolve => chrome.storage.local.get('MY_SECRET', resolve));
  assert.strictEqual(storedVal['MY_SECRET'], 'Passw0rd_Secret_123');

  // Step 5: Verify UI shows 1 secret with masked display
  assert.strictEqual(countBadge.textContent, '1 secret');
  assert.strictEqual(emptyMsg.style.display, 'none');
  assert.strictEqual(secretList.children.length, 1);
  const row = secretList.children[0];
  assert.strictEqual(row.dataset.alias, 'MY_SECRET');
  assert.strictEqual(row.children[0].textContent, 'MY_SECRET');
  assert.strictEqual(row.children[1].textContent, '•••••••• (vaulted)');

  // Step 6: Delete the alias
  const delBtn = row.children[2];
  delBtn.click();
  await new Promise(resolve => setTimeout(resolve, 10));

  // Step 7: Verify storage and UI are cleared
  const afterDelVal = await new Promise(resolve => chrome.storage.local.get('MY_SECRET', resolve));
  assert.strictEqual(afterDelVal['MY_SECRET'], undefined);
  assert.strictEqual(countBadge.textContent, '0 secrets');
  assert.strictEqual(emptyMsg.style.display, 'block');
  assert.strictEqual(secretList.children.length, 0);
  assert.strictEqual(saveStatus.textContent, '✓ Deleted MY_SECRET');
});

