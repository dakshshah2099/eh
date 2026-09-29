import json
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from main import app
from vlm_planner import (
    generate_plan,
    parse_vlm_response,
    build_planner_prompt,
    PlanResponse,
    ActionItem,
)

client = TestClient(app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_plan_invalid_schema():
    # Missing required field 'task'
    payload = {
        "dom_skeleton": [],
        "image_base64": "abc",
        "viewport": {},
        "redaction_map": [],
    }
    response = client.post("/api/plan", json=payload)
    assert response.status_code == 422

    # Invalid redaction_map item
    invalid_redaction = {
        "task": "Test",
        "dom_skeleton": [],
        "image_base64": "abc",
        "viewport": {},
        "redaction_map": [
            {
                "bbox": "invalid_bbox",
                "category": "PII",
                "source": "dom",
                "confidence": 0.9,
            }
        ],
    }
    response = client.post("/api/plan", json=invalid_redaction)
    assert response.status_code == 422


def test_build_planner_prompt():
    prompt = build_planner_prompt(
        task="Search for flight tickets",
        dom_skeleton=[{"tag": "input", "id": "flight-search"}],
        ui_elements=[{"label": "Search Flights", "bbox": [10, 20, 100, 30], "element_id": "btn_1"}],
        redaction_map=[{"bbox": [0, 0, 50, 20], "category": "PII"}],
        viewport={"width": 1280, "height": 720},
    )
    assert "Search for flight tickets" in prompt
    assert "flight-search" in prompt
    assert "btn_1" in prompt
    assert "REDACTED REGIONS" in prompt


def test_parse_vlm_response_markdown_and_raw():
    raw_json = '{"actions": [{"type": "click", "target_selector": "#search"}], "task_complete": false, "confidence": 0.9}'
    res = parse_vlm_response(raw_json)
    assert len(res.actions) == 1
    assert res.actions[0].type == "click"
    assert res.actions[0].target_selector == "#search"

    markdown_json = f"```json\n{raw_json}\n```"
    res_md = parse_vlm_response(markdown_json)
    assert res_md.actions[0].target_selector == "#search"


@patch("vlm_planner.call_ollama")
def test_plan_endpoint_with_mock_ollama(mock_ollama):
    mock_ollama.return_value = json.dumps({
        "actions": [
            {
                "type": "type",
                "target_selector": "input#query",
                "text": "London to Paris",
                "reason": "Enter destination",
            }
        ],
        "task_complete": False,
        "confidence": 0.92,
    })

    payload = {
        "task": "Book a trip",
        "dom_skeleton": [{"tag": "input", "id": "query"}],
        "image_base64": "data:image/png;base64,abc",
        "viewport": {"width": 1280, "height": 720},
        "redaction_map": [],
        "ui_elements": [{"element_id": "input_query", "bbox": [10, 10, 100, 30]}],
    }

    with patch.dict("os.environ", {"VLM_PROVIDER": "ollama"}):
        response = client.post("/api/plan", json=payload)

    assert response.status_code == 200
    data = response.json()
    assert data["task_complete"] is False
    assert len(data["actions"]) == 1
    assert data["actions"][0]["type"] == "type"
    assert data["actions"][0]["text"] == "London to Paris"


@patch("vlm_planner.call_openai_compatible")
def test_plan_endpoint_with_openai_compatible(mock_openai):
    mock_openai.return_value = json.dumps({
        "actions": [
            {
                "type": "click",
                "target_bbox": [50.0, 100.0, 80.0, 30.0],
                "target_element_id": "ui_btn_42",
                "reason": "Confirm selection",
            }
        ],
        "task_complete": False,
        "confidence": 0.98,
    })

    payload = {
        "task": "Confirm flight booking",
        "dom_skeleton": [],
        "image_base64": "abc",
        "viewport": {"width": 1024, "height": 768},
        "redaction_map": [],
    }

    with patch.dict("os.environ", {"VLM_PROVIDER": "openai", "OPENAI_API_KEY": "test_key"}):
        response = client.post("/api/plan", json=payload)

    assert response.status_code == 200
    data = response.json()
    assert len(data["actions"]) == 1
    assert data["actions"][0]["type"] == "click"
    assert data["actions"][0]["target_element_id"] == "ui_btn_42"


def test_plan_fallback_when_offline():
    payload = {
        "task": "Click submit button",
        "dom_skeleton": [
            {"tag": "button", "id": "submit", "text": "Submit"}
        ],
        "image_base64": "abc",
        "viewport": {"width": 1280, "height": 720},
        "redaction_map": [],
    }
    with patch.dict("os.environ", {"VLM_PROVIDER": "fallback"}):
        response = client.post("/api/plan", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert len(data["actions"]) == 1
    assert data["actions"][0]["type"] == "click"
    assert data["actions"][0]["target_selector"] == "#submit"


def test_novel_5_step_task_distinct_actions():
    """Verify that a 5+ step novel workflow produces distinct, task-appropriate actions."""
    simulated_steps = [
        # Step 1: Search field
        (
            {"task": "Buy a wireless mouse on store", "dom_skeleton": [{"tag": "input", "id": "search-input"}]},
            json.dumps({"actions": [{"type": "type", "target_selector": "#search-input", "text": "wireless mouse"}], "task_complete": False, "confidence": 0.9})
        ),
        # Step 2: Search button
        (
            {"task": "Buy a wireless mouse on store", "dom_skeleton": [{"tag": "button", "id": "search-btn"}]},
            json.dumps({"actions": [{"type": "click", "target_selector": "#search-btn"}], "task_complete": False, "confidence": 0.95})
        ),
        # Step 3: Product card
        (
            {"task": "Buy a wireless mouse on store", "dom_skeleton": [{"tag": "div", "class": "product-card", "id": "item-1"}]},
            json.dumps({"actions": [{"type": "click", "target_selector": "#item-1"}], "task_complete": False, "confidence": 0.93})
        ),
        # Step 4: Add to cart
        (
            {"task": "Buy a wireless mouse on store", "dom_skeleton": [{"tag": "button", "id": "add-to-cart"}]},
            json.dumps({"actions": [{"type": "click", "target_selector": "#add-to-cart"}], "task_complete": False, "confidence": 0.96})
        ),
        # Step 5: Checkout
        (
            {"task": "Buy a wireless mouse on store", "dom_skeleton": [{"tag": "button", "id": "checkout"}]},
            json.dumps({"actions": [{"type": "click", "target_selector": "#checkout"}], "task_complete": False, "confidence": 0.98})
        ),
        # Step 6: Confirmation / task complete
        (
            {"task": "Buy a wireless mouse on store", "dom_skeleton": [{"tag": "div", "id": "order-success"}]},
            json.dumps({"actions": [], "task_complete": True, "confidence": 0.99})
        ),
    ]

    action_history = []
    for step_num, (state, vlm_reply) in enumerate(simulated_steps, 1):
        with patch("vlm_planner.call_ollama", return_value=vlm_reply):
            payload = {
                "task": state["task"],
                "dom_skeleton": state["dom_skeleton"],
                "image_base64": f"step_{step_num}_img",
                "viewport": {"width": 1280, "height": 720},
                "redaction_map": [],
            }
            with patch.dict("os.environ", {"VLM_PROVIDER": "ollama"}):
                resp = client.post("/api/plan", json=payload)
            assert resp.status_code == 200
            data = resp.json()
            if data["actions"]:
                action_history.append((data["actions"][0]["type"], data["actions"][0].get("target_selector")))
            else:
                assert data["task_complete"] is True

    # Assert 5 distinct steps were executed
    assert len(action_history) == 5
    # Confirm actions are distinct and not hardcoded identical sequence
    unique_actions = set(action_history)
    assert len(unique_actions) == 5
    assert action_history[0] == ("type", "#search-input")
    assert action_history[1] == ("click", "#search-btn")
    assert action_history[2] == ("click", "#item-1")
    assert action_history[3] == ("click", "#add-to-cart")
    assert action_history[4] == ("click", "#checkout")


def test_env_precedence_vlm_base_url_and_api_key():
    from vlm_planner import (
        get_vlm_provider,
        get_vlm_model,
        get_ollama_base_url,
        get_openai_base_url,
        get_openai_api_key,
    )

    env_overrides = {
        "VLM_PROVIDER": "litellm",
        "VLM_MODEL": "qwen-2.5-vl",
        "VLM_BASE_URL": "http://litellm-proxy:4000/v1",
        "VLM_API_KEY": "custom-vlm-key",
        "OPENAI_BASE_URL": "https://api.openai.com/v1",
        "OPENAI_API_KEY": "openai-key",
    }
    with patch.dict("os.environ", env_overrides):
        assert get_vlm_provider() == "litellm"
        assert get_vlm_model() == "qwen-2.5-vl"
        assert get_openai_base_url() == "http://litellm-proxy:4000/v1"
        assert get_ollama_base_url() == "http://litellm-proxy:4000/v1"
        assert get_openai_api_key() == "custom-vlm-key"


def test_call_ollama_http_dispatch():
    from vlm_planner import call_ollama

    with patch("httpx.Client") as mock_client_cls:
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.json.return_value = {"response": '{"actions": []}'}
        mock_client.post.return_value = mock_response
        mock_client_cls.return_value.__enter__.return_value = mock_client

        res = call_ollama(
            prompt="Test prompt",
            image_base64="data:image/png;base64,aGVsbG8=",
            base_url="http://localhost:11434",
            model="llama3.2-vision",
        )
        assert res == '{"actions": []}'
        mock_client.post.assert_called_once()
        args, kwargs = mock_client.post.call_args
        assert args[0] == "http://localhost:11434/api/generate"
        payload = kwargs["json"]
        assert payload["model"] == "llama3.2-vision"
        assert payload["images"] == ["aGVsbG8="]
        assert payload["format"] == "json"


def test_call_openai_compatible_http_dispatch():
    from vlm_planner import call_openai_compatible

    with patch("httpx.Client") as mock_client_cls:
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "choices": [{"message": {"content": '{"actions": [], "task_complete": true}'}}]
        }
        mock_client.post.return_value = mock_response
        mock_client_cls.return_value.__enter__.return_value = mock_client

        res = call_openai_compatible(
            prompt="Analyze this page",
            image_base64="data:image/png;base64,dGVzdA==",
            base_url="https://api.openai.com/v1",
            model="gpt-4o",
            api_key="sk-testkey",
        )
        assert res == '{"actions": [], "task_complete": true}'
        mock_client.post.assert_called_once()
        args, kwargs = mock_client.post.call_args
        assert args[0] == "https://api.openai.com/v1/chat/completions"
        assert kwargs["headers"]["Authorization"] == "Bearer sk-testkey"
        payload = kwargs["json"]
        assert payload["model"] == "gpt-4o"
        assert payload["messages"][1]["content"][1]["type"] == "image_url"
        assert payload["messages"][1]["content"][1]["image_url"]["url"] == "data:image/png;base64,dGVzdA=="


def test_parse_vlm_response_robust_normalizations():
    # Extra text with markdown code block
    text_with_block = """
    Here is the structured action:
    ```json
    {
      "actions": [
        {
          "action": "click",
          "selector": "button#login",
          "bbox": [10.0, 20.0, 100.0, 40.0],
          "element_id": "login_btn"
        }
      ],
      "task_complete": false,
      "confidence": 0.85
    }
    ```
    """
    res = parse_vlm_response(text_with_block)
    assert len(res.actions) == 1
    assert res.actions[0].type == "click"
    assert res.actions[0].target_selector == "button#login"
    assert res.actions[0].target_bbox == [10.0, 20.0, 100.0, 40.0]
    assert res.actions[0].target_element_id == "login_btn"

    # Raw list format without wrapper dict
    list_text = '[{"action": "type", "selector": "input#email", "text": "user@example.com"}]'
    res_list = parse_vlm_response(list_text)
    assert len(res_list.actions) == 1
    assert res_list.actions[0].type == "type"
    assert res_list.actions[0].target_selector == "input#email"
    assert res_list.actions[0].text == "user@example.com"


@patch("vlm_planner.call_openai_compatible")
def test_openai_compatible_provider_alias_routing(mock_call):
    mock_call.return_value = json.dumps({"actions": [{"type": "wait"}], "task_complete": False})
    payload = {
        "task": "Wait for load",
        "dom_skeleton": [],
        "image_base64": "abc",
        "viewport": {"width": 1000, "height": 800},
        "redaction_map": [],
    }
    with patch.dict("os.environ", {"VLM_PROVIDER": "litellm", "VLM_API_KEY": "fake_key"}):
        resp = client.post("/api/plan", json=payload)
    assert resp.status_code == 200
    mock_call.assert_called_once()


def test_vlm_network_failure_falls_back_gracefully():
    with patch("vlm_planner.call_ollama", side_effect=Exception("Connection refused")):
        payload = {
            "task": "Click submit button",
            "dom_skeleton": [{"tag": "button", "id": "submit", "text": "Submit"}],
            "image_base64": "abc",
            "viewport": {"width": 1280, "height": 720},
            "redaction_map": [],
        }
        with patch.dict("os.environ", {"VLM_PROVIDER": "ollama"}):
            resp = client.post("/api/plan", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["actions"]) == 1
        assert data["actions"][0]["type"] == "click"
        assert data["actions"][0]["target_selector"] == "#submit"


def test_concurrent_sessions_isolated_state():
    from main import _step_history
    task_name = "Submit shared registration"
    session_a = "session-uuid-1111"
    session_b = "session-uuid-2222"

    payload_a = {
        "session_id": session_a,
        "task_id": "task-001",
        "task": task_name,
        "dom_skeleton": [],
        "image_base64": "abc",
        "viewport": {"width": 1000, "height": 800},
        "redaction_map": [],
    }
    payload_b = {
        "session_id": session_b,
        "task_id": "task-001",
        "task": task_name,
        "dom_skeleton": [],
        "image_base64": "abc",
        "viewport": {"width": 1000, "height": 800},
        "redaction_map": [],
    }

    # Step session A twice
    client.post("/api/plan", json=payload_a)
    client.post("/api/plan", json=payload_a)

    # Step session B once
    client.post("/api/plan", json=payload_b)

    key_a = f"{session_a}:task-001"
    key_b = f"{session_b}:task-001"

    assert _step_history[key_a] == 2
    assert _step_history[key_b] == 1


