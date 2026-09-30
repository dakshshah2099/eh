/**
 * Secret Vault module for Privacy Lens Agent.
 * Stores and manages credential secrets locally via chrome.storage.local only.
 * Raw secret values never leave the browser.
 */

export const SECRET_PREFIX = 'secret_';
export const STORAGE_KEY_SECRETS = 'secrets';
export const STORAGE_KEY_ALIASES = 'secret_aliases';

/**
 * Stores a credential secret in the local vault (chrome.storage.local).
 * Never sends data over network.
 * @param {string} alias - Alias key (e.g., 'ACCOUNT_PASSWORD', 'MY_SECRET')
 * @param {string} value - Cleartext secret value
 * @returns {Promise<{ success: boolean, alias?: string, error?: string }>}
 */
export async function saveSecretToVault(alias, value) {
  const cleanAlias = String(alias || '').trim();
  const cleanValue = String(value || '');

  if (!cleanAlias) {
    return { success: false, error: 'Alias name is required' };
  }
  if (!cleanValue) {
    return { success: false, error: 'Secret value is required' };
  }

  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { success: false, error: 'chrome.storage.local is not available' };
  }

  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([STORAGE_KEY_SECRETS, STORAGE_KEY_ALIASES], (data) => {
        if (chrome.runtime?.lastError) {
          return resolve({ success: false, error: chrome.runtime.lastError.message });
        }

        const secrets = Object.assign({}, data && data[STORAGE_KEY_SECRETS]);
        secrets[cleanAlias] = cleanValue;

        const existingAliases = Array.isArray(data?.[STORAGE_KEY_ALIASES])
          ? data[STORAGE_KEY_ALIASES]
          : Object.keys(secrets);
        const aliases = Array.from(new Set([...existingAliases, cleanAlias]));

        const payload = {
          [STORAGE_KEY_SECRETS]: secrets,
          [STORAGE_KEY_ALIASES]: aliases,
          [cleanAlias]: cleanValue,
          [`${SECRET_PREFIX}${cleanAlias}`]: cleanValue
        };

        chrome.storage.local.set(payload, () => {
          if (chrome.runtime?.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve({ success: true, alias: cleanAlias });
          }
        });
      });
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

/**
 * Deletes a credential secret from local storage.
 * @param {string} alias - Alias key to delete
 * @returns {Promise<{ success: boolean, alias?: string, error?: string }>}
 */
export async function deleteSecretFromVault(alias) {
  const cleanAlias = String(alias || '').trim();
  if (!cleanAlias) {
    return { success: false, error: 'Alias name is required' };
  }

  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { success: false, error: 'chrome.storage.local is not available' };
  }

  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([STORAGE_KEY_SECRETS, STORAGE_KEY_ALIASES], (data) => {
        if (chrome.runtime?.lastError) {
          return resolve({ success: false, error: chrome.runtime.lastError.message });
        }

        const secrets = Object.assign({}, data && data[STORAGE_KEY_SECRETS]);
        delete secrets[cleanAlias];

        const existingAliases = Array.isArray(data?.[STORAGE_KEY_ALIASES])
          ? data[STORAGE_KEY_ALIASES]
          : Object.keys(secrets);
        const aliases = existingAliases.filter((a) => a !== cleanAlias);

        chrome.storage.local.set({
          [STORAGE_KEY_SECRETS]: secrets,
          [STORAGE_KEY_ALIASES]: aliases
        }, () => {
          if (chrome.storage.local.remove) {
            chrome.storage.local.remove([cleanAlias, `${SECRET_PREFIX}${cleanAlias}`], () => {
              if (chrome.runtime?.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
              } else {
                resolve({ success: true, alias: cleanAlias });
              }
            });
          } else {
            resolve({ success: true, alias: cleanAlias });
          }
        });
      });
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

/**
 * Retrieves the list of provisioned secret alias names (never returning values).
 * @returns {Promise<string[]>}
 */
export async function listSecretAliases() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return [];
  }

  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([STORAGE_KEY_SECRETS, STORAGE_KEY_ALIASES], (data) => {
        if (chrome.runtime?.lastError) {
          return resolve([]);
        }
        if (Array.isArray(data?.[STORAGE_KEY_ALIASES])) {
          return resolve([...data[STORAGE_KEY_ALIASES]].sort());
        }
        if (data?.[STORAGE_KEY_SECRETS]) {
          return resolve(Object.keys(data[STORAGE_KEY_SECRETS]).sort());
        }
        resolve([]);
      });
    } catch (_) {
      resolve([]);
    }
  });
}

/**
 * Retrieves cleartext secret value for a given alias from chrome.storage.local.
 * @param {string} alias
 * @returns {Promise<string|null>}
 */
export async function getSecretValue(alias) {
  const cleanAlias = String(alias || '').trim();
  if (!cleanAlias || typeof chrome === 'undefined' || !chrome.storage?.local) {
    return null;
  }

  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([cleanAlias, `${SECRET_PREFIX}${cleanAlias}`, STORAGE_KEY_SECRETS], (data) => {
        if (chrome.runtime?.lastError || !data) {
          return resolve(null);
        }
        if (data[cleanAlias] != null) return resolve(String(data[cleanAlias]));
        if (data[`${SECRET_PREFIX}${cleanAlias}`] != null) return resolve(String(data[`${SECRET_PREFIX}${cleanAlias}`]));
        if (data[STORAGE_KEY_SECRETS] && data[STORAGE_KEY_SECRETS][cleanAlias] != null) {
          return resolve(String(data[STORAGE_KEY_SECRETS][cleanAlias]));
        }
        resolve(null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * Clears all secrets stored in chrome.storage.local.
 * @returns {Promise<{ success: boolean }>}
 */
export async function clearSecretVault() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { success: true };
  }

  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([STORAGE_KEY_ALIASES], (data) => {
        const keysToRemove = [STORAGE_KEY_SECRETS, STORAGE_KEY_ALIASES];
        if (data && Array.isArray(data[STORAGE_KEY_ALIASES])) {
          for (const a of data[STORAGE_KEY_ALIASES]) {
            keysToRemove.push(a, `${SECRET_PREFIX}${a}`);
          }
        }
        if (chrome.storage.local.remove) {
          chrome.storage.local.remove(keysToRemove, () => resolve({ success: true }));
        } else {
          resolve({ success: true });
        }
      });
    } catch (_) {
      resolve({ success: true });
    }
  });
}
