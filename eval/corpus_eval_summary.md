# Per-Class Recall Evaluation Report (Ticket 03)

**Execution Date:** 2026-09-30T15:30:50.864Z  
**Total Runtime:** 2875ms  
**Corpus Pages Evaluated:** 12  
**Target Recall Threshold:** 85.0%  
**Overall Verdict:** **PASSED ✅**

---

## 1. Per-Class Recall & Precision Breakdown

| Sensitive Class | Ground Truth | True Positives (TP) | False Negatives (FN) | False Positives (FP) | Recall | Precision | F1-Score | Status |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **FACE** | 7 | 7 | 0 | 0 | **100.00%** | 100.00% | 100.00% | ✅ PASS |
| **PASSWORD** | 8 | 8 | 0 | 1 | **100.00%** | 88.89% | 94.12% | ✅ PASS |
| **EMAIL** | 13 | 13 | 0 | 0 | **100.00%** | 100.00% | 100.00% | ✅ PASS |
| **TEXT_PII** | 10 | 10 | 0 | 5 | **100.00%** | 66.67% | 80.00% | ✅ PASS |
| **OVERALL TOTAL** | **38** | **38** | **0** | **6** | **100.00%** | **86.36%** | **92.68%** | **✅ PASS** |

---

## 2. Per-Page Evaluation Results

| Page ID | Scenario Description | GT Items | TP | FN | Recall | Precision | Status |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `01-saas-login` | CloudSaaS Workspace Login | 2 | 2 | 0 | 100.0% | 66.7% | ✅ 100% |
| `02-user-profile` | User Profile & Security Settings | 4 | 4 | 0 | 100.0% | 66.7% | ✅ 100% |
| `03-team-directory` | Clinical Research Staff Directory | 6 | 6 | 0 | 100.0% | 85.7% | ✅ 100% |
| `04-ecommerce-checkout` | Express Checkout & Account Creation | 3 | 3 | 0 | 100.0% | 100.0% | ✅ 100% |
| `05-social-author-bio` | Contributing Author Profile - TechJournal | 3 | 3 | 0 | 100.0% | 100.0% | ✅ 100% |
| `06-password-reset` | Reset Security Credentials - FinTech Vault | 3 | 3 | 0 | 100.0% | 75.0% | ✅ 100% |
| `07-employee-badge` | Enterprise Security Access Badge | 3 | 3 | 0 | 100.0% | 75.0% | ✅ 100% |
| `08-contact-support` | Customer Technical Support Request | 2 | 2 | 0 | 100.0% | 100.0% | ✅ 100% |
| `09-account-security` | Account Security & Credential Vault | 3 | 3 | 0 | 100.0% | 100.0% | ✅ 100% |
| `10-community-forum` | Developer Community Member Profile | 3 | 3 | 0 | 100.0% | 100.0% | ✅ 100% |
| `11-executive-board` | Executive Leadership - Holdings Corp | 3 | 3 | 0 | 100.0% | 100.0% | ✅ 100% |
| `12-banking-registration` | Online Banking Account Registration | 3 | 3 | 0 | 100.0% | 100.0% | ✅ 100% |

---

## 3. Judge & Finale Execution Guide

Judges can execute this harness independently on any new page set revealed at the finale:

```bash
# 1. Run the default 12-page evaluation corpus:
npm run eval

# 2. Run with custom recall threshold (e.g. 0.90):
node eval/run_eval.js --threshold 0.90

# 3. Run against an independent custom finale manifest:
node eval/run_eval.js --manifest path/to/finale_manifest.json

# 4. Attempt live URLs first with automatic fallback to snapshots:
node eval/run_eval.js --live
```
