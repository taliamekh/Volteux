TALIA — VOLTEUX HACKATHON PRODUCTION CHECKLIST
================================================

GOAL: full production deployed at https://volteux.com by 9:30 AM
SCOPE: this is YOUR checklist (UI/Frontend track owner). Kai owns the backend track separately.
LEGEND: [x] = done · [ ] = pending · [~] = in progress · [!] = blocked

OWNERSHIP MARKERS:
  (M)  = manual — you do it with your own hands
  (C)  = Claude in this chat does it for you
  (A)  = a background agent does it
  (K)  = waiting on Kai
  (M+C) = you decide / approve, Claude executes
  (M+K) = you and Kai jointly

================================================================
PART 0 — STATUS SNAPSHOT (what's already done)
================================================================

[x] (M+C) HTML mockup ported to React app at react-router-app/ (running at localhost:5173)
[x] (M+C) All 4 views wired with state machine (Empty / Loading / Main / Honest Gap)
[x] (M+C) Mocked pipeline (uses fixture, simulates 10s loading) — replaceable with real backend
[x] (M+C) Fake flash flow with progress + success overlay — replaceable with real Web Serial
[x] (M+C) Honest Gap card detects 5 trigger categories
[x] (M+C) Parts checklist with "I have it" toggle
[x] (M+C) Sticky CTA + see-finished-project link
[x] (M+C) Tagline: "Type your idea. We'll build it."
[x] (M+C) Slate-blue dark theme + violet accent + DM Serif + Exo 2 + Inter + JetBrains Mono
[x] (M+C) Refine bar (in-place tweak input)
[x] (M+C) Honest scope strip ("Today: Arduino Uno · Coming soon: ESP32, Pi Pico, custom maker projects, 3D-printed parts, drones, robotics")
[x] (A) Hackathon pitch script (saved to repo/PITCH.md)
[x] (A) Vultr setup guide for Kai (saved to repo/VULTR-SETUP.md)
[x] (M+C) HACKATHON-CHECKLIST.md (this file) + HANDOFF.md (chat handoff doc)
[x] (M+C) Schema v0.1 signoff
[x] (M+C) All design + plan changes pushed to GitHub

================================================================
PART 1 — DECISIONS LOCKED (no more deciding needed)
================================================================

[x] Build path: React app (already built at react-router-app/)
[x] Frontend deploy target: Vercel (free, custom domain volteux.com via Cloudflare DNS)
[x] Backend deploy target: Vultr (Kai owns; qualifies for Best Use of Vultr prize)
[x] Demo prompts: "robot arm waves" / "desk lamp on hand-over" / "parking sensor beeps"
[x] Honest Gap demo prompt: "I want to weigh things with a load cell"
[x] Real Arduino Uno for live flash demo (you have one)

================================================================
PART 2 — WHAT YOU NEED FROM KAI (coordination + blockers)
================================================================

These are the things Kai must deliver before YOU can finish your work. Track these so you know what's blocking you.

[ ] (M) Send Kai the file repo/VULTR-SETUP.md (text it, Slack it, hand him the URL — your choice)
[ ] (M) Get the Vultr $100 gift code from the MLH coach and pass it to Kai
[ ] (K) Kai's backend at a public HTTPS URL (e.g. https://api.volteux.com or https://YOUR_VULTR_IP)
        Without this, you can't replace the mocked pipeline with real fetch.
[ ] (K) Kai's POST /api/generate endpoint working (returns VolteuxProjectDocument or HonestGap)
        Without this, your prompts can't reach the real LLM.
[ ] (K) Kai's POST /api/compile endpoint working (returns the .hex artifact)
        Without this, you can't do real Web Serial flash.
[ ] (K) Kai's CORS configured for https://volteux.com (and whatever Vercel preview URLs you use)
        Without this, the browser will block your fetch calls.
[ ] (K) Kai's avrgirl-arduino + Web Serial spike succeeds on a real Uno
        Without this, real flash is impossible — fall back to fake flash for demo.
[ ] (M+K) Joint Day-1 schema signoff (technically already in CHANGELOG; reconfirm in person)
[ ] (M+K) Confirm with Kai: should the LLM prompt produce sketches with line-by-line teaching comments? (This was in TODOs as a v0 ask — Kai owns the prompt change.)

================================================================
PART 3 — YOUR HANDS-ON TASKS (only YOU can do these — no AI, no agent)
================================================================

[ ] (M) Get the Vultr gift code from the MLH coach (ask in person at the venue)
[ ] (M) Send the gift code + repo/VULTR-SETUP.md to Kai
[ ] (M) Rehearse the pitch in repo/PITCH.md out loud at least 3 times
[ ] (M) Plug in your Arduino Uno + USB cable, keep it ready for the live demo
[ ] (M) Test the live deployed site on your phone (catch mobile bugs)
[ ] (M) Record a screen recording of the full demo flow as a backup (in case live crashes)
[ ] (M) Bookmark the deployed volteux.com on your phone for the demo
[ ] (M) Take a 30-minute break before the demo (fresh head matters)
[ ] (M) Walk on stage and deliver the pitch
[ ] (M) Submit the project to MLH platform (Agent F handles the prep checklist)

================================================================
PART 4 — UI/FRONTEND PRODUCTION WORK (your track, executed by Claude/agents)
================================================================

These are tasks YOU own as UI track owner. Claude or agents execute, you approve and direct.

PRE-DEPLOY (do first, blocks deployment):
[ ] (C) Move react-router-app/ → repo/frontend/ so Vercel can auto-deploy on git push
[ ] (C) Update tsconfig + Vite config paths after move (if anything references absolute paths)
[ ] (C) Run typecheck + dev server in new location to confirm nothing broke
[ ] (M) Push the move to GitHub (or Claude does it after you approve)

REPLACE MOCKS WITH REAL BACKEND (after Kai's backend is at a public URL):
[ ] (A) Agent B: replace mocked startBuild() in home.tsx with real fetch to Kai's POST /api/generate
[ ] (C) Validate response with VolteuxProjectDocumentSchema from schemas/document.zod.ts
[ ] (C) Handle HonestGap envelope (scope: 'out-of-scope' / 'partial')
[ ] (C) Surface backend errors through the error boundary, not silent failure

REPLACE FAKE FLASH WITH REAL WEB SERIAL (after Kai's spike succeeds):
[ ] (A) Agent C: integrate avrgirl-arduino + Web Serial in home.tsx
[ ] (C) Call POST /api/compile to get the .hex base64
[ ] (C) avrgirl writes to the Uno over Web Serial
[ ] (M) Test with your real Uno before the demo

MISSING INTERACTION STATES (currently absent or stubbed):
[ ] (A) Agent D: build generic error boundary card (network/backend failure) with "Try again" + mailto recovery
[ ] (A) Agent D: build browser-not-Chromium full-screen explainer (detect via Web Serial feature test)
[ ] (A) Agent D: build mobile-detected full-screen explainer (viewport width check)
[ ] (A) Agent D: build localStorage-disabled inline banner
[ ] (C) URL hash persistence: serialize the document to base64+gzip on success, restore on page load
[ ] (C) Share button: POST to backend share service, get short URL, copy to clipboard, toast confirmation
[ ] (C) Real keyboard navigation through 3D scene (Tab cycles components, Enter selects, Esc clears)
[ ] (C) ARIA live region announces selected component's education_blurb for screen readers
[ ] (C) Verify color contrast WCAG AA on all violet-on-dark text/icons

REAL COMPONENT PHOTOS (was a v0 TODO — bringing into hackathon):
[ ] (A) Agent E: find Adafruit product photos for SKU 50, 3942, 169, 239, 758
[ ] (C) Add a thumbnail_url field to each entry in components/registry.ts (coordinate with Kai — this is the merge conflict file)
[ ] (C) Replace emoji thumbnails (🔧 📡 ⚙️) in parts list with <img> tags reading from registry
[ ] (M) Verify the photos look right at the small thumbnail size

DEPLOYMENT:
[ ] (A) Agent A: set up Vercel project pointing at repo/frontend/, configure monorepo subfolder build
[ ] (M) Sign up for Vercel (use GitHub login) if you don't have an account
[ ] (M) In Cloudflare DNS dashboard: add the CNAME records Vercel gives you (points volteux.com → Vercel)
[ ] (M) Verify https://volteux.com loads the landing page after DNS propagates (can take 5-30 min)
[ ] (M) Bookmark https://volteux.com on your phone

POST-DEPLOY POLISH:
[ ] (M) Test the deployed site end-to-end on Chrome (your laptop)
[ ] (M) Test on phone — desktop-only fallback should show cleanly
[ ] (M) Test in non-Chromium browser (Firefox/Safari) — fallback should show
[ ] (M) Test the live flash with your real Uno
[ ] (M) Test Honest Gap with the load-cell prompt
[ ] (M) Verify the 3 example chips all produce a real generated project

================================================================
PART 5 — AGENTS TO SPAWN (efficient parallel use, save usage)
================================================================

STRATEGY: spawn agents in PARALLEL within a single message. Each prompt is self-contained.
Each agent typically returns in 2-3 min. Don't spawn more than 4 at a time to keep context manageable.

AGENT A — VERCEL DEPLOY SCOUT (spawn FIRST in any new chat)
When: as soon as the React app is moved into repo/frontend/
Returns: deployed Vercel URL + DNS records to add to Cloudflare
Prompt: "Set up a Vercel deployment for the React app at C:/Users/talia/OneDrive/CODING/Volteux/repo/frontend/. The user is non-technical and on Windows. Custom domain target: volteux.com (DNS managed by Cloudflare). Walk through every step: (1) install Vercel CLI on Windows, (2) link the project, (3) configure monorepo subdirectory build (only watches frontend/), (4) deploy, (5) add custom domain in Vercel dashboard, (6) tell Talia exactly which CNAME records to add to Cloudflare DNS. Do as much yourself as possible. Return the deployed URL plus any steps Talia must take. Under 400 words."

AGENT B — BACKEND INTEGRATION HELPER (spawn AFTER Kai gives you the public backend URL)
When: only after Kai confirms his Hono server is reachable at a public HTTPS URL
Returns: code diff for home.tsx
Prompt: "Read C:/Users/talia/OneDrive/CODING/Volteux/repo/frontend/app/routes/home.tsx (or react-router-app/app/routes/home.tsx if not yet moved). Replace the mocked startBuild() function with a real fetch call to KAI_BACKEND_URL/api/generate. The backend returns either a VolteuxProjectDocument (success) or a HonestGap envelope. Validate the response with VolteuxProjectDocumentSchema from repo/schemas/document.zod.ts. Show me the exact code diff. Under 250 words. Backend URL: [TALIA FILLS IN]"

AGENT C — HARDWARE FLASH INTEGRATION (spawn AFTER Kai's WebSerial spike succeeds)
When: only after Kai confirms avrgirl-arduino + Web Serial works on a real Uno
Returns: code diff adding real flash
Prompt: "Add real browser-direct flashing to C:/Users/talia/OneDrive/CODING/Volteux/repo/frontend/app/routes/home.tsx. Use avrgirl-arduino + Web Serial. The flow: (1) call backend /api/compile to get the .hex artifact base64, (2) decode, (3) avrgirl writes it to the Uno over Web Serial, (4) success overlay shows. Replace the fake setInterval flash progress with the real avrgirl progress events. Reference https://github.com/noopkat/avrgirl-arduino for the API. Under 300 words."

AGENT D — ERROR + FALLBACK STATES (can spawn in parallel with A, no dependency)
When: anytime, doesn't depend on Kai
Returns: code for 4 missing states
Prompt: "Add four missing interaction states to C:/Users/talia/OneDrive/CODING/Volteux/repo/frontend/app/routes/home.tsx and app.css: (1) generic error boundary (network/backend failure) with Try Again + mailto recovery, (2) browser-not-Chromium full-screen explainer (detect via feature test for Web Serial: 'serial' in navigator), (3) mobile-detected full-screen explainer (viewport <768px), (4) localStorage-disabled inline banner (try/catch on init). Match the existing slate-blue + violet design system. Show me the diff for each. Under 400 words."

AGENT E — REAL COMPONENT PHOTOS (cheap, parallel)
When: anytime
Returns: 5 image URLs
Prompt: "Find direct Adafruit product photo URLs for SKU 50 (Arduino Uno R3), SKU 3942 (HC-SR04 ultrasonic sensor), SKU 169 (Micro Servo SG90), SKU 239 (full-size breadboard 830 holes), SKU 758 (jumper wires 40x6 inch). Need PNG or JPG, ideally on neutral background. Return direct image URLs and license note (Adafruit usually permits product imagery for resellers/educational use; flag if any of these are different). Under 200 words."

AGENT F — MLH SUBMISSION CHECKLIST (spawn 2 hours BEFORE 9:30 AM deadline)
When: ~7:30 AM
Returns: numbered submission prep list
Prompt: "I'm submitting Volteux to an MLH hackathon at 9:30 AM. Walk me through what MLH-hosted hackathons typically require: project description, demo video, deployed URL, repo URL, team info, screenshots, MLH challenge prizes (we're claiming Best Use of Vultr). Return a numbered submission prep list with estimated time per item, and which fields are usually required vs optional. Under 250 words."

================================================================
PART 6 — VISUAL DECISIONS YOU STILL OWE (small list, mostly edge cases)
================================================================

Most of the 28 design decisions from PLAN.md are LOCKED. These few remain:

[ ] (M+C) 3D scene aesthetic — currently a stylized SVG fake. For production, do you want a real Three.js scene with placeholder geometry, or keep the SVG fake (faster, demo-grade)? RECOMMEND: keep SVG for hackathon, real R3F is post-hackathon work.
[ ] (M+C) Lighting on the 3D scene — moot if we keep the SVG fake.
[ ] (M+C) Component rotation when clicked — currently no animation. Want a 300ms ease-toward, or keep static? RECOMMEND: static for hackathon (less code, less risk).
[ ] (M+C) First-visit hint copy — currently "Click any part to learn what it does." Keep or change?
[ ] (M+C) Honest Gap voice tone — written 5 trigger messages, all warm + direct. Read them and tweak any that feel off.
[ ] (M+C) Color contrast verification — does violet on slate-blue meet WCAG AA at every size? Need to verify.
[ ] (M+C) Touch targets — 44px minimum on 3D click hotspots. Verify after deploy on a real touch device.

================================================================
PART 7 — TODOS WE ADDED (some pulled into hackathon, others stay roadmap)
================================================================

PULLED INTO HACKATHON (now in Part 4 above):
[x] Real component photos in parts list (was v0 TODO) — listed under "Real Component Photos" in Part 4
[x] Generated sketch teaching comments (was v0 TODO) — listed in Part 2 as "Ask Kai" item

STAYS AS ROADMAP (becomes the "what's next" pitch slide content — DO NOT promise these as built):
[ ] Manual editing & AI-assisted wiring (v1.5+) — drag-drop wiring editor with AI completion
[ ] Custom complex projects + AI-generated STL + assembly view (v2+) — drones, robotic arms, exploded-view animation
[ ] Long-term hardware breadth: thousands of microcontrollers (v2+) — beyond 4 boards / 25 components

These are documented in repo/TODOS.md as full entries. Reference them in the pitch but don't add them to the build.

================================================================
PART 8 — DEMO DAY LOGISTICS
================================================================

PITCH:
[ ] (M) Read repo/PITCH.md
[ ] (M) Rehearse the 2-minute pitch out loud 3+ times
[ ] (M) Rehearse the 30-second cold-open variant in case judges are short on time
[ ] (M) Read the Q&A prep section (likely market/moat/what's-next questions)
[ ] (M) Decide: live demo only, or live demo + slide deck? RECOMMEND: live demo only for hackathon

EQUIPMENT FOR YOUR DEMO TABLE/SPOT:
[ ] (M) Laptop (charged, browser open to https://volteux.com)
[ ] (M) Arduino Uno + USB cable plugged into laptop
[ ] (M) HC-SR04 sensor + servo wired up so the demo project actually runs after flash
[ ] (M) Phone with the deployed URL bookmarked (in case laptop dies)
[ ] (M) Backup screen recording (in case live demo crashes)
[ ] (M) Notes with the deployed URL written down (don't trust memory under pressure)

JUDGE FLOW (memorize these 10 steps):
[ ] 1. Open https://volteux.com — show the landing page (sells the vision)
[ ] 2. Click an example chip OR type a prompt
[ ] 3. Loading runs ~10-15 seconds (real backend hits Anthropic)
[ ] 4. Main view appears with all 4 panels rendered from the real generated document
[ ] 5. Click around the 3D scene — show the click-to-learn callouts
[ ] 6. Show the Code panel scrolling through commented Arduino code
[ ] 7. Show the parts checklist with "I have it" toggle
[ ] 8. Click "Flash to my Uno" — real Web Serial flash to the connected Uno
[ ] 9. Servo waves on your desk
[ ] 10. (Optional) Type a load-cell prompt to demo Honest Gap, then close with the v1.5 + v2+ vision

================================================================
PART 9 — MLH SUBMISSION (do near the end)
================================================================

[ ] (A) Spawn Agent F (~7:30 AM) for the full submission checklist
[ ] (M) Project description (2-3 sentences pitching what Volteux is)
[ ] (M) Demo video link (the screen recording you made as backup)
[ ] (M) Deployed URL: https://volteux.com
[ ] (M) Repo URL: https://github.com/taliamekh/Volteux
[ ] (M) Team info (you + Kai, names, emails)
[ ] (M) Screenshots (3-4 of the live deployed product)
[ ] (M) Claim the Best Use of Vultr prize (mention deployment on Vultr)
[ ] (M) Submit before 9:30 AM cutoff

================================================================
PART 10 — CRITICAL FILES + URLS
================================================================

LIVE LOCAL DEV: http://localhost:5173 (run `npm run dev` in react-router-app/ or frontend/)
LIVE PRODUCTION (target): https://volteux.com (after Vercel deploy)
BACKEND PRODUCTION (target): https://api.volteux.com or https://YOUR_VULTR_IP (after Kai deploys)
GITHUB: https://github.com/taliamekh/Volteux

YOUR FILES:
- THIS CHECKLIST: repo/HACKATHON-CHECKLIST.md
- HANDOFF DOC (for new chats): repo/HANDOFF.md
- PITCH SCRIPT: repo/PITCH.md
- VULTR GUIDE FOR KAI: repo/VULTR-SETUP.md
- ROADMAP TODOS: repo/TODOS.md

KAI'S FILES (read-only for you):
- SCHEMA: repo/schemas/document.zod.ts (locked v0.1)
- COMPONENT REGISTRY: repo/components/registry.ts (you'll add thumbnail_url here — coordinate first)
- DEMO FIXTURE: repo/fixtures/uno-ultrasonic-servo.json
- PIPELINE CODE: repo/pipeline/

DESIGN REFERENCE (historical):
- ORIGINAL MOCKUP: repo/mockups/ui-v1.html (no longer iterated on)

================================================================
PART 11 — IF YOU SWITCH TO A NEW CHAT (context handoff)
================================================================

Open a new Claude Code chat and paste this prompt verbatim:

```
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
2. Open HACKATHON-CHECKLIST.md and read Part 5 (the agent prompts)
3. Spawn Agents A and D in parallel (they don't depend on Kai) — A sets up Vercel, D builds the missing fallback states
4. Update HACKATHON-CHECKLIST.md as items get done (mark [x])

The previous chat just finished: [WHAT_WAS_LAST_DONE]
Background agents from previous chat: [TASK_IDS or "none — all completed"]

Now confirm you've read the files and tell me your plan for the next 30 minutes.
```

Fill in [WHAT_WAS_LAST_DONE] and [TASK_IDS] before pasting.

================================================================
END OF CHECKLIST
================================================================
