import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import httpx

URL = "https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct/resolve/main/model.safetensors"
OUT_DIR = Path(__file__).resolve().parent / "models" / "smolvlm"
FINAL_FILE = OUT_DIR / "model.safetensors"
TOTAL_SIZE = 513028808
NUM_WORKERS = 8

def download_range(idx: int, start: int, end: int, part_path: Path):
    expected_len = end - start + 1
    if part_path.exists() and part_path.stat().st_size == expected_len:
        print(f"[Worker {idx}] Already downloaded ({expected_len} bytes)")
        return True

    headers = {"Range": f"bytes={start}-{end}"}
    for attempt in range(1, 6):
        try:
            temp_path = Path(f"{part_path}.tmp")
            with httpx.Client(follow_redirects=True, timeout=120.0) as client:
                with client.stream("GET", URL, headers=headers) as resp:
                    resp.raise_for_status()
                    with open(temp_path, "wb") as f:
                        for chunk in resp.iter_bytes(chunk_size=512 * 1024):
                            f.write(chunk)
            temp_path.replace(part_path)
            print(f"[Worker {idx}] Successfully completed ({expected_len} bytes)")
            return True
        except Exception as e:
            print(f"[Worker {idx}] Attempt {attempt} failed: {e}. Retrying in 2s...")
            time.sleep(2)
    return False

def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if FINAL_FILE.exists() and FINAL_FILE.stat().st_size == TOTAL_SIZE:
        print(f"model.safetensors already complete ({TOTAL_SIZE} bytes)")
        return

    chunk_size = TOTAL_SIZE // NUM_WORKERS
    tasks = []
    part_files = []

    for i in range(NUM_WORKERS):
        start = i * chunk_size
        end = (start + chunk_size - 1) if i < NUM_WORKERS - 1 else (TOTAL_SIZE - 1)
        part_file = OUT_DIR / f"part_{i}.bin"
        part_files.append(part_file)
        tasks.append((i, start, end, part_file))

    print(f"Downloading {TOTAL_SIZE / 1e6:.1f} MB across {NUM_WORKERS} parallel workers...")
    start_time = time.time()

    with ThreadPoolExecutor(max_workers=NUM_WORKERS) as executor:
        futures = [executor.submit(download_range, *t) for t in tasks]
        results = [f.result() for f in futures]

    if not all(results):
        print("ERROR: One or more workers failed.")
        sys.exit(1)

    print("All chunks downloaded! Merging into model.safetensors...")
    temp_final = Path(f"{FINAL_FILE}.combining")
    with open(temp_final, "wb") as outfile:
        for p in part_files:
            with open(p, "rb") as infile:
                while chunk := infile.read(4 * 1024 * 1024):
                    outfile.write(chunk)
            p.unlink()

    temp_final.replace(FINAL_FILE)
    elapsed = time.time() - start_time
    print(f"Successfully assembled model.safetensors ({FINAL_FILE.stat().st_size} bytes) in {elapsed:.1f}s!")

if __name__ == "__main__":
    main()
