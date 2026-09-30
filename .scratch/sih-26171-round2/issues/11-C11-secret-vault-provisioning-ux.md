# 11 — C11: Secret-vault provisioning UX in popup

**What to build:** `setLocalSecret` and `getLocalSecret` are implemented in `action_executor.js` and usable by `fill_secret` actions. However, there is no popup UI that lets a user provision a secret alias (e.g. `ACCOUNT_PASSWORD`) into the local vault before running a task. Without this, any task that requires `fill_secret` fails at runtime because the vault is empty. Add a Settings → Secrets flow in the extension popup: list existing aliases (names only, never values), add/delete an alias+value, store via `chrome.storage.local` only. The raw value must never leave the browser — no network request carrying it, not even to the local FastAPI server.

**Blocked by:** None — can start immediately (standalone popup UI work).

**Status:** ready-for-agent

- [ ] The popup has a "Secrets" section (under Settings or equivalent) showing a list of provisioned alias names.
- [ ] The user can enter an alias name and a secret value, hit Save, and the pair is stored via `chrome.storage.local`.
- [ ] The user can delete an alias by name.
- [ ] Secret values are never displayed in plaintext after initial entry.
- [ ] A manual/UI test (or automated puppeteer/Playwright test against the extension) confirms: after provisioning `MY_SECRET`, a `chrome.storage.local.get` call from the background returns the value, and zero network requests to `localhost` or any external host contain the secret value.
- [ ] The server-side `PlanRequest` and all transport payloads contain no secret values.
