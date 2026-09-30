# 12 — C12: Debug image persistence off by default; no task text in filenames

**What to build:** `main.py`'s `save_debug_image` embeds up to 20 characters of task text in the saved filename (e.g. `Buy_a_wireless_mouse_step_1.jpg`). The `debug_redacted_images/` directory already contains 6 such files from a live run. Two risks: (1) the default `DEBUG_SAVE_REDACTED` evaluation against `"0"` means the feature activates if the env var is set to any non-zero value by mistake; (2) task text in filenames can leak business context / user intent even if the image itself is redacted. Ensure `DEBUG_SAVE_REDACTED` defaults to `"0"` (it already does per the code, but `.env.example` should be audited), and replace the task-text fragment in the filename with a timestamp + nonce so no user-intent data is encoded in the path.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] `.env.example` explicitly shows `DEBUG_SAVE_REDACTED=0` with a comment warning of privacy risk.
- [x] `save_debug_image` filenames use a timestamp and random suffix (e.g. `debug_<unix_ms>_<6hex>.jpg`), not task text.
- [x] A unit test confirms that with `DEBUG_SAVE_REDACTED` unset (or `"0"`), `save_debug_image` returns `None` without creating any file.
- [x] A unit test confirms that with `DEBUG_SAVE_REDACTED=1`, the saved filename contains no substring of the task string.
- [x] Existing `debug_redacted_images/` files should be added to `.gitignore` if not already.
