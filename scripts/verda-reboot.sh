#!/usr/bin/env bash
# Bring the Verda instance back after a reboot or stop/start:
# RAM disk, Docker stores, model weights, both vLLM servers (GPU 0 -> :8000 Mergero, GPU 1 -> :8001 Prenew), the app.
# From the laptop:   scp scripts/verda-reboot.sh verda-mergero:/root/ && ssh verda-mergero 'bash /root/verda-reboot.sh'
# Safe to re-run: every step skips what is already in place.
set -euo pipefail
MODEL=mistralai/Mistral-Small-24B-Instruct-2501
IMG_TAG=vllm/vllm-openai:latest
# The exact image that worked on 2026-09-26 (vLLM 0.30.0, transformers 5.17.0). A newer "latest" could break the model.
IMG_PIN=vllm/vllm-openai@sha256:8a69ffad015f138d7170c4ddc429e230a3bc1c1719f67e14324749df200a4b90

echo "== 1/6 RAM disk for weights + Docker stores"
if ! mountpoint -q /mnt/models; then
  systemctl stop docker docker.socket containerd || true
  mkdir -p /mnt/models
  rm -rf /mnt/models/*   # whatever Docker created on the root disk while booting
  mount -t tmpfs -o size=220G tmpfs /mnt/models
  mkdir -p /mnt/models/hf /mnt/models/docker /mnt/models/containerd
  printf '{"data-root": "/mnt/models/docker"}\n' > /etc/docker/daemon.json
  if [ ! -L /var/lib/containerd ]; then rm -rf /var/lib/containerd; ln -s /mnt/models/containerd /var/lib/containerd; fi
  systemctl start containerd docker
fi
df -h /mnt/models | tail -1

echo "== 2/6 model weights (~48 GB; skipped when present)"
if [ ! -x /root/hfenv/bin/python ]; then python3 -m venv /root/hfenv && /root/hfenv/bin/pip install -q huggingface_hub; fi
/root/hfenv/bin/python /root/download-small3.py

echo "== 3/6 vLLM image (~31 GB; skipped when present)"
if ! docker image inspect "$IMG_TAG" >/dev/null 2>&1; then
  docker pull "$IMG_PIN"
  docker tag "$(docker image inspect "$IMG_PIN" --format '{{.Id}}')" "$IMG_TAG"
fi

echo "== 4/6 Mergero model: GPU 0, port 8000"
bash /root/run-vllm.sh

echo "== 5/6 Prenew model: GPU 1, port 8001"
set -a; . /root/prenew.env; set +a
docker rm -f vllm-prenew >/dev/null 2>&1 || true
docker run -d --name vllm-prenew --restart unless-stopped \
  --device nvidia.com/gpu=1 --ipc=host -p 0.0.0.0:8001:8000 \
  -v /mnt/models/hf:/root/.cache/huggingface/hub -e HF_HUB_OFFLINE=1 \
  "$IMG_TAG" --model "$MODEL" --served-model-name mistral-small-3 \
  --max-model-len 32768 --gpu-memory-utilization 0.90 --dtype bfloat16 \
  --host 0.0.0.0 --port 8000 --api-key "$PRENEW_AI_KEY" >/dev/null

echo "== 6/6 waiting for both models to load (2-4 min)"
for c in vllm-mistral vllm-prenew; do
  until docker logs "$c" 2>&1 | grep -q "Application startup complete"; do
    if ! docker ps --format '{{.Names}}' | grep -qx "$c"; then echo "$c died:"; docker logs --tail 30 "$c"; exit 1; fi
    sleep 10
  done
  echo "$c ready"
done
pm2 restart mergero >/dev/null 2>&1 || pm2 resurrect >/dev/null
sleep 3
curl -s http://127.0.0.1:3000/api/llm/status; echo
echo "DONE. App http://95.133.253.84:3000 | Mergero model :8000 | Prenew model :8001"
