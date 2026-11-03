"""QLoRA on Muse Glimmer for the Auren Router, on one Modal H100. Ready to run; not run yet.

  cd router
  uv run python -m auren_router.data build                     # data/train.jsonl, data/val.jsonl
  AUREN_ROUTER_BASE=<base model> uv run --with modal modal run auren_router/train.py --i-checked-the-terms

The base model is a required setting (--base or AUREN_ROUTER_BASE): a Hugging Face
repo id, or a path inside the `auren-router` Modal volume (mounted at /vol). We
don't know Muse Glimmer's exact id or repo yet, so nothing here guesses one.

TODO before the first run: check the Meta model API terms on training with model
outputs (the synthetic labels come from Muse Wonder). The run refuses to start
without --i-checked-the-terms.

Rows are chat-formatted on this Mac with auren_router.prompt, the same prompt Core
sends, as prompt/completion pairs so the loss falls on the JSON answer only. The
adapter lands in the volume at /vol/adapters/<name>, with meta.json recording the
base, the prompt's hash and the data counts; serve.py loads it from there.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

try:
    import modal
except ModuleNotFoundError:  # data prep and the unit tests run without Modal
    modal = None

VOLUME = "auren-router"
GPU = "H100"
# QLoRA settings. Small on purpose: four short fields out of a ~300-token prompt.
HPARAMS = {
    "lora_r": 16,
    "lora_alpha": 32,
    "lora_dropout": 0.05,
    "learning_rate": 2e-4,
    "per_device_batch": 8,
    "grad_accum": 2,
    "max_length": 1024,
    "warmup_ratio": 0.03,
}


def chat_rows(path: Path) -> list[dict]:
    """data/*.jsonl → prompt/completion rows. Runs locally, so the container never needs the prompt file."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from auren_router.data import read_jsonl
    from auren_router.prompt import training_row

    examples, bad = read_jsonl(path)
    if bad:
        raise SystemExit(f"{len(bad)} bad rows in {path}, first: {bad[0]}")
    return [training_row(e.text, e.context, e.label.to_json()) for e in examples]


def prompt_sha() -> str:
    return hashlib.sha256(Path(__file__).with_name("system_prompt.txt").read_bytes()).hexdigest()


def finetune(rows: list[dict], val_rows: list[dict], base: str, name: str, epochs: int, meta: dict) -> dict:
    """Runs in the container. Heavy imports stay in here."""
    import torch
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    from trl import SFTConfig, SFTTrainer

    tok = AutoTokenizer.from_pretrained(base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        base,
        quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.bfloat16),
        torch_dtype=torch.bfloat16,
        device_map="auto",
    )
    out = f"/vol/adapters/{name}"
    trainer = SFTTrainer(
        model=model,
        processing_class=tok,
        train_dataset=Dataset.from_list(rows),
        eval_dataset=Dataset.from_list(val_rows) if val_rows else None,
        peft_config=LoraConfig(r=HPARAMS["lora_r"], lora_alpha=HPARAMS["lora_alpha"], lora_dropout=HPARAMS["lora_dropout"], target_modules="all-linear", task_type="CAUSAL_LM"),
        args=SFTConfig(
            output_dir=out,
            num_train_epochs=epochs,
            per_device_train_batch_size=HPARAMS["per_device_batch"],
            gradient_accumulation_steps=HPARAMS["grad_accum"],
            learning_rate=HPARAMS["learning_rate"],
            lr_scheduler_type="cosine",
            warmup_ratio=HPARAMS["warmup_ratio"],
            max_length=HPARAMS["max_length"],
            bf16=True,
            gradient_checkpointing=True,
            logging_steps=10,
            eval_strategy="epoch" if val_rows else "no",
            save_strategy="no",
            report_to="none",
        ),
    )
    result = trainer.train()
    trainer.save_model(out)
    tok.save_pretrained(out)
    meta = {**meta, "train_loss": result.training_loss}
    Path(out, "meta.json").write_text(json.dumps(meta, indent=2))
    return meta


def check_settings(base: str, epochs: int, terms_checked: bool) -> None:
    if not terms_checked:
        raise SystemExit("TODO first: check the Meta model API terms on training with model outputs, then pass --i-checked-the-terms.")
    if not base:
        raise SystemExit("Set the base model with --base or AUREN_ROUTER_BASE (Muse Glimmer's id isn't known yet, so there's no default).")
    if epochs not in (1, 2):
        raise SystemExit("Train for 1 or 2 epochs.")


if modal is not None:
    app = modal.App("auren-router-train")
    image = modal.Image.debian_slim(python_version="3.12").pip_install(
        # Lower bounds only; pin what worked after the first run.
        "torch>=2.8",
        "transformers>=4.56",
        "peft>=0.17",
        "trl>=0.23",
        "bitsandbytes>=0.47",
        "accelerate>=1.10",
        "datasets>=4.0",
    )
    volume = modal.Volume.from_name(VOLUME, create_if_missing=True)
    # A gated base model needs a Hugging Face token: `modal secret create <name> HF_TOKEN=...`, then set AUREN_ROUTER_HF_SECRET=<name>.
    _secrets = [modal.Secret.from_name(os.environ["AUREN_ROUTER_HF_SECRET"])] if os.environ.get("AUREN_ROUTER_HF_SECRET") else []

    @app.function(image=image, gpu=GPU, volumes={"/vol": volume}, secrets=_secrets, timeout=3 * 3600)
    def train_remote(rows: list[dict], val_rows: list[dict], base: str, name: str, epochs: int, meta: dict) -> dict:
        meta = finetune(rows, val_rows, base, name, epochs, meta)
        volume.commit()
        return meta

    @app.local_entrypoint()
    def main(base: str = "", train: str = "data/train.jsonl", val: str = "data/val.jsonl", name: str = "auren-router", epochs: int = 2, i_checked_the_terms: bool = False):
        base = base or os.environ.get("AUREN_ROUTER_BASE", "")
        check_settings(base, epochs, i_checked_the_terms)
        rows = chat_rows(Path(train))
        val_rows = chat_rows(Path(val)) if Path(val).exists() else []
        meta = {"base": base, "name": name, "epochs": epochs, "train": len(rows), "val": len(val_rows), "prompt_sha256": prompt_sha(), **HPARAMS}
        print(f"Training {name} on {base}: {len(rows)} train, {len(val_rows)} val, {epochs} epoch(s), {GPU}")
        print(json.dumps(train_remote.remote(rows, val_rows, base, name, epochs, meta), indent=2))
