VOLTEUX 12-HOUR HACKATHON CHECKLIST

You have 12 hours. Original plan was 10-12 weeks. We are shipping a polished demo, not full production.

TO MAKE THESE INTO INTERACTIVE CHECKBOXES IN GOOGLE DOCS:
Select all the bullet lines under any section. Then Format > Bullets and numbering > Checklist. The "[ ]" markers will become clickable boxes.

============================================================
PART 1 - TALIA: YOUR HANDS-ON WORK
============================================================

DECISIONS NEEDED RIGHT NOW (block everything else)

[ ] Build path: enhance HTML mockup (faster, ~3hr) OR port to React/Vite (slower, ~6hr but better handoff)
[ ] What is Kai shipping in 12 hours: full pipeline, partial, or also pivoting to demo
[ ] Real Arduino Uno + USB cable for live demo, or 100% fake flash
[ ] Deploy target: Vercel (recommended), Netlify, or Cloudflare Pages
[ ] Pick 3 example prompts that will reliably work (one MUST be the robot-arm-waves example)

HOUR 0 to 4 - SHIP THE DEMO

[ ] Confirm build path with Claude so coding can start
[ ] Test the prompt to loading to main view transition once Claude wires it up
[ ] Approve the loading sequence timing (~10 seconds, feels intentional)
[ ] Verify all 4 panels render the fixture data (3D, wiring, code, parts)
[ ] Test the Honest Gap path (type a load-cell prompt, see graceful card)
[ ] Test the fake Flash flow (click Flash, see progress bar, see success)
[ ] Confirm the deployed URL works on Chrome
[ ] Bookmark the deployed URL on your phone for the demo

HOUR 4 to 8 - POLISH FOR DEMO

[ ] Read the agent-written hackathon pitch
[ ] Rehearse the pitch out loud at least 3 times
[ ] Decide slide deck or live-demo-only (live demo recommended)
[ ] Test the deployed demo on your phone (catch mobile bugs)
[ ] Verify the desktop-only fallback shows cleanly on mobile
[ ] Record a screen recording as backup if live demo crashes

HOUR 8 to 12 - BUFFER AND STRETCH GOALS

[ ] Final demo run-through end-to-end
[ ] Last-minute copy fixes
[ ] Submit to the hackathon platform
[ ] Prepare for Q and A. Common judge questions:
    - How big is the market
    - What is your moat, why can't someone copy this
    - What is next (use the v1.5 / v2+ roadmap from your TODOs)
    - How does the AI not hallucinate
    - Why Arduino first and not ESP32 or Pi Pico
[ ] Take a 30 minute break before the demo if possible

============================================================
PART 2 - AGENTS: WHAT TO SPAWN FOR PARALLEL WORK
============================================================

Tell me which to spawn. I run them in parallel and synthesize their reports.

[ ] AGENT 1 - DEPLOYMENT SCOUT (spawn FIRST)
Job: Get the demo live at a public URL.
Prompt: Set up a Vercel deployment for the HTML mockup at C:/Users/talia/OneDrive/CODING/Volteux/mockups/ui-v1.html. The user is non-technical and on Windows. Walk through every step: sign up for Vercel, install Vercel CLI on Windows, deploy from local folder, get a public URL. Do as much yourself as possible. Return the deployed URL plus any steps Talia needs to take. Under 300 words.

[ ] AGENT 2 - PITCH WRITER (spawn after build path decided)
Job: Write the 2-minute hackathon pitch.
Prompt: Write a 2-minute hackathon demo pitch for Volteux. Audience: hackathon judges. The product: AI tool that turns plain-English project ideas into Arduino projects with code, wiring, parts list, and 3D click-to-learn component view. Hero example: a robot arm that waves when something gets close. Future vision: drones, robotic arms, 3D-printed parts. Read CLAUDE.md, docs/PLAN.md, and TODOS.md in C:/Users/talia/OneDrive/CODING/Volteux/repo for full context. Return: a script with stage directions and a 30-second cold-open variant.

[ ] AGENT 3 - PIPELINE INTEGRATION SCOUT (spawn after Kai status known)
Job: Find out if real pipeline output can flow into the demo in 12 hours.
Prompt: Read C:/Users/talia/OneDrive/CODING/Volteux/repo/docs/plans/2026-04-25-001-feat-v01-pipeline-archetype-1-plan.md and the actual pipeline code in C:/Users/talia/OneDrive/CODING/Volteux/repo/pipeline/. Tell me: 1) is the pipeline runnable end-to-end today 2) if yes, what command 3) if not, what is the gap 4) is there a way for the demo UI to call it via fetch in 12 hours. Report under 200 words.

[ ] AGENT 4 - 3D MODEL SCOUT (spawn ONLY if we want a real 3D scene)
Job: Source the 5 component models so Talia does not have to build them.
Prompt: Find the cleanest free 3D models for: Arduino Uno R3, HC-SR04 ultrasonic sensor, micro servo SG90, full-size breadboard, jumper wires. Prefer Sketchfab CC0 or similar permissive licenses. Need glTF or GLB format. Return direct download URLs and license confirmation for each. Under 250 words.

[ ] AGENT 5 - DEMO PROMPT AUTHOR (spawn anytime)
Job: Hand-craft 5 example prompts that reliably work.
Prompt: Author 5 hand-tested example prompts for the Volteux v0 demo. Pipeline only supports archetype 1 (Uno + HC-SR04 + micro servo). Three should reliably succeed. Two should be intentionally out-of-scope to demo Honest Gap. For each prompt return: the prompt text, expected outcome, expected behavior, and one sentence on why this prompt is good for a judge demo.

[ ] AGENT 6 - HACKATHON SUBMISSION CHECKLIST (spawn 2 hours before deadline)
Job: Make sure submission goes smoothly.
Prompt: I am submitting Volteux to a hackathon in 2 hours. Walk me through what most hackathons require: project description, demo video, deployed URL, repo URL, team info, screenshots. Tell me what to prep and how long each piece typically takes. Under 200 words.

============================================================
PART 3 - NON-NEGOTIABLES (do not skip)
============================================================

[ ] Demo MUST be deployed at a public URL
[ ] At least one example prompt MUST work end-to-end without crashing
[ ] Pitch MUST mention the wedge (3D click-to-learn) and the future vision
[ ] Mobile users MUST see desktop-only message, not broken layout
[ ] You MUST have a backup screen recording in case live demo crashes
[ ] Deployed URL MUST be in your demo notes, do not memorize it

============================================================
PART 4 - WHAT SHIPS vs WHAT BECOMES THE PITCH
============================================================

SHIPS IN 12 HOURS:
- Landing page (already built)
- Empty to Loading to Main view flow (needs wiring)
- 4-panel main view rendering the fixture (3D, wiring, code, parts)
- Refine bar (visually only, no real backend)
- Parts checklist with I-have-it toggle
- Sticky CTA + see-finished-project link
- Honest Gap card (one example: load cell)
- Fake Flash flow (progress bar, success state)

BECOMES THE WHATS-NEXT PITCH SLIDE (do NOT promise these as built):
- Real WebUSB Uno flash (Kais spike, not yet validated)
- Real LLM pipeline integration (Kais track)
- ESP32, Pi Pico, additional boards (v1.5)
- Custom complex projects: drones, robotic arms (v2+)
- AI-generated 3D-printable STL files (v2+)
- Exploded/reassemble 3D animation (v2+)
- Drag-drop wiring editor with AI completion (v2+)
- Thousands of supported microcontrollers (v2+)

============================================================
PART 5 - CRITICAL FILES YOU MUST KNOW
============================================================

THE FIXTURE: repo/fixtures/uno-ultrasonic-servo.json
The canonical demo project. 5 components, 7 wires, 3 breadboard positions, full sketch. Your demo renders this exact JSON.

THE COMPONENT REGISTRY: repo/components/registry.ts
Kai already authored all 5 v0 components with pin metadata, education_blurbs, model URLs.

THE MOCKUP: mockups/ui-v1.html
Your starting point. 85% done visually. Needs interaction wiring + deployment.

THE SCHEMA: repo/schemas/document.zod.ts
Locked at v0.1. You signed off.

THE DEMO FLOW (memorize this):
1. Land on Volteux home (landing page sells the vision)
2. Click an example chip or type a prompt
3. Loading stepper runs ~10 seconds, feels real
4. Main view appears with 4 panels rendered against the fixture
5. Click around the 3D scene to show the click-to-learn callout
6. Show the Code panel scrolling through commented Arduino code
7. Show the parts checklist with I-have-it toggle
8. Click Flash to my Uno, fake progress, Your Uno is alive
9. Optional: type a load-cell prompt to demo Honest Gap
10. Close with the whats-next vision (drones, robotic arms, 3D-printed parts)
