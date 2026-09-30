import time
from unittest.mock import patch
import pytest
from fastapi.testclient import TestClient

from main import (
    app,
    _step_history,
    StepEntry,
    StepHistoryStore,
    DEFAULT_STEP_HISTORY_TTL_SECONDS,
    DEFAULT_STEP_HISTORY_MAX_KEYS,
    get_step_history_ttl,
    get_step_history_max_keys,
)
from vlm_planner import PlanResponse, ActionItem

client = TestClient(app)


def test_step_entry_attributes_and_backward_compatibility():
    """Verify StepEntry carries step and last_updated, and behaves like an int for backward compatibility."""
    now = 1700000000.0
    entry = StepEntry(step=3, last_updated=now)

    # Core attributes
    assert entry.step == 3
    assert entry.last_updated == now

    # Dict subscript access
    assert entry["step"] == 3
    assert entry["last_updated"] == now
    assert entry.get("step") == 3
    assert entry.get("last_updated") == now
    assert entry.get("nonexistent", "default_val") == "default_val"

    # Backward compatibility with int comparison and arithmetic
    assert entry == 3
    assert 3 == entry
    assert int(entry) == 3
    assert entry + 1 == 4
    assert 1 + entry == 4

    # Dict serialization
    assert entry.to_dict() == {"step": 3, "last_updated": now}
    assert "StepEntry(step=3" in repr(entry)


def test_step_history_ttl_advancement_and_lazy_eviction():
    """Verify an entry is evicted when time advances past TTL and eviction path is triggered."""
    store = StepHistoryStore(ttl=60.0, max_keys=100)
    t0 = 1000000.0

    with patch("time.time", return_value=t0):
        store["session-1:task-1"] = 1
        assert "session-1:task-1" in store
        assert store["session-1:task-1"].step == 1
        assert store["session-1:task-1"].last_updated == t0

    # Advance time by TTL + 1
    t_expired = t0 + 61.0
    with patch("time.time", return_value=t_expired):
        # Trigger the eviction path via a write
        store["session-2:task-2"] = 1

        # Assert expired entry is gone
        assert "session-1:task-1" not in store
        assert store.get("session-1:task-1") is None
        assert "session-2:task-2" in store
        assert len(store) == 1


def test_step_history_expired_key_restarts_from_step_one():
    """Verify that if a session's entry expires, the next write restarts its step count."""
    store = StepHistoryStore(ttl=30.0, max_keys=10)
    t0 = 1000.0

    with patch("time.time", return_value=t0):
        store.record_step("session-a:task-a")  # step 1
        store.record_step("session-a:task-a")  # step 2
        assert store.get_step("session-a:task-a") == 2

    # Advance time by TTL + 1
    with patch("time.time", return_value=t0 + 31.0):
        # Reading expired key returns default 0
        assert store.get_step("session-a:task-a") == 0
        assert "session-a:task-a" not in store

        # New step recorded starts from 1
        new_step = store.record_step("session-a:task-a")
        assert new_step == 1
        assert store.get_step("session-a:task-a") == 1


def test_step_history_bounded_capacity_evicts_oldest():
    """Verify that exceeding max_keys evicts the oldest entry by last_updated."""
    store = StepHistoryStore(ttl=1800.0, max_keys=3)
    base = time.time()

    store.record_step("key-1", timestamp=base + 1.0)
    store.record_step("key-2", timestamp=base + 2.0)
    store.record_step("key-3", timestamp=base + 3.0)
    assert len(store) == 3

    # Insert 4th key: key-1 (oldest at base + 1.0) must be evicted
    store.record_step("key-4", timestamp=base + 4.0)
    assert len(store) == 3
    assert "key-1" not in store
    assert "key-2" in store
    assert "key-3" in store
    assert "key-4" in store

    # Update key-2 to newer timestamp (base + 5.0)
    store.record_step("key-2", timestamp=base + 5.0)
    # Insert 5th key: key-3 (now oldest at base + 3.0) must be evicted
    store.record_step("key-5", timestamp=base + 6.0)
    assert len(store) == 3
    assert "key-3" not in store
    assert "key-2" in store
    assert "key-4" in store
    assert "key-5" in store


def test_step_history_load_10001_keys_bounded_cap():
    """Load test: insert 10,001 unique keys and assert store size stays bounded <= max_keys (10,000)."""
    store = StepHistoryStore(ttl=1800.0, max_keys=10000)

    start_time = time.time()
    for i in range(10001):
        store[f"load-session-{i}:task"] = 1
    duration = time.time() - start_time

    # Assert store size stays <= cap
    assert len(store) <= 10000
    assert len(store) == 10000

    # Oldest key (key 0) was evicted, newest key (key 10000) is present
    assert "load-session-0:task" not in store
    assert "load-session-10000:task" in store

    # Performance check: 10,001 insertions should finish comfortably within 2 seconds
    assert duration < 2.0


def test_step_history_env_var_configuration():
    """Verify TTL and max keys are configurable via STEP_HISTORY_TTL_SECONDS and STEP_HISTORY_MAX_KEYS."""
    env_overrides = {
        "STEP_HISTORY_TTL_SECONDS": "900",
        "STEP_HISTORY_MAX_KEYS": "5000",
    }
    with patch.dict("os.environ", env_overrides):
        assert get_step_history_ttl() == 900.0
        assert get_step_history_max_keys() == 5000

        # Store with defaults should dynamically reflect env vars
        store = StepHistoryStore()
        assert store.ttl == 900.0
        assert store.max_keys == 5000

    # Test invalid env var fallback to defaults
    invalid_env = {
        "STEP_HISTORY_TTL_SECONDS": "not-a-number",
        "STEP_HISTORY_MAX_KEYS": "-1",
    }
    with patch.dict("os.environ", invalid_env):
        assert get_step_history_ttl() == DEFAULT_STEP_HISTORY_TTL_SECONDS
        assert get_step_history_max_keys() == DEFAULT_STEP_HISTORY_MAX_KEYS


def test_step_history_periodic_sweep_method():
    """Verify sweep() / evict_expired() sweeps expired items and returns the count."""
    store = StepHistoryStore(ttl=60.0, max_keys=100)
    t0 = 5000.0

    with patch("time.time", return_value=t0):
        store["entry-1"] = 1
        store["entry-2"] = 1

    # Before TTL expires, sweep returns 0 and evicts nothing
    with patch("time.time", return_value=t0 + 30.0):
        evicted = store.sweep()
        assert evicted == 0
        assert len(store) == 2

    # After TTL expires, sweep removes both entries and returns 2
    with patch("time.time", return_value=t0 + 65.0):
        evicted = store.sweep()
        assert evicted == 2
        assert len(store) == 0


def test_step_history_out_of_order_timestamps():
    """Verify that out-of-order timestamp insertions still evict the oldest entry on capacity overflow."""
    store = StepHistoryStore(ttl=1800.0, max_keys=3)
    base = time.time()

    # Insert out-of-order timestamps
    store["k1"] = StepEntry(1, last_updated=base + 3.0)
    store["k2"] = StepEntry(1, last_updated=base + 1.0)  # oldest
    store["k3"] = StepEntry(1, last_updated=base + 2.0)
    assert len(store) == 3

    # Adding 4th key should evict k2 (last_updated=base + 1.0)
    store["k4"] = StepEntry(1, last_updated=base + 4.0)
    assert len(store) == 3
    assert "k2" not in store
    assert "k1" in store
    assert "k3" in store
    assert "k4" in store


def test_plan_api_step_history_ttl_integration():
    """Verify /api/plan populates _step_history with StepEntry and respects TTL eviction under API requests."""
    _step_history.clear()
    now = time.time()
    payload = {
        "task": "Test step history",
        "session_id": "api-sess-1",
        "task_id": "api-task-1",
        "dom_skeleton": [],
        "image_base64": "abc",
        "viewport": {"width": 1000, "height": 800},
        "redaction_map": [],
        "timestamp": now,
    }

    with patch("main.generate_plan") as mock_gen:
        mock_gen.return_value = PlanResponse(actions=[ActionItem(type="wait")], task_complete=False)

        res1 = client.post("/api/plan", json=payload)
        assert res1.status_code == 200

        composite_key = "api-sess-1:api-task-1"
        assert composite_key in _step_history
        entry1 = _step_history[composite_key]
        assert entry1.step == 1
        assert entry1 == 1
        assert abs(entry1.last_updated - now) < 2.0

        # Step 2
        payload["timestamp"] = now + 1.0
        res2 = client.post("/api/plan", json=payload)
        assert res2.status_code == 200
        assert _step_history[composite_key].step == 2
        assert _step_history[composite_key] == 2
