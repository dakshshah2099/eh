# 01 — B1: Real VLM Planner Backend

**What to build:** Dynamic multi-step visual and DOM browser planning in `server/main.py` powered by a real Vision-Language Model (VLM) via configurable Ollama local or OpenAI-compatible endpoint, replacing the hardcoded 2-step mock stub.

**Blocked by:** None — can start immediately

**Status:** completed

## Context & Details
- Target files: `server/main.py` (and helper modules in `server/`)
- Ingests incoming payload: `task`, `dom_skeleton`, `image_base64`, `ui_elements`, `viewport`, `redaction_map`.
- Configurable VLM backend (Ollama e.g. `llama3.2-vision` / `llava`, or OpenAI-compatible endpoint e.g. Qwen-VL / GPT-4o / LiteLLM).
- Generates structured browser action plans (`click`, `type`, `scroll`, `wait`, `navigate`) dynamically according to current page state and goal.

## Acceptance Criteria
- [x] Hardcoded step-1/step-2 mock actions removed from `POST /api/plan`.
- [x] Connects to configured VLM provider (configurable via env / settings with reasonable fallback).
- [x] Prompts VLM with task, sanitized screenshot, sanitized DOM skeleton, and detected UI elements.
- [x] Generates valid structured actions conforming to plan response schema.
- [x] A novel 5+ step task produces distinct, task-appropriate actions rather than a fixed sequence.
- [x] Integration test verifies server planning with mock or local VLM endpoint.
