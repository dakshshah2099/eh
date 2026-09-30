# Visual Perception & Planning Server

FastAPI server providing VLM planning for the Privacy Lens extension.

## Server-Key-Only Deployment Pattern

For production and secure deployments, upstream model provider API keys (OpenAI, Anthropic, Gemini, Groq, LiteLLM, etc.) **must reside strictly on the server** and never transit the browser extension.

### Configuration (`server/.env`)

1. **Upstream VLM Provider Credentials (Server-Side Only)**
   - `VLM_API_KEY`: Upstream API credential used by the server to call the vision-language model.
   - `VLM_PROVIDER`: Model provider (`ollama`, `openai`, `openai-compatible`, `litellm`, etc.).
   - `VLM_MODEL`: Model identifier (e.g. `gpt-4o`, `llama3.2-vision`).
   - `VLM_BASE_URL`: Optional custom base endpoint (e.g. `http://litellm:4000/v1`).

   > **Precedence Rule:** When `VLM_API_KEY` (or `OPENAI_API_KEY`) is set in the server environment, any `api_key` field sent in the client payload is ignored and logged as a deprecation warning.

2. **Client Ingress Authentication (`SERVER_API_KEY`)**
   - The browser extension only needs a server ingress auth token (`SERVER_API_KEY`).
   - When `REQUIRE_AUTH=1` or `SERVER_API_KEY` is non-empty, the extension sends:
     `Authorization: Bearer <SERVER_API_KEY>` or `X-API-Key: <SERVER_API_KEY>`
   - Upstream VLM credentials never enter the extension storage or client network traffic.

### Running the Server

```bash
# Activate virtual environment
source .venv/bin/activate  # or .venv\Scripts\Activate.ps1 on Windows

# Install dependencies
uv sync  # or pip install -e .

# Run development server
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### Running Tests

```bash
pytest
```
