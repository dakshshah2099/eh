# 02 - Screen Capture & Downscale

**What to build:** Implement chrome.tabs.captureVisibleTab in the background script. Send the raw screenshot to an offscreen document (or process it) to downscale it via an HTML Canvas element to <768px longest side to save latency.

**Blocked by:** 01 - Extension Scaffolding

**Status:** completed

- [x] Background script captures active tab
- [x] Image is successfully downscaled via Canvas
