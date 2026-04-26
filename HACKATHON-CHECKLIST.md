VOLTEUX HACKATHON — FULL PRODUCTION CHECKLIST

GOAL: ship production-grade Volteux deployed at volteux.com by 9:30 AM.
NOT a polished demo — a real working product that judges can use end-to-end.

Legend: [x] = done · [ ] = pending · [~] = in progress · [!] = blocked

==============================================================
PART 1 — STATUS SNAPSHOT (what's already done)
==============================================================

[x] HTML mockup ported to React (react-router-app/, runs at localhost:5173)
[x] All 4 views (Empty/Loading/Main/HonestGap) wired with state machine
[x] Honest Gap detection (5 trigger categories: load cell, drone, audio, temp/wifi, OLED)
[x] Mocked pipeline (uses fixture, simulates 10s loading) — to be REPLACED with real backend
[x] Fake Flash flow with progress + success overlay — to be REPLACED with real Web Serial flash
[x] Parts checklist with I-have-it toggle
[x] Sticky CTA + see-finished-project link
[x] Tagline locked: "Type your idea. We'll build it."
[x] Slate-blue dark theme + violet accent + DM Serif Display + Exo 2 + Inter
[x] Hackathon pitch written (PITCH.md)
[x] Vultr setup guide written (VULTR-SETUP.md)
[x] HANDOFF.md updated for new-chat continuity
[x] All design + plan changes committed and pushed to GitHub

==============================================================
PART 2 — KAI'S BACKEND PRODUCTION TASKS
==============================================================

Send Kai this list. It's everything that's missing from his pipeline for real integration.
Per the pipeline-integration-scout agent's findings: gates and rules are built, but no HTTP server, no LLM client, no orchestrator exist on disk yet.

[ ] KAI: Add @anthropic-ai/sdk to package.json + install
[ ] KAI: Build pipeline/llm.ts — Anthropic client wrapper with structured output
[ ] KAI: Build pipeline/orchestrator.ts — LLM call → schema gate → rules → cross-consistency → return VolteuxProjectDocument or HonestGap
[ ] KAI: Build the intent classifier (Haiku 4.5 with structured output) — out-of-scope prompts route to Honest Gap
[ ] KAI: Build pipeline/gates/compile.ts — wraps arduino-cli, returns .hex artifact
[ ] KAI: Build the Hono HTTP server (server/index.ts) with two endpoints:
    - POST /api/generate — body: {prompt}, returns: VolteuxProjectDocument or HonestGap envelope
    - POST /api/compile — body: {sketch, libraries}, returns: {ok, stderr, artifact_b64}
[ ] KAI: Add CORS middleware for the Vercel frontend origin (https://volteux.com + preview URLs)
[ ] KAI: Browser-direct flash spike (avrgirl-arduino + Web Serial) on real Uno — confirm it works on Talia's machine
[ ] KAI: Deploy to Vultr per repo/VULTR-SETUP.md (claim $100 MLH gift code first)
[ ] KAI: Set up Caddy on Vultr for HTTPS (avoids mixed-content blocking from Vercel HTTPS frontend)
[ ] KAI: Confirm public URL is reachable: curl https://api.volteux.com/health

==============================================================
PART 3 — TALIA + CLAUDE FRONTEND PRODUCTION TASKS
==============================================================

[~] Move react-router-app/ into repo/frontend/ (so Vercel auto-deploys on git push)
[ ] Wire up real backend fetch in home.tsx:
    - Replace the mocked startBuild() with: fetch(API_URL + '/api/generate', {method: 'POST', body: JSON.stringify({prompt})})
    - Validate response with VolteuxProjectDocumentSchema.parse() from repo/schemas/document.zod.ts
    - Handle Honest Gap envelope (scope: 'out-of-scope' / 'partial')
[ ] Wire up real flash:
    - Replace the fake Flash progress bar with avrgirl-arduino + Web Serial call
    - Hit Kai's /api/compile endpoint to get the .hex, then flash it
[ ] Real component data flow: lookup component info from repo/components/registry.ts (not hardcoded COMPONENT_INFO)
[ ] Real Adafruit cart URL: build the cart link from the SKU list returned by the backend
[ ] Add error boundary (catches network failures, schema validation errors) — generic Try Again card
[ ] Add browser-not-Chromium full-screen explainer (currently no fallback)
[ ] Add mobile-detected full-screen explainer (responsive breakpoints exist; full-screen modal needed)
[ ] Add localStorage-disabled inline banner
[ ] URL hash persistence: serialize the document to base64+gzip, restore on page load
[ ] Share button → POST to backend share service, get short URL, copy to clipboard
[ ] Replace emoji thumbnails with real Adafruit product photos (5 components)
[ ] Add real keyboard navigation through 3D scene (Tab, Enter, Esc)
[ ] Verify color contrast WCAG AA on all violet-on-dark text/icons
[ ] Test all 16 interaction states from docs/PLAN.md
[ ] Set up Vercel project, point at frontend/ subfolder for monorepo build
[ ] Connect volteux.com via Cloudflare DNS CNAME → Vercel
[ ] Verify HTTPS works end-to-end (Cloudflare DNS → Vercel SSL cert)
[ ] Backup screen recording of full demo flow in case live demo crashes

==============================================================
PART 4 — NEW THINGS ADDED THIS CHAT (vs. original PLAN.md)
==============================================================

These are features and decisions captured during design that should be preserved going forward:

[x] Tagline: "Type your idea. We'll build it." (replaces "Build the thing.")
[x] Honest scope strip: "Today: Arduino Uno · Coming soon: ESP32, Pi Pico, custom maker projects, 3D-printed parts, drones, robotics"
[x] Refine bar: in-place "tweak it" input below the four panels (lets users iterate without restarting)
[x] "I have it" parts checklist: each part has a checkbox; total recalculates; cart button changes when all owned
[x] Sticky header CTA: "Build it →" appears in header when user scrolls past the hero input on landing
[x] See-finished-project link: skips loading + jumps straight to main view (lets hesitant users see the magic before committing)
[x] "Code" panel rename (was "Your sketch" — Arduino jargon)
[x] De-Arduinoed copy throughout: "your code" instead of "Arduino code", "your hardware" instead of "your kit"
[x] Honest Gap with 5 trigger categories (load cell, drone, audio, temp/wifi, OLED) and 2 recovery actions
[x] Metallic gradient text (silver) on wordmark, tagline, section titles
[x] Metallic-violet gradient on accent text, step numbers, CTA buttons
[x] Hairline gradient borders on preview cards
[x] White-on-violet button text gets text-stroke + text-shadow for contrast

NEW TODOs added to TODOS.md (post-v0 roadmap):
[x] Manual editing & AI-assisted wiring (v1.5+) — 3-stage path
[x] Generated sketch teaching comments (v0)
[x] Real component photos in parts list (v0)
[x] Custom complex projects + AI-generated STL + assembly view (v2+) — drones, robotic arms
[x] Long-term hardware breadth: thousands of microcontrollers (v2+)

==============================================================
PART 5 — AGENTS TO SPAWN (use parallel + minimize usage)
==============================================================

Strategy: spawn agents in PARALLEL within a single message. Each agent prompt is self-contained (no chat history). Most return in 2-3 minutes.

[ ] AGENT A — VERCEL DEPLOY SCOUT (spawn FIRST in new chat)
Prompt: "Set up Vercel deployment for the React app at C:/Users/talia/OneDrive/CODING/Volteux/repo/frontend/ (after Talia moves it there from react-router-app/). The user is non-technical and on Windows. Custom domain: volteux.com (DNS managed by Cloudflare). Walk through: (1) install Vercel CLI on Windows, (2) link the project, (3) configure monorepo subdirectory build, (4) add custom domain, (5) tell Talia what CNAME records to add to Cloudflare DNS. Return the deployed Vercel URL plus any steps Talia must take. Under 400 words."

[ ] AGENT B — BACKEND INTEGRATION HELPER (spawn after Kai confirms backend is up at a public URL)
Prompt: "Read C:/Users/talia/OneDrive/CODING/Volteux/repo/frontend/app/routes/home.tsx. Replace the mocked startBuild() function with a real fetch call to Kai's backend at the URL Talia provides. The backend returns either a VolteuxProjectDocument (success) or a HonestGap envelope (out-of-scope). Validate the response with VolteuxProjectDocumentSchema from repo/schemas/document.zod.ts. Show me the exact code diff. Under 250 words."

[ ] AGENT C — HARDWARE FLASH INTEGRATION (spawn after Kai's WebSerial spike succeeds)
Prompt: "Add real browser-direct flashing to C:/Users/talia/OneDrive/CODING/Volteux/repo/frontend/app/routes/home.tsx. Use avrgirl-arduino + Web Serial. The flow: (1) call backend /api/compile to get the .hex artifact base64, (2) decode, (3) avrgirl writes it to the Uno over Web Serial, (4) success overlay shows. Replace the fake setInterval flash progress with the real avrgirl progress. Reference https://github.com/noopkat/avrgirl-arduino for the API. Under 300 words."

[ ] AGENT D — ERROR + FALLBACK STATES (can spawn in parallel with A)
Prompt: "Add four missing interaction states to C:/Users/talia/OneDrive/CODING/Volteux/repo/frontend/app/routes/home.tsx and app.css: (1) generic error boundary (network/backend failure) with Try Again + mailto recovery, (2) browser-not-Chromium full-screen explainer (detect via feature test for Web Serial), (3) mobile-detected full-screen explainer (viewport <768px), (4) localStorage-disabled inline banner. Match the existing slate-blue + violet design system. Show me the diff for each. Under 400 words."

[ ] AGENT E — REAL COMPONENT PHOTOS (cheap, parallel)
Prompt: "Find Adafruit product photos for SKU 50 (Arduino Uno R3), SKU 3942 (HC-SR04 ultrasonic sensor), SKU 169 (Micro Servo SG90), SKU 239 (full-size breadboard 830 holes), SKU 758 (jumper wires 40x6 inch). Return direct image URLs from adafruit.com or appropriate alternative source, plus license note. Under 200 words."

[ ] AGENT F — HACKATHON SUBMISSION CHECKLIST (spawn 2hr before 9:30 AM deadline)
Prompt: "I'm submitting Volteux to MLH hackathon in 2 hours. Walk me through what's typically required: project description, demo video, deployed URL, repo URL, team info, screenshots, MLH challenge prizes (Best Use of Vultr). Return a numbered submission prep list with estimated time per item. Under 200 words."

==============================================================
PART 6 — NON-NEGOTIABLES FOR PRODUCTION
==============================================================

[ ] Deployed at https://volteux.com (HTTPS)
[ ] Real backend at Vultr URL (HTTPS via Caddy)
[ ] All 3 example prompts produce a real generated VolteuxProjectDocument
[ ] At least one out-of-scope prompt produces a real Honest Gap card
[ ] Real Arduino Uno flashes via Web Serial in the demo
[ ] Mobile users see a clean fallback message
[ ] Browser-not-Chromium users see a clean fallback message
[ ] Pitch rehearsed 3+ times
[ ] Backup screen recording exists
[ ] MLH submission complete with all required fields

==============================================================
PART 7 — DEMO FLOW FOR JUDGES
==============================================================

1. Land on https://volteux.com — judges see the landing page
2. Click an example chip OR type a prompt
3. Real loading sequence (~10-15 sec): backend hits Anthropic, runs gates, returns JSON
4. Main view appears with all 4 panels rendered from the real returned document
5. Click around the 3D scene — click-to-learn callouts appear
6. Show the parts checklist + the real Adafruit cart link
7. Click "Flash to my Uno" — real Web Serial flash to the connected Uno
8. Servo waves (the demo project)
9. (Optional) Type "I want to weigh things with a load cell" → real Honest Gap response
10. Close with the v1.5 + v2+ roadmap (drones, robotic arms, 3D-printed parts)

==============================================================
PART 8 — CRITICAL FILES + URLS
==============================================================

LIVE LOCAL: http://localhost:5173 (run `npm run dev` in react-router-app/ or frontend/)
LIVE PRODUCTION (target): https://volteux.com (after Vercel deploy)
BACKEND PRODUCTION (target): https://api.volteux.com (after Vultr + Caddy deploy)

REPO: https://github.com/taliamekh/Volteux

Frontend code (current): react-router-app/app/routes/home.tsx + app/app.css
Frontend code (target): repo/frontend/app/routes/home.tsx + app/app.css
Schema (locked): repo/schemas/document.zod.ts
Component registry: repo/components/registry.ts
Demo fixture: repo/fixtures/uno-ultrasonic-servo.json (used by mocked pipeline; remove when real backend wired)
Pitch: repo/PITCH.md
Vultr guide for Kai: repo/VULTR-SETUP.md
This checklist: repo/HACKATHON-CHECKLIST.md
Full handoff for new chat: repo/HANDOFF.md
