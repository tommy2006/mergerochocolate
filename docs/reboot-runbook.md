# Verda instance: bring everything back after a reboot or stop/start

**Survives a reboot (root disk):** `/root/run-vllm.sh` (Mergero model, key `vk_`), `/root/prenew.env` (Prenew key `pk_`), `/root/download-small3.py`, `/root/hfenv`, `/opt/mergero` + its `.env`, pm2 autostart of the app, Docker config.
**Lost (RAM disk `/mnt/models`):** model weights, the vLLM image, both model containers. Rebuilding them takes about 10 minutes and is one script.

## Steps
1. Verda console: the instance is running (start it if it was stopped). If its public IP is no longer `95.133.253.84`: `ssh root@NEW-IP`, change `BASE_URL` in `/opt/mergero/.env`, run `pm2 restart mergero`, then replace the IP in `docs/shared-model-endpoint.md` and `docs/prenew-model-endpoint.md` and tell the teams.
2. From the laptop (two commands, ~10 min, mostly downloads):
   ```bash
   scp scripts/verda-reboot.sh verda-mergero:/root/
   ```
   ```bash
   ssh verda-mergero 'bash /root/verda-reboot.sh'
   ```
   It prints `vllm-mistral ready`, `vllm-prenew ready`, the app's `/api/llm/status` line, then `DONE`.
3. Check from the laptop: http://95.133.253.84:3000 loads.
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://95.133.253.84:8000/v1/models; curl -s -o /dev/null -w "%{http_code}\n" http://95.133.253.84:8001/v1/models
   ```
   `401` twice means both model servers are up and asking for their keys.
4. Nothing changes for teammates: same addresses, same keys.

## If the script stops
- `vllm-… died` + a log tail: usually GPU memory still held by an old container. `docker ps -a`, `docker rm -f <name>`, run the script again.
- A download failed: run the script again; it skips what is already there.
- Instance deleted (spot reclaimed): create a new one with the same SSH key, then follow `docs/deploy-verda.md` (app) and `docs/verda-mistral-selfhost.md` (models), copy `/root/prenew.env` and `/root/run-vllm.sh` from your notes, then this runbook applies again.

## What the script does (manual equivalent)
1. `mount -t tmpfs -o size=220G tmpfs /mnt/models`; Docker data-root and containerd store on it; start Docker.
2. `/root/hfenv/bin/python /root/download-small3.py` (weights, ~48 GB).
3. `docker pull` the pinned vLLM image (~31 GB).
4. `bash /root/run-vllm.sh` → GPU 0, port 8000, Mergero key.
5. `docker run … vllm-prenew` → GPU 1, port 8001, key from `/root/prenew.env`.
6. Wait for `Application startup complete` in both, `pm2 restart mergero`, print `/api/llm/status`.

OCR packages (tesseract, poppler) live on the root disk and survive a reboot. After a rebuild of the instance, reinstall them (see `docs/deploy-verda.md`).
