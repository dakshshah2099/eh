# Privacy Lens Evaluation Suites

This directory contains automated headless evaluation suites for validating redaction recall, precision, and zero-leakage security across arbitrary real-world web pages and interactive demo environments.

---

## 1. Per-Class Recall Evaluation Harness (Ticket 03)

An evaluation harness that headlessly drives the perception and redaction pipeline across real-world web pages (not just demo fixtures) to measure **Recall** and **Precision** per sensitive-element class:
- **`face`**: Biometric faces, avatar portraits, headshots
- **`password`**: Password fields, PINs, master credentials
- **`email`**: Email inputs, mailto links, contact email text
- **`text_pii`**: Free-text personal names, legal identities, author names

### Quick Start

Run the entire 12-page evaluation corpus in a single command:

```bash
# From repository root:
npm run eval

# Or from the eval directory:
cd eval
npm run eval
```

### Configurable Recall Threshold
Per problem statement guidance, **recall** is the primary metric (missed detections penalize security score). The runner automatically exits with **exit code 0** on pass, or **exit code 1** if overall recall falls below the threshold:

```bash
# Run with a custom recall threshold (e.g. 90%):
node eval/run_eval.js --threshold 0.90
```

### Live URLs vs. Fallback Snapshots
The evaluation corpus under `eval/corpus/` includes both realistic live URLs and local saved snapshots:
- By default, `npm run eval` executes against the saved HTML snapshots so evaluation is **100% network-independent, fast, and offline-safe** during judging and finals.
- To test live URLs:
  ```bash
  npm run eval:live
  # Or:
  node eval/run_eval.js --live
  ```
  If any live URL is unreachable or times out, the runner automatically falls back to the saved snapshot with clear logging.

---

## 2. Finale Judge Evaluation Guide

Judges can execute this harness independently on **brand new page sets** revealed at the finale:

### Step 1: Create a Custom Manifest File
Create a JSON manifest (e.g. `eval/corpus/finale_manifest.json`):
```json
{
  "version": "1.0.0",
  "name": "Finale Test Suite",
  "pages": [
    {
      "id": "judge-page-01",
      "name": "Live Target Portal",
      "liveUrl": "https://example.com/target",
      "snapshot": "snapshots/judge-page-01.html",
      "annotations": "annotations/judge-page-01.json",
      "classes": ["face", "password", "email", "text_pii"]
    }
  ]
}
```

### Step 2: Create Companion Ground Truth Annotations
In `eval/corpus/annotations/judge-page-01.json`:
```json
{
  "pageId": "judge-page-01",
  "title": "Live Target Portal",
  "classes": ["face", "password", "email", "text_pii"],
  "annotations": [
    {
      "id": "judge-password-1",
      "type": "password",
      "selector": "input[type='password']",
      "description": "Login password field"
    },
    {
      "id": "judge-email-1",
      "type": "email",
      "selector": "input[type='email']",
      "description": "User email input"
    },
    {
      "id": "judge-face-1",
      "type": "face",
      "selector": ".user-avatar",
      "description": "User portrait headshot"
    },
    {
      "id": "judge-name-1",
      "type": "text_pii",
      "selector": "h1.profile-name",
      "description": "User full name"
    }
  ],
  "negativeSelectors": ["button#submit"]
}
```

### Step 3: Run the Harness Against the Finale Manifest
```bash
node eval/run_eval.js --manifest eval/corpus/finale_manifest.json --threshold 0.85
```

### CLI Options Reference

| Option | Default | Description |
| :--- | :--- | :--- |
| `--threshold <float>` | `0.85` | Minimum overall recall required to exit code 0 |
| `--manifest <path>` | `eval/corpus/manifest.json` | Path to page manifest JSON |
| `--live` | `false` | Attempt live URLs with automatic fallback to snapshots |
| `--page <pageId>` | `null` | Filter evaluation to a single page ID |
| `--output-json <path>` | `eval/corpus_eval_report.json` | Path to machine-readable JSON output |
| `--output-md <path>` | `eval/corpus_eval_summary.md` | Path to human-readable Markdown output |
| `--verbose` | `false` | Detailed per-step execution logs |
| `--no-headless` | `false` | Launch visible browser window for visual inspection |

---

## 3. Demo Test Harness Evaluation Suite (Ticket 19)

Runs full end-to-end evaluation against the seeded interactive demo harness (`demo/index.html`), testing DOM redaction, pixel-level canvas obscuration, and network interception:

```bash
# Run demo eval suite:
npm run eval:demo
# Or:
node eval/run_redaction_eval.js
```

---

## 4. Reports & Metrics Output

Every evaluation run automatically produces:
1. **Machine-readable JSON report** (`eval/corpus_eval_report.json` and `eval/eval_report.json`): Detailed counts of ground truth entities, true positives, false negatives, false positives, per-class metrics, and per-page results.
2. **Human-readable Markdown summary** (`eval/corpus_eval_summary.md` and `eval/eval_summary.md`): Formatted tables for executive review and continuous integration badges.
