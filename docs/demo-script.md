# 3-minute demo script (5-minute slot incl. Q&A)

Open `https://mergero-abarofchocolate.vercel.app` full screen before you are called up (fallback `http://95.133.253.84:3000`). The front door is the presentation: move with the **→** key. No slides.

## 0:00–0:30 · Screen 1 "Why" (say it, don't read it)
> "Mergero told us origination is the bottleneck: mandates come person by person, and the owners worth talking to don't know yet that they want to sell. We built the engine that finds them first and opens the conversation for your advisors."

Point at the three numbers: 35,113 Norwegian companies in range, live from the register · owners worth a call this week · 3 minutes per company. **→**

## 0:30–1:05 · Screen 2 "Who to call"
> "This is an advisor's Monday. Every card is a real Norwegian company. The owner's age comes from the public register, not a guess. The score says how likely the owner is to be open to a first conversation, and every score comes with the reason and the evidence."

Point at the "Also screened, and deliberately not contacted" row:
> "It also tells you who *not* to call, and why. That's what keeps the outreach from feeling like spam."

Click the **Argus Remote Systems** card (owner 67, 30 years at the helm, readiness 60). Click it by name: ties at 60 sort by buyer fit, so Agromiljø may sit first.

## 1:05–2:10 · Screen 3 "The conversation" (the core)
1. **Why now** (left): "Two sentences an advisor can say out loud, and every fact links to its source."
2. **Buyers** (right): "Mandates in the MGX network want this profile. The email mentions the demand, never the names."
3. **Email** (middle): "Written from this company's own facts, in the advisor's voice. It never says 'sell' in a first touch, and a checker blocks anything that reads templated, which is exactly what Timo said failed before." Click **Approve & send**. It lands on your phone (demo mode); hold the phone up.
4. **Reply** (bottom): click the **Interested** sample → **Read this reply**. While it runs (~30 s), say:
   > "When the owner answers, an agent reads their own words, in any language, and moves the score."

   Point at the result: readiness jumps, timing becomes "now", and the exact phrases are quoted as evidence. **→**

*If the model is slow or offline:* go back (**←** All owners), open the rehearsal owner, whose score update is already on screen, point at it, and move on. Never wait in silence.

## 2:10–2:50 · Screen 4 "At scale"
> "Two advisors, 75 emails a day each under their own name, which is what Mergero said deliverability allows. With Mergero's own reply rate, 1,000 contacts give 475 conversations. That's about 500 owner conversations a month."

Drag one slider:
> "The last two rates are yours to judge; drag them."

> "It runs on an EU-hosted model, so owner data never leaves the EU, and it plugs into your Claude, MCP and database workflow and into MGX."

## 2:50–3:00 · Close on the pilot card
> "Six weeks, Norway, one sector, two advisors. We measure first calls booked against today. That's the pilot we'd like to run with you."

---

## Q&A: short answers
- **"Is the data real?"** Yes. Norwegian companies from Brønnøysund (owner birth dates from the roles register, filed accounts), website and filings crawled with sources. The buyer mandates are anonymised samples until MGX is connected (it has an API sync ready).
- **"Doesn't this become spam?"** Each advisor is capped at 75 a day. Nothing goes out without approval. The checker blocks templated or AI-sounding text. It deliberately skips owners who aren't ready.
- **"Why would an owner reply?"** The first email leads with concrete buyer demand for *their* kind of company, and offers the soft door (growth capital, a partner) before any talk of a sale.
- **"GDPR?"** Mergero said to skip it for the hackathon. For the pilot: legitimate interest for B2B, an opt-out, and EU-hosted processing (already the case).
- **"How is this different from a prospect database?"** Databases give rows. This gives a reason to call now, the evidence, matching buyers, a first email, and it learns from every reply.
- **"Other countries?"** Finland and Denmark registers are already connected; DACH works on LinkedIn plus calls. Sweden needs a data provider (no free API).
- **"What does it cost?"** Measured at about $1 and 3 minutes per fully researched company on Claude. On the self-hosted EU model it's the GPU hour.

## Before you go on stage
- [ ] Vercel URL loads and the top-right dot says **Live data** (not "Offline copy")
- [ ] The planned owner's email reads well and shows "Reads like a person"
- [ ] If anything on the instance breaks: `ssh verda-mergero 'cd /opt/mergero && pm2 stop mergero && tar xzf /opt/backups/demo-state-20260927-0230.tgz && pm2 start mergero'` restores the demo data
- [ ] Rehearse the reply on the **second** owner, never on the stage owner: a second reply starts from the already-raised score, so the jump on stage would be small. The rehearsal owner is your fallback if the model is slow.
- [ ] The stage owner's step-1 email is still unsent (Approve & send visible)
- [ ] Demo inbox open on your phone
- [ ] Browser zoom at 100–110%, full screen (F11), notifications off
