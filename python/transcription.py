import sys
import os
import json
import time
import argparse
import ctypes
import ctypes.util

# 1. Resolve project root and virtual environment site-packages
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
VENV_SITE_PACKAGES = os.path.join(PROJECT_ROOT, ".venv", "Lib", "site-packages")
HF_CACHE_DIR = os.path.join(PROJECT_ROOT, "assets", "hf_cache")

# Redirect HuggingFace cache to D: drive assets to avoid filling C: system drive
os.environ["HF_HOME"] = HF_CACHE_DIR
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

# 2. Register NVIDIA CUDA and cuDNN DLL directories
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


def get_installed_cuda_dlls():
    """
    Scans for required CUDA 12 and cuDNN 9 libraries in the environment.
    """
    required_dlls = {
        "cublas64_12.dll": False,
        "cublasLt64_12.dll": False,
        "cudnn64_9.dll": False,
    }
    paths = {}

    for dll_name in required_dlls.keys():
        # Check NVIDIA_BIN_DIRS first
        found = False
        for bin_dir in NVIDIA_BIN_DIRS:
            candidate = os.path.join(bin_dir, dll_name)
            if os.path.isfile(candidate):
                required_dlls[dll_name] = True
                paths[dll_name] = candidate
                found = True
                break

        # Fallback to system PATH / ctypes
        if not found:
            located = ctypes.util.find_library(dll_name)
            if located:
                required_dlls[dll_name] = True
                paths[dll_name] = located
            else:
                paths[dll_name] = None

    return required_dlls, paths


def diagnose_gpu_environment():
    """
    Performs a lightweight, deterministic diagnostic of NVIDIA GPU and CTranslate2 CUDA readiness.
    Does not load large Whisper models.
    """
    result = {
        "gpu_available": False,
        "cuda_runtime_ok": False,
        "ctranslate2_cuda_ok": False,
        "gpu_ready": False,
        "device_name": None,
        "vram_mb": None,
        "driver_version": None,
        "missing_libraries": [],
        "library_paths": {},
        "supported_compute_types": [],
        "failure_reason": None,
    }

    # Step A: Check CUDA DLL availability
    dll_status, dll_paths = get_installed_cuda_dlls()
    result["library_paths"] = dll_paths
    missing = [k for k, v in dll_status.items() if not v]
    if missing:
        result["missing_libraries"] = missing
        result["failure_reason"] = f"Missing required CUDA runtime libraries: {', '.join(missing)}"
    else:
        result["cuda_runtime_ok"] = True

    # Step B: Check CTranslate2 CUDA devices
    try:
        import ctranslate2

        device_count = ctranslate2.get_cuda_device_count()
        if device_count > 0:
            result["gpu_available"] = True
            try:
                supported = ctranslate2.get_supported_compute_types("cuda")
                result["supported_compute_types"] = sorted(list(supported))
            except Exception as e:
                result["supported_compute_types"] = []
                result["failure_reason"] = f"Failed querying supported compute types: {e}"
        else:
            result["gpu_available"] = False
            result["failure_reason"] = "No CUDA-capable GPU detected (CTranslate2 device count is 0)"
    except Exception as e:
        result["gpu_available"] = False
        result["failure_reason"] = f"CTranslate2 import/CUDA probe failed: {e}"
        return result

    # Step C: Query GPU info via nvidia-smi if available
    try:
        import subprocess

        smi_out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if smi_out.returncode == 0 and smi_out.stdout.strip():
            parts = [p.strip() for p in smi_out.stdout.strip().split(",")]
            if len(parts) >= 3:
                result["device_name"] = parts[0]
                result["vram_mb"] = int(parts[1]) if parts[1].isdigit() else parts[1]
                result["driver_version"] = parts[2]
    except Exception:
        pass

    # Step D: Lightweight CTranslate2 CUDA kernel verification
    if result["gpu_available"] and result["cuda_runtime_ok"]:
        try:
            from faster_whisper import WhisperModel
            import numpy as np

            probe_type = "float16" if "float16" in result["supported_compute_types"] else "float32"
            m_probe = WhisperModel("tiny", device="cuda", compute_type=probe_type, download_root=HF_CACHE_DIR)
            dummy_audio = np.zeros(16000, dtype=np.float32)
            gen, _ = m_probe.transcribe(dummy_audio)
            list(gen)  # Force encoder execution

            result["ctranslate2_cuda_ok"] = True
            result["gpu_ready"] = True
            result["failure_reason"] = None
        except Exception as e:
            result["ctranslate2_cuda_ok"] = False
            result["gpu_ready"] = False
            err_str = str(e)
            result["failure_reason"] = f"CTranslate2 CUDA execution probe failed: {err_str}"
            # Check for specific library load errors
            for lib in ["cublas64_12.dll", "cublasLt64_12.dll", "cudnn64_9.dll"]:
                if lib in err_str and lib not in result["missing_libraries"]:
                    result["missing_libraries"].append(lib)

    return result


def select_transcription_device_and_compute(requested_device="auto", requested_compute="auto"):
    """
    Selects the optimal device and compute type deterministically.
    Never silently crashes on missing CUDA libraries.
    """
    req_dev = (requested_device or "auto").lower()
    req_comp = (requested_compute or "auto").lower()

    # If CPU explicitly requested
    if req_dev == "cpu":
        comp = "int8" if req_comp == "auto" else req_comp
        sys.stderr.write(f"[INFO] [CPU TRANSCRIPTION] Explicitly selected device=cpu, compute_type={comp}\n")
        return "cpu", comp, {"device": "cpu", "compute_type": comp, "gpu_used": False}

    # Probe GPU environment
    diag = diagnose_gpu_environment()

    if diag["gpu_ready"]:
        device = "cuda"
        if req_comp == "auto":
            # For RTX 3050 (Ampere, compute capability 8.6), float16 is native and optimal
            compute_type = "float16"
        else:
            compute_type = req_comp

        sys.stderr.write(
            f"[INFO] [GPU TRANSCRIPTION] Deterministic GPU startup passed: device={device}, compute_type={compute_type} "
            f"({diag['device_name'] or 'NVIDIA GPU'}, VRAM: {diag['vram_mb']}MB, driver: {diag['driver_version']})\n"
        )
        return device, compute_type, diag

    # GPU failed checks
    missing_str = ", ".join(diag["missing_libraries"]) if diag["missing_libraries"] else "none"
    sys.stderr.write(
        f"[WARN] [GPU_INIT_FAILED] GPU unavailable for transcription. missing_library={missing_str} reason={diag['failure_reason']}\n"
    )

    if req_dev == "cuda":
        sys.stderr.write("[WARN] Explicit device=cuda requested but GPU unavailable. Falling back to CPU int8.\n")

    fallback_comp = "int8" if req_comp in ("auto", "float16") else req_comp
    sys.stderr.write(f"[INFO] [CPU TRANSCRIPTION] Fallback active: device=cpu, compute_type={fallback_comp}\n")
    return "cpu", fallback_comp, diag


def load_model(model_name, device, compute_type):
    """
    Loads faster-whisper model with dedicated error handling and timing metrics.
    """
    from faster_whisper import WhisperModel

    os.makedirs(HF_CACHE_DIR, exist_ok=True)
    start_time = time.time()
    sys.stderr.write(
        f"[INFO] Loading Whisper model '{model_name}' on device='{device}', compute_type='{compute_type}' "
        f"(cache: {HF_CACHE_DIR})...\n"
    )

    try:
        model = WhisperModel(
            model_name,
            device=device,
            compute_type=compute_type,
            download_root=HF_CACHE_DIR,
        )
        elapsed = time.time() - start_time
        sys.stderr.write(
            f"[INFO] Whisper model '{model_name}' loaded in {elapsed:.2f}s ({device}/{compute_type})\n"
        )
        return model, device, compute_type, elapsed
    except Exception as e:
        if device == "cuda":
            sys.stderr.write(f"[WARN] [GPU_MODEL_LOAD_FAILED] CUDA model load failed ({e}). Falling back to CPU int8...\n")
            start_cpu = time.time()
            model = WhisperModel(
                model_name,
                device="cpu",
                compute_type="int8",
                download_root=HF_CACHE_DIR,
            )
            elapsed = time.time() - start_cpu
            sys.stderr.write(f"[INFO] Whisper model '{model_name}' loaded on CPU in {elapsed:.2f}s (cpu/int8)\n")
            return model, "cpu", "int8", elapsed
        raise e


def transcribe_audio(audio_path, model_name="large-v3", device="auto", compute_type="auto"):
    """
    Transcribes audio with word-level timestamps and VAD filtering using faster-whisper.
    """
    chosen_device, chosen_compute, diag = select_transcription_device_and_compute(device, compute_type)
    model, final_device, final_compute, load_time = load_model(model_name, chosen_device, chosen_compute)

    is_gpu = (final_device == "cuda")
    header_tag = "[GPU TRANSCRIPTION]" if is_gpu else "[CPU TRANSCRIPTION]"
    sys.stderr.write(
        f"[INFO] {header_tag} Starting transcription (model: {model_name}, device: {final_device}, compute: {final_compute})\n"
        f"       Audio target: {audio_path}\n"
    )

    transcribe_start = time.time()

    segments_gen, info = model.transcribe(
        audio_path,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=300),
    )

    all_words = []
    all_segments = []

    for seg in segments_gen:
        seg_dict = {
            "id": seg.id,
            "start": round(seg.start, 2),
            "end": round(seg.end, 2),
            "text": seg.text.strip(),
            "words": [],
        }

        if seg.words:
            for w in seg.words:
                clean_word = w.word.strip()
                if clean_word:
                    word_entry = {
                        "word": clean_word,
                        "start": round(w.start, 2),
                        "end": round(w.end, 2),
                        "probability": round(w.probability, 2),
                    }
                    seg_dict["words"].append(word_entry)
                    all_words.append({
                        "word": clean_word,
                        "start": round(w.start, 2),
                        "end": round(w.end, 2),
                    })

        all_segments.append(seg_dict)

    transcribe_duration = round(time.time() - transcribe_start, 2)
    sys.stderr.write(
        f"[INFO] {header_tag} Completed: {len(all_words)} words across {len(all_segments)} segments in {transcribe_duration}s "
        f"(lang: {info.language}, prob: {info.language_probability:.2f})\n"
    )

    return {
        "language": info.language,
        "language_probability": round(info.language_probability, 2),
        "duration": round(info.duration, 2),
        "device": final_device,
        "compute_type": final_compute,
        "is_gpu_used": is_gpu,
        "model": model_name,
        "model_load_time_sec": round(load_time, 2),
        "transcription_time_sec": transcribe_duration,
        "word_count": len(all_words),
        "words": all_words,
        "segments": all_segments,
        "diagnostic": diag,
    }


def run_diagnose_command():
    """
    Executes full system diagnostic report for faster-whisper, CTranslate2, and NVIDIA CUDA.
    """
    import faster_whisper
    import ctranslate2

    print("\n=======================================================")
    print("  TELEGRAM CLIPPER — AI TRANSCRIPTION HEALTH CHECK")
    print("=======================================================\n")

    print(f"Python Version:       {sys.version.split()[0]} ({sys.executable})")
    print(f"faster-whisper:       {faster_whisper.__version__}")
    print(f"ctranslate2:          {ctranslate2.__version__}")
    print(f"HuggingFace Cache:    {HF_CACHE_DIR}")

    diag = diagnose_gpu_environment()

    print("\n[NVIDIA GPU & CUDA RUNTIME]")
    print(f"  GPU Hardware:       {diag['device_name'] or 'None detected'}")
    print(f"  VRAM:               {diag['vram_mb']} MB" if diag['vram_mb'] else "  VRAM:               N/A")
    print(f"  NVIDIA Driver:      {diag['driver_version'] or 'N/A'}")
    print(f"  CUDA Devices:       {ctranslate2.get_cuda_device_count()}")
    print(f"  CUDA Runtime OK:    {diag['cuda_runtime_ok']}")
    print(f"  CTranslate2 CUDA:   {diag['ctranslate2_cuda_ok']}")
    print(f"  GPU Ready:          {diag['gpu_ready']}")

    print("\n[REQUIRED CUDA LIBRARIES]")
    for lib, p in diag["library_paths"].items():
        status = "FOUND" if p else "MISSING"
        print(f"  {lib:<20} [{status}] {p or ''}")

    if diag["supported_compute_types"]:
        print(f"\n[SUPPORTED COMPUTE TYPES]\n  {', '.join(diag['supported_compute_types'])}")

    device, compute, _ = select_transcription_device_and_compute("auto", "auto")
    print(f"\n[DEFAULT SELECTION]\n  Device:       {device}\n  Compute Type: {compute}")

    if diag["failure_reason"]:
        print(f"\n[WARNING / FAILURE REASON]\n  {diag['failure_reason']}")

    print("\n=======================================================\n")

    return {
        "python": sys.version,
        "executable": sys.executable,
        "faster_whisper_version": faster_whisper.__version__,
        "ctranslate2_version": ctranslate2.__version__,
        "hf_cache": HF_CACHE_DIR,
        "diagnostic": diag,
        "selected_device": device,
        "selected_compute_type": compute,
    }


def main():
    parser = argparse.ArgumentParser(description="faster-whisper word-level transcription worker")
    parser.add_argument("--audio", help="Path to input audio file")
    parser.add_argument("--model", default=os.getenv("WHISPER_MODEL", "large-v3"), help="Whisper model name (tiny, base, small, medium, large-v3)")
    parser.add_argument("--device", default=os.getenv("WHISPER_DEVICE", "auto"), help="Device: auto, cuda, cpu")
    parser.add_argument("--compute_type", default=os.getenv("WHISPER_COMPUTE_TYPE", "auto"), help="Compute type: auto, float16, int8, float32")
    parser.add_argument("--output", help="Optional path to write JSON output")
    parser.add_argument("--diagnose", action="store_true", help="Run comprehensive environment diagnostic check")

    args = parser.parse_args()

    if args.diagnose:
        diag_res = run_diagnose_command()
        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump(diag_res, f, indent=2)
        sys.exit(0)

    if not args.audio:
        sys.stderr.write("[ERROR] Argument --audio is required when not running with --diagnose.\n")
        sys.exit(1)

    if not os.path.exists(args.audio):
        sys.stderr.write(f"[ERROR] Audio file not found: {args.audio}\n")
        sys.exit(1)

    try:
        result = transcribe_audio(
            args.audio,
            model_name=args.model,
            device=args.device,
            compute_type=args.compute_type,
        )

        output_json = json.dumps(result, indent=2, ensure_ascii=False)

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(output_json)
        else:
            print(output_json)

    except Exception as e:
        sys.stderr.write(f"[ERROR] Transcription failed: {e}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
