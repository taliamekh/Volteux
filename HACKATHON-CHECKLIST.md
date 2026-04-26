# Talia — Volteux Hackathon Production Checklist

**Goal:** Full production deployed at <https://volteux.com> by 9:30 AM.

**Scope:** This is **your** checklist (UI/Frontend track owner). Kai owns the backend track separately — only "what to ask Kai" appears here.

---

## Legend

### Status

| Mark | Meaning |
|------|---------|
| `[x]` | Done |
| `[ ]` | Pending |
| `[~]` | In progress |
| `[!]` | Blocked |

### Who executes (ownership marker)

| Marker | Meaning |
|--------|---------|
| **(M)** | Manual — only you can do it |
| **(C)** | Claude in this chat does it for you |
| **(A)** | A background agent does it |
| **(K)** | Waiting on Kai |
| **(M+C)** | You decide, Claude executes |
| **(M+K)** | Joint with Kai |

---

## Section 0 — Status snapshot (already done)

- [x] **(M+C)** HTML mockup ported to React app at `react-router-app/` (running at <http://localhost:5173>)
- [x] **(M+C)** All 4 views wired with state machine (Empty / Loading / Main / Honest Gap)
- [x] **(M+C)** Mocked pipeline (uses fixture, simulates 10 s loading) — replaceable with real backend
- [x] **(M+C)** Fake flash flow with progress + success overlay — replaceable with real Web Serial
- [x] **(M+C)** Honest Gap card detects 5 trigger categories
- [x] **(M+C)** Parts checklist with "I have it" toggle
- [x] **(M+C)** Sticky CTA + see-finished-project link
- [x] **(M+C)** Tagline: *"Type your idea. We'll build it."*
- [x] **(M+C)** Slate-blue dark theme + violet accent + DM Serif + Exo 2 + Inter + JetBrains Mono
- [x] **(M+C)** Refine bar (in-place tweak input)
- [x] **(M+C)** Honest scope strip (`Today: Arduino Uno · Coming soon: ...`)
- [x] **(A)** Hackathon pitch script → [`repo/PITCH.md`](./PITCH.md)
- [x] **(A)** Vultr setup guide for Kai → [`repo/VULTR-SETUP.md`](./VULTR-SETUP.md)
- [x] **(M+C)** This checklist + [`HANDOFF.md`](./HANDOFF.md)
- [x] **(M+C)** Schema v0.1 signoff
- [x] **(M+C)** All design + plan changes pushed to GitHub

---

## Section 1 — Decisions locked (no more deciding)

- [x] **Build path:** React app (already built at `react-router-app/`)
- [x] **Frontend deploy:** Vercel (free, custom domain `volteux.com` via Cloudflare DNS)
- [x] **Backend deploy:** Vultr — Kai owns; qualifies for Best Use of Vultr prize
- [x] **Demo prompts:** "robot arm waves" / "desk lamp on hand-over" / "parking sensor beeps"
- [x] **Honest Gap demo prompt:** "I want to weigh things with a load cell"
- [x] **Real Arduino Uno** for live flash demo (you have one)

---

## Section 2 — What you need from Kai

### 2a. Send to Kai

- [ ] **(M)** Send Kai the file [`repo/VULTR-SETUP.md`](./VULTR-SETUP.md) (text / Slack / link — your choice)
- [ ] **(M)** Get the **Vultr $100 gift code** from the MLH coach and pass it to Kai

### 2b. Blockers — waiting on Kai

These are blocking your downstream work. Track each so you know what's holding you up.

- [ ] **(K) Kai's backend at a public HTTPS URL** (e.g. `https://api.volteux.com`)
  - *Without this:* you can't replace the mocked pipeline with real fetch
- [ ] **(K) Kai's `POST /api/generate` endpoint** working — returns `VolteuxProjectDocument` or `HonestGap`
  - *Without this:* prompts can't reach the real LLM
- [ ] **(K) Kai's `POST /api/compile` endpoint** working — returns `.hex` artifact
  - *Without this:* you can't do real Web Serial flash
- [ ] **(K) Kai's CORS configured** for `https://volteux.com` (and your Vercel preview URLs)
  - *Without this:* the browser will block your fetch calls
- [ ] **(K) Kai's `avrgirl-arduino` + Web Serial spike succeeds** on a real Uno
  - *Without this:* real flash is impossible — fall back to fake flash for demo

### 2c. Joint with Kai

- [ ] **(M+K)** Reconfirm Day-1 schema signoff (already in CHANGELOG; quick verbal check)
- [ ] **(M+K)** Confirm with Kai: should the LLM prompt produce sketches with **line-by-line teaching comments**? (was a v0 TODO; he owns the prompt change)

---

## Section 3 — Your hands-on tasks (only you can do these)

These are not delegable to Claude or any agent.

- [ ] **(M)** Get the Vultr gift code from the MLH coach (in person at the venue)
- [ ] **(M)** Send the gift code + [`VULTR-SETUP.md`](./VULTR-SETUP.md) to Kai
- [ ] **(M)** Rehearse the pitch in [`PITCH.md`](./PITCH.md) out loud at least 3 times
- [ ] **(M)** Plug in your Arduino Uno + USB cable; keep it ready for the live demo
- [ ] **(M)** Test the live deployed site on your phone (catch mobile bugs)
- [ ] **(M)** Record a screen recording of the full demo flow (backup if live crashes)
- [ ] **(M)** Bookmark `https://volteux.com` on your phone for the demo
- [ ] **(M)** Take a 30-minute break before the demo (fresh head matters)
- [ ] **(M)** Walk on stage and deliver the pitch
- [ ] **(M)** Submit the project to the MLH platform (Agent F preps the checklist)

---

## Section 4 — UI/Frontend production work

You own this whole section. Claude or agents execute; you approve and direct.

### 4a. Pre-deploy (blocks deployment — do first)

- [ ] **(C)** Move `react-router-app/` → `repo/frontend/` so Vercel can auto-deploy on git push
- [ ] **(C)** Update tsconfig + Vite config paths after move (if anything references absolute paths)
- [ ] **(C)** Run typecheck + dev server in new location to confirm nothing broke
- [ ] **(M)** Approve the move; Claude commits + pushes to GitHub

### 4b. Replace mocks with real backend *(after Kai's backend is at a public URL)*

- [ ] **(A)** Spawn **Agent B** — replace mocked `startBuild()` in `home.tsx` with real `fetch` to `POST /api/generate`
- [ ] **(C)** Validate response with `VolteuxProjectDocumentSchema` from [`repo/schemas/document.zod.ts`](./schemas/document.zod.ts)
- [ ] **(C)** Handle `HonestGap` envelope (`scope: 'out-of-scope' | 'partial'`)
- [ ] **(C)** Surface backend errors through the error boundary (no silent failures)

### 4c. Replace fake flash with real Web Serial *(after Kai's spike succeeds)*

- [ ] **(A)** Spawn **Agent C** — integrate `avrgirl-arduino` + Web Serial in `home.tsx`
- [ ] **(C)** Call `POST /api/compile` to get the `.hex` base64
- [ ] **(C)** `avrgirl` writes to the Uno over Web Serial
- [ ] **(M)** Test with your real Uno before the demo

### 4d. Missing interaction states (currently absent or stubbed)

- [ ] **(A)** Spawn **Agent D** — generic error boundary (network/backend failure) with "Try again" + `mailto:` recovery
- [ ] **(A)** Spawn **Agent D** — browser-not-Chromium full-screen explainer (detect via Web Serial feature test)
- [ ] **(A)** Spawn **Agent D** — mobile-detected full-screen explainer (viewport width check)
- [ ] **(A)** Spawn **Agent D** — localStorage-disabled inline banner
- [ ] **(C)** URL hash persistence — serialize document to `base64+gzip` on success, restore on page load
- [ ] **(C)** Share button — POST to backend share service, get short URL, copy to clipboard, toast confirmation
- [ ] **(C)** Real keyboard navigation through 3D scene (`Tab` cycles components, `Enter` selects, `Esc` clears)
- [ ] **(C)** ARIA live region announces selected component's `education_blurb` for screen readers
- [ ] **(C)** Verify color contrast WCAG AA on all violet-on-dark text/icons

### 4e. Real component photos *(was a v0 TODO — pulled into hackathon)*

- [ ] **(A)** Spawn **Agent E** — find Adafruit product photos for SKUs `50`, `3942`, `169`, `239`, `758`
- [ ] **(C)** Add `thumbnail_url` field to each entry in [`components/registry.ts`](./components/registry.ts) — coordinate with Kai (this is the merge-conflict file)
- [ ] **(C)** Replace emoji thumbnails (🔧 📡 ⚙️) in parts list with `<img>` tags reading from registry
- [ ] **(M)** Eyeball the photos at thumbnail size — accept or re-source

### 4f. Deployment

- [ ] **(A)** Spawn **Agent A** — set up Vercel project pointing at `repo/frontend/`, configure monorepo subfolder build
- [ ] **(M)** Sign up for Vercel (use GitHub login) if you don't have an account
- [ ] **(M)** In Cloudflare DNS dashboard: add the CNAME records Vercel gives you (points `volteux.com` → Vercel)
- [ ] **(M)** Verify `https://volteux.com` loads after DNS propagates (5-30 min)
- [ ] **(M)** Bookmark `https://volteux.com` on your phone

### 4g. Post-deploy polish (verify in production)

- [ ] **(M)** Test the deployed site end-to-end on Chrome (laptop)
- [ ] **(M)** Test on phone — desktop-only fallback should show cleanly
- [ ] **(M)** Test in non-Chromium browser (Firefox/Safari) — fallback should show
- [ ] **(M)** Test the live flash with your real Uno
- [ ] **(M)** Test Honest Gap with the load-cell prompt
- [ ] **(M)** Verify the 3 example chips all produce a real generated project

---

## Section 5 — Agents to spawn

**Strategy:** spawn agents in **parallel** within a single message. Each prompt is self-contained. Most return in 2-3 minutes. Don't spawn more than 4 at a time to keep context manageable.

---

### Agent A — Vercel deploy scout

- **When:** as soon as the React app is moved into `repo/frontend/`
- **Returns:** deployed Vercel URL + DNS records to add to Cloudflare
- **Dependencies:** none

**Prompt to give it:**

> Set up a Vercel deployment for the React app at `C:/Users/talia/OneDrive/CODING/Volteux/repo/frontend/`. The user is non-technical and on Windows. Custom domain target: `volteux.com` (DNS managed by Cloudflare). Walk through every step:
> 1. Install Vercel CLI on Windows
> 2. Link the project
> 3. Configure monorepo subdirectory build (only watches `frontend/`)
> 4. Deploy
> 5. Add custom domain in Vercel dashboard
> 6. Tell Talia exactly which CNAME records to add to Cloudflare DNS
>
> Do as much yourself as possible. Return the deployed URL plus any steps Talia must take. Under 400 words.

---

### Agent B — Backend integration helper

- **When:** *only* after Kai confirms his Hono server is reachable at a public HTTPS URL
- **Returns:** code diff for `home.tsx`
- **Dependencies:** Kai's backend live

**Prompt to give it:**

> Read `C:/Users/talia/OneDrive/CODING/Volteux/repo/frontend/app/routes/home.tsx`. Replace the mocked `startBuild()` function with a real `fetch` call to `KAI_BACKEND_URL/api/generate`. The backend returns either a `VolteuxProjectDocument` (success) or a `HonestGap` envelope. Validate the response with `VolteuxProjectDocumentSchema` from `repo/schemas/document.zod.ts`. Show me the exact code diff. Under 250 words.
>
> Backend URL: `[TALIA FILLS IN]`

---

### Agent C — Hardware flash integration

- **When:** *only* after Kai's WebSerial spike succeeds on a real Uno
- **Returns:** code diff adding real flash
- **Dependencies:** Kai's spike + `Agent B` already complete

**Prompt to give it:**

> Add real browser-direct flashing to `C:/Users/talia/OneDrive/CODING/Volteux/repo/frontend/app/routes/home.tsx`. Use `avrgirl-arduino` + Web Serial. The flow:
> 1. Call backend `/api/compile` to get the `.hex` artifact base64
> 2. Decode
> 3. `avrgirl` writes it to the Uno over Web Serial
> 4. Success overlay shows
>
> Replace the fake `setInterval` flash progress with the real avrgirl progress events. Reference <https://github.com/noopkat/avrgirl-arduino> for the API. Under 300 words.

---

### Agent D — Error + fallback states

- **When:** anytime — doesn't depend on Kai
- **Returns:** code for 4 missing states
- **Dependencies:** none

**Prompt to give it:**

> Add four missing interaction states to `C:/Users/talia/OneDrive/CODING/Volteux/repo/frontend/app/routes/home.tsx` and `app.css`:
> 1. **Generic error boundary** (network/backend failure) with "Try again" + `mailto:` recovery
> 2. **Browser-not-Chromium full-screen explainer** (detect via feature test for Web Serial: `'serial' in navigator`)
> 3. **Mobile-detected full-screen explainer** (viewport `<768px`)
> 4. **localStorage-disabled inline banner** (`try/catch` on init)
>
> Match the existing slate-blue + violet design system. Show me the diff for each. Under 400 words.

---

### Agent E — Real component photos

- **When:** anytime
- **Returns:** 5 image URLs
- **Dependencies:** none

**Prompt to give it:**

> Find direct Adafruit product photo URLs for:
> - SKU 50 (Arduino Uno R3)
> - SKU 3942 (HC-SR04 ultrasonic sensor)
> - SKU 169 (Micro Servo SG90)
> - SKU 239 (full-size breadboard 830 holes)
> - SKU 758 (jumper wires 40×6 inch)
>
> Need PNG or JPG, ideally on neutral background. Return direct image URLs and license note (Adafruit usually permits product imagery for resellers/educational use; flag any exceptions). Under 200 words.

---

### Agent F — MLH submission checklist

- **When:** spawn ~2 hours **before** 9:30 AM deadline
- **Returns:** numbered submission prep list
- **Dependencies:** none

**Prompt to give it:**

> I'm submitting Volteux to an MLH hackathon at 9:30 AM. Walk me through what MLH-hosted hackathons typically require:
> - Project description
> - Demo video
> - Deployed URL
> - Repo URL
> - Team info
> - Screenshots
> - MLH challenge prizes (we're claiming Best Use of Vultr)
>
> Return a numbered submission prep list with estimated time per item and which fields are usually required vs optional. Under 250 words.

---

## Section 6 — Visual decisions still open

Most of the 28 design decisions from `PLAN.md` are **locked**. These few remain:

- [ ] **(M+C)** **3D scene aesthetic** — currently a stylized SVG fake. For production: real Three.js with placeholder geometry, or keep the SVG fake?
  > **Recommendation:** keep SVG for hackathon. Real R3F is post-hackathon work.
- [ ] **(M+C)** **Lighting on the 3D scene** — moot if we keep the SVG fake
- [ ] **(M+C)** **Component rotation when clicked** — currently no animation
  > **Recommendation:** static for hackathon (less code, less risk)
- [ ] **(M+C)** **First-visit hint copy** — currently "Click any part to learn what it does." Keep or change?
- [ ] **(M+C)** **Honest Gap voice tone** — 5 trigger messages already written. Read them and tweak any that feel off
- [ ] **(M+C)** **Color contrast verification** — does violet on slate-blue meet WCAG AA at every size?
- [ ] **(M+C)** **Touch targets** — 44 px minimum on 3D click hotspots. Verify after deploy on a real touch device

---

## Section 7 — TODOs we added

### 7a. Pulled into hackathon (now in Section 4)

- [x] Real component photos in parts list *(was v0 TODO)* — see [Section 4e](#4e-real-component-photos-was-a-v0-todo--pulled-into-hackathon)
- [x] Generated sketch teaching comments *(was v0 TODO)* — see [Section 2c](#2c-joint-with-kai)

### 7b. Stays as roadmap (use as "what's next" pitch slide content)

**Do NOT promise these as built.** They're real, captured TODOs in [`repo/TODOS.md`](./TODOS.md) — reference them in the pitch but don't add them to the build.

- [ ] **Manual editing & AI-assisted wiring (v1.5+)** — drag-drop wiring editor with AI completion
- [ ] **Custom complex projects + AI-generated STL + assembly view (v2+)** — drones, robotic arms, exploded-view animation
- [ ] **Long-term hardware breadth: thousands of microcontrollers (v2+)** — beyond 4 boards / 25 components

---

## Section 8 — Demo day logistics

### 8a. Pitch

- [ ] **(M)** Read [`repo/PITCH.md`](./PITCH.md)
- [ ] **(M)** Rehearse the 2-minute pitch out loud 3+ times
- [ ] **(M)** Rehearse the 30-second cold-open variant
- [ ] **(M)** Read the Q&A prep section (likely market / moat / what's-next questions)
- [ ] **(M)** Decide: live demo only, or live demo + slide deck?
  > **Recommendation:** live demo only for hackathon

### 8b. Equipment for your demo table

- [ ] **(M)** Laptop (charged, browser open to <https://volteux.com>)
- [ ] **(M)** Arduino Uno + USB cable plugged into laptop
- [ ] **(M)** HC-SR04 sensor + servo wired up so the demo project actually runs after flash
- [ ] **(M)** Phone with the deployed URL bookmarked (in case laptop dies)
- [ ] **(M)** Backup screen recording (in case live demo crashes)
- [ ] **(M)** Notes with the deployed URL written down (don't trust memory under pressure)

### 8c. Judge flow — memorize these 10 steps

1. Open <https://volteux.com> — show the landing page (sells the vision)
2. Click an example chip OR type a prompt
3. Loading runs ~10-15 sec (real backend hits Anthropic)
4. Main view appears with all 4 panels rendered from the real generated document
5. Click around the 3D scene — show the click-to-learn callouts
6. Show the Code panel scrolling through commented Arduino code
7. Show the parts checklist with "I have it" toggle
8. Click **Flash to my Uno** — real Web Serial flash to the connected Uno
9. Servo waves on your desk
10. *(Optional)* Type a load-cell prompt to demo Honest Gap, then close with the v1.5 + v2+ vision

---

## Section 9 — MLH submission

- [ ] **(A)** Spawn **Agent F** at ~7:30 AM for the full submission checklist
- [ ] **(M)** Project description (2-3 sentences pitching Volteux)
- [ ] **(M)** Demo video link (your backup screen recording)
- [ ] **(M)** Deployed URL: <https://volteux.com>
- [ ] **(M)** Repo URL: <https://github.com/taliamekh/Volteux>
- [ ] **(M)** Team info (you + Kai, names, emails)
- [ ] **(M)** Screenshots — 3-4 of the live deployed product
- [ ] **(M)** Claim **Best Use of Vultr** prize (mention Vultr deployment)
- [ ] **(M)** Submit before 9:30 AM cutoff

---

## Section 10 — Critical files + URLs

### Live URLs

| What | URL |
|------|-----|
| **Local dev** | <http://localhost:5173> *(run `npm run dev` in `react-router-app/` or `frontend/`)* |
| **Production target** | <https://volteux.com> *(after Vercel deploy)* |
| **Backend production target** | `https://api.volteux.com` or `https://YOUR_VULTR_IP` *(after Kai deploys)* |
| **GitHub** | <https://github.com/taliamekh/Volteux> |

### Your files

| File | Purpose |
|------|---------|
| [`HACKATHON-CHECKLIST.md`](./HACKATHON-CHECKLIST.md) | This checklist |
| [`HANDOFF.md`](./HANDOFF.md) | Project snapshot for new chats |
| [`PITCH.md`](./PITCH.md) | 2-min pitch + cold open + Q&A prep |
| [`VULTR-SETUP.md`](./VULTR-SETUP.md) | Vultr deploy guide for Kai |
| [`TODOS.md`](./TODOS.md) | Roadmap items (post-hackathon) |

### Kai's files (read-only for you)

| File | Purpose |
|------|---------|
| [`schemas/document.zod.ts`](./schemas/document.zod.ts) | JSON contract (locked v0.1) |
| [`components/registry.ts`](./components/registry.ts) | Component metadata (you'll add `thumbnail_url` here — coordinate first) |
| [`fixtures/uno-ultrasonic-servo.json`](./fixtures/uno-ultrasonic-servo.json) | Demo project data |
| [`pipeline/`](./pipeline/) | Backend code |

### Design reference (historical)

- [`mockups/ui-v1.html`](./mockups/ui-v1.html) — original HTML mockup (no longer iterated on)

---

## Section 11 — New chat handoff prompt

If you switch to a new Claude Code chat, paste this **verbatim** (filling in the two bracketed slots):

```text
I'm Talia, UI/Frontend track owner of Volteux (AI-powered Arduino tool, MLH hackathon).
I'm a mechanical engineer learning software — visual learner, prefer plain language, define jargon.

Read these files IN THIS ORDER to get full context (do not skip):
1. C:/Users/talia/OneDrive/CODING/Volteux/repo/HANDOFF.md (full project snapshot)
2. C:/Users/talia/OneDrive/CODING/Volteux/repo/HACKATHON-CHECKLIST.md (my production checklist with agent prompts)
3. C:/Users/talia/OneDrive/CODING/Volteux/repo/CLAUDE.md
4. C:/Users/talia/OneDrive/CODING/Volteux/repo/TODOS.md

CURRENT STATE: mid-hackathon, FULL PRODUCTION push targeting 9:30 AM at https://volteux.com.
- React app working at localhost:5173 (mocked pipeline + fake flash, both ready to swap)
- Backend: Kai is building real pipeline orchestrator + deploying to Vultr
- Frontend deploy target: Vercel (free), custom domain volteux.com (DNS on Cloudflare)
- Real Arduino Uno + USB cable on hand for live flash demo
- $100 Vultr MLH gift code (no credit card) — get from MLH coach, give to Kai

WHAT TO DO IMMEDIATELY:
1. Confirm you've read all the files
2. Open HACKATHON-CHECKLIST.md and read Section 5 (the agent prompts)
3. Spawn Agents A and D in parallel (they don't depend on Kai) — A sets up Vercel, D builds the missing fallback states
4. Update HACKATHON-CHECKLIST.md as items get done (mark [x])

The previous chat just finished: [WHAT_WAS_LAST_DONE]
Background agents from previous chat: [TASK_IDS or "none — all completed"]

Now confirm you've read the files and tell me your plan for the next 30 minutes.
```
