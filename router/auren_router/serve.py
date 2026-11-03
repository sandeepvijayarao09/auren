"""The Auren Router on Modal: vLLM with the LoRA from train.py behind an
OpenAI-compatible /v1/chat/completions, kept warm. Ready to deploy; not deployed yet.

  modal secret create auren-router AUREN_ROUTER_KEY=<a long random string>
  AUREN_ROUTER_BASE=<base model> uv run --with modal modal deploy auren_router/serve.py

Then in Core's .env:
  AUREN_ROUTER_URL=https://<workspace>--auren-router-serve.modal.run/v1
  AUREN_ROUTER_KEY=<the same string>
  AUREN_ROUTER_MODEL=auren-router

The base model is required (AUREN_ROUTER_BASE), the same one the adapter was
trained on. Muse Glimmer's exact id isn't known yet, so there's no default.
One warm container (min_containers=1) keeps the first command under Core's
300 ms budget instead of waiting on a cold start.
"""

from __future__ import annotations

import os
import shlex
import sys
from pathlib import Path

try:
    import modal
except ModuleNotFoundError:  # the unit tests run without Modal
    modal = None

VOLUME = "auren-router"
PORT = 8000
BASE = os.environ.get("AUREN_ROUTER_BASE", "")
ADAPTER = os.environ.get("AUREN_ROUTER_ADAPTER", "auren-router")
# A small model; set AUREN_ROUTER_GPU if Glimmer turns out to need more.
GPU = os.environ.get("AUREN_ROUTER_GPU", "L40S")


def vllm_command(base: str, adapter: str = ADAPTER, port: int = PORT, max_lora_rank: int = 16) -> list[str]:
    """`vllm serve` with the LoRA as model `adapter`. The API key comes from VLLM_API_KEY, never argv."""
    if not base:
        raise ValueError("Set AUREN_ROUTER_BASE to the base model the adapter was trained on.")
    return [
        "vllm", "serve", base,
        "--host", "0.0.0.0", "--port", str(port),
        "--enable-lora", "--lora-modules", f"{adapter}=/vol/adapters/{adapter}", "--max-lora-rank", str(max_lora_rank),
        "--max-model-len", "2048",
        "--generation-config", "vllm",
    ]


if modal is not None:
    # Fail the deploy, not an import: `modal deploy` without a base would keep a broken container warm.
    if modal.is_local() and not BASE and Path(sys.argv[0]).name == "modal":
        raise SystemExit("Set AUREN_ROUTER_BASE to the base model the adapter was trained on.")
    app = modal.App("auren-router")
    image = (
        modal.Image.debian_slim(python_version="3.12")
        .pip_install("vllm>=0.11")  # lower bound; pin what worked after the first deploy
        # The container re-imports this file, so it needs the same settings.
        .env({"AUREN_ROUTER_BASE": BASE, "AUREN_ROUTER_ADAPTER": ADAPTER, "AUREN_ROUTER_GPU": GPU})
    )
    volume = modal.Volume.from_name(VOLUME, create_if_missing=True)

    @app.function(image=image, gpu=GPU, volumes={"/vol": volume}, secrets=[modal.Secret.from_name("auren-router")], min_containers=1, scaledown_window=15 * 60, timeout=24 * 3600)
    @modal.concurrent(max_inputs=32)
    @modal.web_server(port=PORT, startup_timeout=10 * 60)
    def serve():
        import subprocess

        env = {**os.environ, "VLLM_API_KEY": os.environ["AUREN_ROUTER_KEY"]}
        subprocess.Popen(shlex.join(vllm_command(BASE)), shell=True, env=env)
