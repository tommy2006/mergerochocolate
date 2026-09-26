# Self-hosting Mistral on a Verda GPU instance (reusable recipe)

Works for any app that can talk to an OpenAI-compatible endpoint. Tested 2026-09-26 on a Verda `2H200.141S.88V` spot instance (Ubuntu 26.04, 2×H200, 334 GB RAM, 50 GB root disk).

## 0. Before you start
- An SSH key registered in Verda (`ssh-keygen -t ed25519 -f ~/.ssh/<name>`; paste the `.pub` into Verda → SSH keys).
- A GPU instance (one H200/H100 is enough for a 24B model). No Hugging Face token is needed for `mistralai/Mistral-Small-24B-Instruct-2501` (Apache-2.0, not gated).

## 1. The small root disk problem
The 50 GB root disk cannot hold the vLLM image (31 GB) plus a 24B model (48 GB). The instance has hundreds of GB of RAM, so use a RAM disk (lost on reboot — spot instances reboot anyway; re-running this recipe takes ~5 minutes):

```bash
mkdir -p /mnt/models && mount -t tmpfs -o size=220G tmpfs /mnt/models && mkdir -p /mnt/models/hf
# Docker 29 keeps images in containerd's store; move both stores onto the RAM disk
systemctl stop docker docker.socket containerd
mkdir -p /mnt/models/docker && mv /var/lib/docker/* /mnt/models/docker/ 2>/dev/null; printf '{"data-root": "/mnt/models/docker"}\n' > /etc/docker/daemon.json
mv /var/lib/containerd /mnt/models/containerd && ln -s /mnt/models/containerd /var/lib/containerd
systemctl start containerd docker
```

## 2. Model weights (≈48 GB, a minute or two on Verda's network)
```bash
python3 -m venv /root/hfenv && /root/hfenv/bin/pip install -q huggingface_hub
/root/hfenv/bin/python - <<'EOF'
from huggingface_hub import snapshot_download
print(snapshot_download("mistralai/Mistral-Small-24B-Instruct-2501", cache_dir="/mnt/models/hf",
  allow_patterns=["model*.safetensors","model.safetensors.index.json","config.json","generation_config.json","tokenizer*","special_tokens_map.json"]))
EOF
```
Note: Mistral Small **3.2** (multimodal) does not load in the current `vllm/vllm-openai:latest` (transformers 5 renamed a Pixtral class). Use the text-only 2501 model, or pin an older vLLM image.

## 3. vLLM server (OpenAI-compatible, port 8000, GPU 0)
```bash
docker pull vllm/vllm-openai:latest
docker run -d --name vllm-mistral --restart unless-stopped \
  --device nvidia.com/gpu=0 --ipc=host -p 127.0.0.1:8000:8000 \
  -v /mnt/models/hf:/root/.cache/huggingface/hub -e HF_HUB_OFFLINE=1 \
  vllm/vllm-openai:latest \
  --model mistralai/Mistral-Small-24B-Instruct-2501 --served-model-name mistral-small-3 \
  --max-model-len 32768 --gpu-memory-utilization 0.90 --dtype bfloat16 --host 0.0.0.0 --port 8000
docker logs -f vllm-mistral        # wait for "Application startup complete" (2–4 min)
curl -s http://127.0.0.1:8000/v1/models
```
Structured JSON works with `response_format: {"type":"json_schema", ...}` (vLLM guided decoding) and `{"type":"json_object"}`.

## 4. Point your app at it
Any OpenAI SDK/client: base URL `http://127.0.0.1:8000/v1`, any non-empty API key, model `mistral-small-3`. In the Mergero app: `LLM_PROVIDER=verda`, `VERDA_BASE_URL=http://127.0.0.1:8000/v1`, `VERDA_MODEL=mistral-small-3`, `VERDA_API_KEY=local-vllm`.

## 5. After a reboot
Run `scripts/verda-reboot.sh` (see `docs/reboot-runbook.md`); it repeats steps 1–3 for both GPUs and restarts the app.
