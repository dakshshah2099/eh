# Redaction Evaluation Report (Ticket 19)

**Execution Date:** 2026-09-28T04:18:39.389Z  
**Evaluation Duration:** 2012ms  
**Target Environment:** Demo Test Harness (`http://127.0.0.1:60107/index.html`)  
**Browser Engine:** Google Chrome via Playwright (Headless MV3 Runner)

---

## 1. Executive Summary & Accuracy Metrics

| Metric | Target | Evaluated Result | Status |
| :--- | :--- | :--- | :--- |
| **Raw PII Leakage Rate** | **0.00%** | **0%** | **PASS** ✅ |
| **Precision** | **100.00%** | **100.00%** | **PASS** ✅ |
| **Recall** | **100.00%** | **100.00%** | **PASS** ✅ |
| **F1-Score** | **100.00%** | **100.00%** | **PASS** ✅ |
| **True Positives (TP)** | 12 | **12 / 12** | **PASS** ✅ |
| **False Negatives (FN)** | 0 | **0** | **PASS** ✅ |
| **False Positives (FP)** | 0 | **0** | **PASS** ✅ |

---

## 2. Seeded PII Entity Redaction Verification

The 12 seeded PII entities from `window.__PII_MANIFEST__.entities` were evaluated against the intercepted server payload:

| DOM Selector | Category | Seeded Ground Truth | Detected | Canvas Redacted | DOM Redacted | Method | Audit Status |
| :--- | :--- | :--- | :---: | :---: | :---: | :--- | :---: |
| `#userEmail` | email | `jane.doe.personal@confidential-mail.org` | ✓ | ✓ | ✅ REDACTED | `gaussian_blur_or_pixelation` | **PASS** |
| `#userPassword` | password | `P@ssw0rd!#Secret99` | ✓ | ✓ | ✅ REDACTED | `solid_black_mask` | **PASS** |
| `#backupPin` | password | `839201` | ✓ | ✓ | ✅ REDACTED | `solid_black_mask` | **PASS** |
| `#fullName` | name | `Jane Alice Doe` | ✓ | ✓ | ✅ REDACTED | `gaussian_blur_or_pixelation` | **PASS** |
| `#phoneNumber` | phone | `+1 (555) 234-5678` | ✓ | ✓ | ✅ REDACTED | `solid_black_mask` | **PASS** |
| `#ssnInput` | ssn | `987-65-4321` | ✓ | ✓ | ✅ REDACTED | `redaction_mapped` | **PASS** |
| `#creditCardNumber` | credit_card | `4532 0150 9823 8812` | ✓ | ✓ | ✅ REDACTED | `redaction_mapped` | **PASS** |
| `#cardCvv` | credit_card | `842` | ✓ | ✓ | ✅ REDACTED | `gaussian_blur_or_pixelation` | **PASS** |
| `#bankAccount` | financial | `00987123456` | ✓ | ✓ | ✅ REDACTED | `redaction_mapped` | **PASS** |
| `#routingNumber` | financial | `121000358` | ✓ | ✓ | ✅ REDACTED | `redaction_mapped` | **PASS** |
| `#streetAddress` | address | `742 Evergreen Terrace` | ✓ | ✓ | ✅ REDACTED | `redaction_mapped` | **PASS** |
| `#avatarContainer` | face | `[VISUAL_BIOMETRIC]` | ✓ | ✓ | ✅ REDACTED | `solid_black_mask` | **PASS** |

---

## 3. Seeded Raw Token Leakage Verification

All 13 raw tokens from `window.__PII_MANIFEST__.rawTokens` were programmatically verified against the intercepted `PlanRequest.dom_skeleton` JSON:

| Raw PII String Token | Transmission Leak Check | Status |
| :--- | :--- | :---: |
| `jane.doe.personal@confidential-mail.org` | ✅ 0% LEAKAGE | **REDACTED** |
| `P@ssw0rd!#Secret99` | ✅ 0% LEAKAGE | **REDACTED** |
| `839201` | ✅ 0% LEAKAGE | **REDACTED** |
| `Jane Alice Doe` | ✅ 0% LEAKAGE | **REDACTED** |
| `+1 (555) 234-5678` | ✅ 0% LEAKAGE | **REDACTED** |
| `987-65-4321` | ✅ 0% LEAKAGE | **REDACTED** |
| `4532 0150 9823 8812` | ✅ 0% LEAKAGE | **REDACTED** |
| `842` | ✅ 0% LEAKAGE | **REDACTED** |
| `00987123456` | ✅ 0% LEAKAGE | **REDACTED** |
| `121000358` | ✅ 0% LEAKAGE | **REDACTED** |
| `742 Evergreen Terrace` | ✅ 0% LEAKAGE | **REDACTED** |
| `Springfield` | ✅ 0% LEAKAGE | **REDACTED** |
| `97477` | ✅ 0% LEAKAGE | **REDACTED** |

---

## 4. Visual Image & Canvas Pixel Inspection

- **Canvas Dimensions:** 768x480
- **Solid Black Fill Masks Applied:** 2 regions
- **Blur / Pixelation Filters Applied:** 1 regions
- **Biometric Face Masking:** Vector / canvas face portrait at `#avatarContainer` obscured with zero facial Proposals leaked.
- **Visual Leakage Asserted:** **0%** raw visual biometric leakage.

---

## 5. Non-Sensitive UI Preservation (False Positive Audit)

Non-sensitive elements (interactive buttons, header titles, badge indicators) verified preserved without redaction tokens:
- `h1.header-title`: Intact ✅
- `button#btnResetData`: Intact ✅
- `button#btnAuditProfile`: Intact ✅
- `button#btnSubmitTelemetry`: Intact ✅
- `span.badge`: Intact ✅

**Conclusion:** 0 False Positives confirmed. Full non-sensitive DOM functionality retained.
