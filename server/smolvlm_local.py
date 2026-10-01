import base64
import io
import logging
import os
from pathlib import Path
from typing import Optional, Tuple
from PIL import Image
import torch

logger = logging.getLogger(__name__)

_GLOBAL_MODEL = None
_GLOBAL_PROCESSOR = None
_MODEL_DIR = Path(__file__).resolve().parent / "models" / "smolvlm"

def get_model_path() -> Path:
    """Returns the local path where SmolVLM weights and configs reside."""
    custom_path = os.getenv("SMOLVLM_MODEL_PATH")
    if custom_path:
        return Path(custom_path)
    return _MODEL_DIR

def is_smolvlm_ready() -> bool:
    """Checks whether local weights and configuration files exist."""
    m_dir = get_model_path()
    weights_file = m_dir / "model.safetensors"
    config_file = m_dir / "config.json"
    return config_file.exists() and weights_file.exists() and weights_file.stat().st_size > 100_000_000

def load_smolvlm():
    """Lazy loads local SmolVLM processor and model into memory."""
    global _GLOBAL_MODEL, _GLOBAL_PROCESSOR
    if _GLOBAL_MODEL is not None and _GLOBAL_PROCESSOR is not None:
        return _GLOBAL_MODEL, _GLOBAL_PROCESSOR

    m_dir = get_model_path()
    if not is_smolvlm_ready():
        raise FileNotFoundError(
            f"SmolVLM weights not fully downloaded yet in {m_dir}. Please wait for download to complete."
        )

    logger.info(f"[SmolVLM] Loading local model from {m_dir}...")
    import json
    from transformers import AutoModelForImageTextToText, AutoProcessor

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32

    processor = AutoProcessor.from_pretrained(str(m_dir), local_files_only=True)
    if not processor.chat_template or processor.chat_template == "Entry not found":
        tpl_file = m_dir / "chat_template.json"
        tok_file = m_dir / "tokenizer_config.json"
        if tpl_file.exists():
            with open(tpl_file, "r", encoding="utf-8") as f:
                processor.chat_template = json.load(f).get("chat_template")
        elif tok_file.exists():
            with open(tok_file, "r", encoding="utf-8") as f:
                processor.chat_template = json.load(f).get("chat_template")

    if hasattr(processor, "tokenizer") and (not processor.tokenizer.chat_template or processor.tokenizer.chat_template == "Entry not found"):
        processor.tokenizer.chat_template = processor.chat_template

    model = AutoModelForImageTextToText.from_pretrained(
        str(m_dir),
        dtype=dtype,
        low_cpu_mem_usage=True,
        local_files_only=True,
    ).to(device)

    if hasattr(model, "generation_config") and model.generation_config is not None:
        model.generation_config.max_length = None

    model.eval()
    _GLOBAL_MODEL = model
    _GLOBAL_PROCESSOR = processor
    logger.info(f"[SmolVLM] Loaded successfully on {device} ({dtype}).")
    return _GLOBAL_MODEL, _GLOBAL_PROCESSOR

def decode_image(image_base64: str) -> Optional[Image.Image]:
    """Decodes data URI or raw base64 string to a PIL Image."""
    if not image_base64 or not image_base64.strip():
        return None
    raw = image_base64
    if "," in raw:
        raw = raw.split(",", 1)[1]
    try:
        data = base64.b64decode(raw.strip())
        img = Image.open(io.BytesIO(data))
        return img.convert("RGB")
    except Exception as e:
        logger.warning(f"[SmolVLM] Failed to decode base64 image: {e}")
        return None

def call_smolvlm(
    prompt: str,
    image_base64: str = "",
    system_prompt: str = "",
    max_new_tokens: int = 256,
) -> str:
    """Runs local inference using on-device SmolVLM."""
    model, processor = load_smolvlm()
    device = next(model.parameters()).device

    if hasattr(processor, "image_processor") and hasattr(processor.image_processor, "do_image_splitting"):
        processor.image_processor.do_image_splitting = False

    pil_img = decode_image(image_base64)
    full_prompt = f"{system_prompt}\n\n{prompt}" if system_prompt else prompt

    content = []
    images = []
    if pil_img is not None:
        content.append({"type": "image"})
        images.append(pil_img)
    content.append({"type": "text", "text": full_prompt})

    messages = [{"role": "user", "content": content}]

    text_prompt = processor.apply_chat_template(messages, add_generation_prompt=True)
    if images:
        inputs = processor(text=text_prompt, images=images, return_tensors="pt")
    else:
        inputs = processor(text=text_prompt, return_tensors="pt")

    inputs = {k: v.to(device) for k, v in inputs.items()}
    input_len = inputs["input_ids"].shape[1]
    logger.info(f"[SmolVLM] Starting generation (input tokens: {input_len}, max_new_tokens: {max_new_tokens})...")

    t_start = time.time()
    with torch.no_grad():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False
        )

    dur = time.time() - t_start
    generated_tokens = output_ids[0][input_len:]
    logger.info(f"[SmolVLM] Generated {len(generated_tokens)} tokens in {dur:.2f}s ({len(generated_tokens)/max(dur, 0.001):.1f} tok/s).")
    response_text = processor.decode(generated_tokens, skip_special_tokens=True).strip()
    return response_text
