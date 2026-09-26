# Prenew team — your AI endpoint

A private Mistral Small 3 (24B) runs on Dang's Verda GPU instance for the Prenew team. It speaks the OpenAI API. You need three values, nothing to install:

| | Value |
|---|---|
| Base URL | `http://95.133.253.84:8001/v1` |
| Model name | `mistral-small-3` |
| API key | from Dang, starts with `pk_` |

## In Scout (the Prenew app)
Settings (gear icon) → **Search AI** → card **Your GPU server** (Son's version) or **Custom** (Mike's version):

- Address: `http://95.133.253.84:8001/v1`
- API key: the `pk_` key from Dang
- Model: `mistral-small-3` (type it, or press *Load models* and pick it). The default `scout` does not exist on this server.
- **Test**, then **Save**. Under **Writing AI** leave *Same as the search AI* (or pick the same card).

Terminal check (Son's version): `.venv/Scripts/python scripts/check_keys.py` → `AI: OK`.
Or in `.env`: `GPU_SERVER_URL=http://95.133.253.84:8001/v1` and `GPU_SERVER_API_KEY=<pk_ key>` (Son's version only; the model name still has to be set in Settings).

## Use it

**curl**
```bash
curl http://95.133.253.84:8001/v1/chat/completions \
  -H "Authorization: Bearer $PRENEW_AI_KEY" -H "Content-Type: application/json" \
  -d '{"model":"mistral-small-3","messages":[{"role":"user","content":"Say hello in Finnish."}],"max_tokens":50}'
```

**Python (openai package)**
```python
from openai import OpenAI
client = OpenAI(base_url="http://95.133.253.84:8001/v1", api_key=PRENEW_AI_KEY)
r = client.chat.completions.create(model="mistral-small-3", messages=[{"role": "user", "content": "Say hello in Finnish."}])
print(r.choices[0].message.content)
```

**Node (openai package)**
```js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://95.133.253.84:8001/v1", apiKey: process.env.PRENEW_AI_KEY });
const r = await client.chat.completions.create({ model: "mistral-small-3", messages: [{ role: "user", content: "Say hello in Finnish." }] });
console.log(r.choices[0].message.content);
```

**Any OpenAI-SDK app via environment variables**
```
OPENAI_API_KEY=<the pk_ key>
OPENAI_BASE_URL=http://95.133.253.84:8001/v1
```
and use `mistral-small-3` as the model name.

## Good to know
- JSON output: `response_format: {"type":"json_object"}` or `{"type":"json_schema","json_schema":{...}}`.
- 32k context. ~1 s for short answers, ~10 s for long structured ones.
- Plain HTTP on an IP: fine for the hackathon; don't send secrets.
- It's a Spot instance: if it reboots, the endpoint is down until Dang rebuilds it (5 minutes).
