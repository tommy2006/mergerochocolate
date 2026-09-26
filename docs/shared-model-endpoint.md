# Shared Mistral endpoint for teammates

A Mistral Small 3 (24B) model runs on our Verda instance and is exposed as an OpenAI-compatible API. You need three things — nothing to install or deploy:

| | Value |
|---|---|
| Base URL | `http://95.133.253.84:8000/v1` |
| Model name | `mistral-small-3` |
| API key | ask Dang (starts with `vk_`) |

## Use it

**curl**
```bash
curl http://95.133.253.84:8000/v1/chat/completions \
  -H "Authorization: Bearer $MISTRAL_KEY" -H "Content-Type: application/json" \
  -d '{"model":"mistral-small-3","messages":[{"role":"user","content":"Say hello in Finnish."}],"max_tokens":50}'
```

**Python (openai package)**
```python
from openai import OpenAI
client = OpenAI(base_url="http://95.133.253.84:8000/v1", api_key=MISTRAL_KEY)
r = client.chat.completions.create(model="mistral-small-3", messages=[{"role": "user", "content": "Say hello in Finnish."}])
print(r.choices[0].message.content)
```

**Node (openai package)**
```js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://95.133.253.84:8000/v1", apiKey: process.env.MISTRAL_KEY });
const r = await client.chat.completions.create({ model: "mistral-small-3", messages: [{ role: "user", content: "Say hello in Finnish." }] });
console.log(r.choices[0].message.content);
```

Any framework with an "OpenAI-compatible" or "custom base URL" option works the same way (LangChain, LiteLLM, Vercel AI SDK, …).

## Good to know
- Structured JSON: pass `response_format: {"type": "json_schema", "json_schema": {"name": "x", "schema": {...}}}` or `{"type": "json_object"}`.
- Context window 32k tokens; ~10 s for a long structured answer, ~1 s for short ones. The model is shared — keep batch jobs modest.
- Plain HTTP on an IP: fine for the hackathon, don't send anything you'd mind seeing in a log.
- It's a Spot instance: if it goes away, so does the endpoint until it's rebuilt (5-minute recipe in `verda-mistral-selfhost.md`).
