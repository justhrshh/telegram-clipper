import sys
import os
import json
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
VENV_SITE_PACKAGES = os.path.join(PROJECT_ROOT, ".venv", "Lib", "site-packages")
HF_CACHE_DIR = os.path.join(PROJECT_ROOT, "assets", "hf_cache")

os.environ["HF_HOME"] = HF_CACHE_DIR
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

# Register NVIDIA DLL directories
NVIDIA_BIN_DIRS = [
    os.path.join(VENV_SITE_PACKAGES, "nvidia", "cublas", "bin"),
    os.path.join(VENV_SITE_PACKAGES, "nvidia", "cudnn", "bin"),
    os.path.join(VENV_SITE_PACKAGES, "nvidia", "cuda_nvrtc", "bin"),
    os.path.join(VENV_SITE_PACKAGES, "nvidia", "cuda_runtime", "bin"),
]

for d in NVIDIA_BIN_DIRS:
    if os.path.isdir(d):
        if hasattr(os, "add_dll_directory"):
            try:
                os.add_dll_directory(d)
            except Exception:
                pass
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")

def run_diagnose():
    print("=== FASTER-WHISPER CUDA DIAGNOSTIC ===")
    
    # Check DLLs
    dlls = ["cublas64_12.dll", "cublasLt64_12.dll", "cudnn64_9.dll"]
    dll_status = {}
    for dll in dlls:
        found = False
        for d in NVIDIA_BIN_DIRS:
            p = os.path.join(d, dll)
            if os.path.isfile(p):
                found = True
                dll_status[dll] = p
                break
        if not found:
            dll_status[dll] = "MISSING"

    print("CUDA DLL Status:")
    for k, v in dll_status.items():
        print(f"  {k}: {v}")

    import ctranslate2
    import faster_whisper

    print(f"ctranslate2 version: {ctranslate2.__version__}")
    print(f"faster_whisper version: {faster_whisper.__version__}")
    cuda_devices = ctranslate2.get_cuda_device_count()
    print(f"CUDA Device Count: {cuda_devices}")
    
    if cuda_devices == 0:
        print("ERROR: ctranslate2 detected 0 CUDA devices!")
        sys.exit(1)

    audio_path = os.path.join(PROJECT_ROOT, "assets", "test_speech.wav")
    if not os.path.isfile(audio_path):
        print(f"ERROR: Sample audio not found at {audio_path}")
        sys.exit(1)

    benchmarks = {}

    for compute_type in ["float16", "int8_float16"]:
        print(f"\n--- Testing device=cuda, compute_type={compute_type} ---")
        try:
            t0 = time.time()
            model = faster_whisper.WhisperModel(
                "large-v3",
                device="cuda",
                device_index=0,
                compute_type=compute_type,
                download_root=HF_CACHE_DIR,
            )
            load_time = time.time() - t0
            print(f"Model loaded in {load_time:.2f}s")

            t1 = time.time()
            segments, info = model.transcribe(
                audio_path,
                beam_size=1,
                word_timestamps=True,
                vad_filter=True,
            )
            words = []
            for seg in segments:
                if seg.words:
                    for w in seg.words:
                        words.append({
                            "word": w.word,
                            "start": round(w.start, 2),
                            "end": round(w.end, 2),
                            "prob": round(w.probability, 2),
                        })
            infer_time = time.time() - t1
            print(f"Inference completed in {infer_time:.2f}s, transcribed {len(words)} words:")
            for w in words[:5]:
                print(f"  [{w['start']}s - {w['end']}s] {w['word']} (p={w['prob']})")

            benchmarks[compute_type] = {
                "success": True,
                "load_time_s": round(load_time, 2),
                "inference_time_s": round(infer_time, 2),
                "words_count": len(words),
            }
        except Exception as e:
            print(f"FAILED on {compute_type}: {e}")
            benchmarks[compute_type] = {
                "success": False,
                "error": str(e),
            }

    print("\n=== SUMMARY ===")
    print(json.dumps(benchmarks, indent=2))

if __name__ == "__main__":
    run_diagnose()
