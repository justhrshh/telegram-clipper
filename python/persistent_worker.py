import sys
import os
import json
import time
import traceback

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

import ctranslate2
import faster_whisper

# Global model reference kept resident in VRAM
GLOBAL_MODEL = None
GLOBAL_DEVICE = "cpu"
GLOBAL_COMPUTE = "int8"
GLOBAL_MODEL_NAME = "large-v3"

def send_json(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def log(msg):
    sys.stderr.write(f"[persistent-worker] {msg}\n")
    sys.stderr.flush()

def init_model(model_name="large-v3", preferred_device="auto", preferred_compute="auto"):
    global GLOBAL_MODEL, GLOBAL_DEVICE, GLOBAL_COMPUTE, GLOBAL_MODEL_NAME
    
    t0 = time.time()
    GLOBAL_MODEL_NAME = model_name

    # Determine device
    has_cuda = False
    try:
        has_cuda = ctranslate2.get_cuda_device_count() > 0
    except Exception as e:
        log(f"CUDA check error: {e}")

    if preferred_device == "cpu" or not has_cuda:
        selected_device = "cpu"
        selected_compute = "int8" if preferred_compute in ["auto", "int8"] else preferred_compute
    else:
        selected_device = "cuda"
        if preferred_compute in ["auto", "int8_float16"]:
            selected_compute = "int8_float16"
        elif preferred_compute in ["float16", "int8"]:
            selected_compute = preferred_compute
        else:
            selected_compute = "float16"

    log(f"Initializing WhisperModel '{model_name}' on device='{selected_device}', compute_type='{selected_compute}'...")

    try:
        GLOBAL_MODEL = faster_whisper.WhisperModel(
            model_name,
            device=selected_device,
            device_index=0 if selected_device == "cuda" else 0,
            compute_type=selected_compute,
            download_root=HF_CACHE_DIR,
        )
        GLOBAL_DEVICE = selected_device
        GLOBAL_COMPUTE = selected_compute
        load_time = time.time() - t0
        log(f"Model '{model_name}' loaded in {load_time:.2f}s on {selected_device}/{selected_compute}")
        return True, load_time, None
    except Exception as e:
        err_msg = str(e)
        log(f"Failed to initialize on {selected_device}/{selected_compute}: {err_msg}")
        if selected_device == "cuda":
            log("Attempting fallback to cpu/int8...")
            try:
                GLOBAL_MODEL = faster_whisper.WhisperModel(
                    model_name,
                    device="cpu",
                    compute_type="int8",
                    download_root=HF_CACHE_DIR,
                )
                GLOBAL_DEVICE = "cpu"
                GLOBAL_COMPUTE = "int8"
                load_time = time.time() - t0
                log(f"Model '{model_name}' loaded on CPU fallback in {load_time:.2f}s")
                return True, load_time, f"Fallback from CUDA: {err_msg}"
            except Exception as cpu_err:
                log(f"CPU fallback also failed: {cpu_err}")
                return False, 0, str(cpu_err)
        return False, 0, err_msg

def transcribe(audio_path, beam_size=1, vad_filter=True):
    if GLOBAL_MODEL is None:
        raise RuntimeError("Whisper model is not initialized")

    t0 = time.time()
    segments, info = GLOBAL_MODEL.transcribe(
        audio_path,
        beam_size=beam_size,
        word_timestamps=True,
        vad_filter=vad_filter,
    )

    words = []
    seg_list = []

    for seg in segments:
        seg_data = {
            "id": seg.id,
            "seek": seg.seek,
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": seg.text,
            "avg_logprob": round(seg.avg_logprob, 3),
            "compression_ratio": round(seg.compression_ratio, 3),
            "no_speech_prob": round(seg.no_speech_prob, 3),
        }
        if seg.words:
            seg_words = []
            for w in seg.words:
                w_obj = {
                    "word": w.word,
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "probability": round(w.probability, 3),
                }
                words.append(w_obj)
                seg_words.append(w_obj)
            seg_data["words"] = seg_words
        seg_list.append(seg_data)

    infer_time = time.time() - t0
    return {
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 3),
        "word_count": len(words),
        "words": words,
        "segments": seg_list,
        "inference_time_s": round(infer_time, 3),
        "device": GLOBAL_DEVICE,
        "compute_type": GLOBAL_COMPUTE,
        "model": GLOBAL_MODEL_NAME,
    }

def main():
    # Read initial arguments if provided
    model_name = os.environ.get("WHISPER_MODEL", "large-v3")
    device = os.environ.get("WHISPER_DEVICE", "auto")
    compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "auto")

    success, load_time, err = init_model(model_name, device, compute_type)
    if not success:
        send_json({
            "status": "error",
            "error": err or "Failed to initialize Whisper model",
        })
        sys.exit(1)

    send_json({
        "status": "ready",
        "device": GLOBAL_DEVICE,
        "compute_type": GLOBAL_COMPUTE,
        "model": GLOBAL_MODEL_NAME,
        "load_time_s": round(load_time, 2),
    })

    # Main IPC loop over stdin
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except Exception as json_err:
            send_json({"status": "error", "error": f"Invalid JSON: {json_err}"})
            continue

        req_id = req.get("id")
        action = req.get("action", "transcribe")

        if action == "ping":
            send_json({
                "id": req_id,
                "status": "pong",
                "device": GLOBAL_DEVICE,
                "compute_type": GLOBAL_COMPUTE,
                "model": GLOBAL_MODEL_NAME,
            })
            continue

        if action == "transcribe":
            audio_path = req.get("audio")
            if not audio_path or not os.path.isfile(audio_path):
                send_json({
                    "id": req_id,
                    "status": "error",
                    "error": f"Audio file not found: {audio_path}",
                })
                continue

            beam_size = req.get("beam_size", 1)
            vad_filter = req.get("vad_filter", True)

            try:
                result = transcribe(audio_path, beam_size=beam_size, vad_filter=vad_filter)
                send_json({
                    "id": req_id,
                    "status": "ok",
                    "result": result,
                })
            except Exception as tr_err:
                log(f"Transcription error on {audio_path}: {traceback.format_exc()}")
                send_json({
                    "id": req_id,
                    "status": "error",
                    "error": str(tr_err),
                })
            continue

        send_json({
            "id": req_id,
            "status": "error",
            "error": f"Unknown action: {action}",
        })

if __name__ == "__main__":
    main()
