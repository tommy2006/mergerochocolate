# Deploying the Origination Desk on a Verda instance

## 1. SSH key (already generated on this machine)

Private key: `~/.ssh/mergero_verda` (ed25519, never leaves your laptop). Public key: `~/.ssh/mergero_verda.pub` — paste it into **Verda → Account → SSH keys** (or into the instance's authorized keys when you create it).

Recommended SSH config (`~/.ssh/config`):

```
Host verda-mergero
    HostName <instance public IP>
    User <ubuntu or root, as Verda shows>
    IdentityFile ~/.ssh/mergero_verda
    IdentitiesOnly yes
```

Then: `ssh verda-mergero`. To add a passphrase later: `ssh-keygen -p -f ~/.ssh/mergero_verda`.

## 2. Instance setup (Ubuntu)

```bash
sudo apt-get update && sudo apt-get install -y git curl python3 python3-pip
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
git clone https://github.com/tommy2006/mergerochocolate.git mergero && cd mergero
npm install
pip3 install -r python/company-scraper/requirements.txt      # optional: Finnish profiler
cp .env.example .env && nano .env                            # keys: VERDA_*, LLM_PROVIDER=verda, RESEND_*, DEMO_EMAIL, BASE_URL=https://<host>
```

Run it as a service (keeps running after logout, restarts on reboot):

```bash
sudo npm install -g pm2
pm2 start server/index.js --name mergero
pm2 save && pm2 startup   # follow the printed command once
```

The app listens on `PORT` (3000). Put it behind Caddy or nginx for HTTPS, and set `BASE_URL` to the public URL so intake links, the `/demand` page and the Resend webhook resolve.

## 3. Verda-hosted model

On the instance the app can reach the Mistral container inside Verda's network the same way as from outside: `VERDA_BASE_URL=https://containers.datacrunch.io/<deployment>/v1` and `VERDA_API_KEY`. Check `curl -s http://localhost:3000/api/llm/status` after starting.

## 4. Data

State lives in `data/db.json` (or Postgres with `DATABASE_URL`). Back it up before demos: `cp data/db.json data/db.backup.json`.

## OCR for scanned statements (strict EU-only mode)
Brønnøysund's free statement copies are scans. Install once per instance so the Verda model can read them without Claude:

```bash
apt-get install -y tesseract-ocr tesseract-ocr-nor tesseract-ocr-fin tesseract-ocr-swe tesseract-ocr-dan poppler-utils
```
