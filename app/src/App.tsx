import { useEffect, useRef, useState } from "react";
import FlashModal from "./components/FlashModal";
import Header from "./components/Header";
import SignInModal from "./components/SignInModal";
import TweaksPanel from "./components/TweaksPanel";
import LandingView from "./views/LandingView";
import LoadingView from "./views/LoadingView";
import ResultView from "./views/ResultView";
import { applyRefinement, summarizeChange } from "./data/projects";
import { pipelineToProject } from "./data/adapter";
import { loadDefaultFixture } from "./data/fixtures";
import { decode, encode } from "./lib/urlHash";
import { UserSchema, type Project, type Tweaks, type User, type ViewName } from "./types";

const TWEAK_DEFAULTS: Tweaks = {
  palette: "violet",
  density: "default",
  type: "exo",
  slogan: "exo",
  useAi: false,
};

function loadUser(): User | null {
  try {
    const raw = localStorage.getItem("volteux_user");
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const result = UserSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [view, setView] = useState<ViewName>("landing");
  const [prompt, setPrompt] = useState("");
  const [project, setProject] = useState<Project | null>(null);
  const [refining, setRefining] = useState(false);
  const [refineToast, setRefineToast] = useState<string | null>(null);
  const [headerCtaVisible, setHeaderCtaVisible] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const [user, setUser] = useState<User | null>(loadUser);
  const [tweaks, setTweaks] = useState<Tweaks>(TWEAK_DEFAULTS);

  // Loop-prevention guard for the URL-hash effects (U8). When the mount-time
  // restore effect successfully decodes a document and calls setProject, the
  // resulting project-change would otherwise re-write the hash we just read
  // from. We flip this ref to `true` right before the restore's setProject so
  // the next write-effect run skips exactly that one write. Default `false`
  // keeps the hash-write working for the regular "build from scratch" path.
  const restoredFromHashRef = useRef<boolean>(false);

  // Refine-toast clear timer. Tracked so rapid refinements cancel the
  // previous clear before scheduling the next one — without this, a stale
  // 2.4s timer from refine #1 could null out a freshly-set toast from
  // refine #2. Mirrors the SignInModal pattern (auth-timer ref + cleanup).
  const refineToastTimerRef = useRef<number | null>(null);

  // Cancel-flag for an in-flight refine(). resetToLanding flips this true
  // so a refine that was awaiting its 900ms artificial delay (or the
  // optional AI summarization) doesn't resurrect the dead project after
  // the user navigated away. Without this, refine's stale closure-captured
  // `project` would call setProject(next) post-navigation, bringing the
  // old project back to life on landing.
  const refineCancelRef = useRef<boolean>(false);

  // Generation counter for in-flight URL-hash decodes. Each restoreFromHash
  // call captures its own generation at start; if a newer decode bumps the
  // counter while the older one is still awaiting, the older one bails
  // before mutating state. Without this, 3 back-button clicks in 100ms
  // produce 3 concurrent decodes whose resolution order is not guaranteed
  // — older decodes resolving last would leave state pointing at the
  // wrong project relative to the URL.
  const decodeGenerationRef = useRef<number>(0);

  // Cleanup on unmount: a sudden unmount mid-toast would otherwise leak the
  // pending setRefineToast(null) call into the next mount's React tree.
  useEffect(() => {
    return () => {
      if (refineToastTimerRef.current !== null) {
        window.clearTimeout(refineToastTimerRef.current);
        refineToastTimerRef.current = null;
      }
    };
  }, []);

  // Persist user to localStorage
  useEffect(() => {
    if (user) localStorage.setItem("volteux_user", JSON.stringify(user));
    else localStorage.removeItem("volteux_user");
  }, [user]);

  // Reset-to-landing: shared by the user-triggered logo/new-project click
  // path (goLanding) and the hashchange empty-hash branch. The clearHash
  // flag distinguishes the two: user-click owns the navigation and must
  // clear the URL hash; the hashchange path is reacting to the browser
  // already changing the hash, so it must NOT write back.
  //
  // We deliberately do NOT flip restoredFromHashRef here. The previous
  // design did, but the project-write effect early-returns on
  // !project?.document, which means the flip never gets consumed when
  // we're going to a null project — it leaks into the next legitimate
  // setProject(non-null) call (e.g., "See an example") and silently
  // skips the hash write. We also mark any in-flight refine as cancelled
  // so it doesn't resurrect the dead project after the await.
  const resetToLanding = (opts: { clearHash: boolean }) => {
    refineCancelRef.current = true;
    setView("landing");
    setPrompt("");
    setProject(null);
    if (opts.clearHash && window.location.hash) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    }
  };

  // Decode + apply a hash, shared by mount-restore and hashchange. Returns
  // true if a project was restored, false otherwise (empty / invalid hash,
  // or a newer decode superseded this one). Flips the loop guard before
  // setProject so the write effect skips. Per CLAUDE.md "no silent
  // failures", decode() surfaces failure as null; this helper passes that
  // null through and the caller decides UX (mount stays on landing,
  // hashchange preserves current state).
  const restoreFromHash = async (hash: string): Promise<boolean> => {
    const myGeneration = ++decodeGenerationRef.current;
    const doc = await decode(hash);
    // Bail if a newer hashchange / restore started while we were awaiting.
    // Without this, out-of-order decode resolutions could land at a stale
    // project relative to the URL.
    if (myGeneration !== decodeGenerationRef.current) return false;
    if (!doc) return false;
    const restored = pipelineToProject(doc);
    restoredFromHashRef.current = true;
    setProject(restored);
    setView("result");
    return true;
  };

  // Restore project from URL hash on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hash = window.location.hash;
      if (!hash) return;
      const ok = await restoreFromHash(hash);
      if (cancelled) return;
      // If decode failed (gibberish, schema-invalid payload), fall through
      // to landing — no toast, no console error spam. The boolean is
      // informational; mount has nothing to do on failure.
      void ok;
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync project state when the hash changes via browser back/forward
  // (or any direct location.hash assignment elsewhere). history.replaceState
  // and pushState do NOT fire hashchange, so our own writes from the
  // project-change effect don't trigger this — the loop guard is defensive
  // for symmetry with the mount restore.
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash;
      if (!hash || hash === "#") {
        // explicit user nav away from any project — return to landing via
        // the same code path the logo/new-project click uses, so loop-guard
        // and any future side effects stay symmetric.
        resetToLanding({ clearHash: false });
        return;
      }
      // Fire and forget: a stale resolution arriving after a newer
      // hashchange would just briefly flicker before the newer one wins.
      // No state corruption (decode is pure, setProject is idempotent).
      void restoreFromHash(hash);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Write the document to the URL hash whenever the project changes. Skip
  // exactly one write (the post-restore one) to avoid a mount→write→mount
  // loop. history.replaceState avoids polluting browser history on every
  // chat-refine.
  useEffect(() => {
    if (!project?.document) return;
    if (restoredFromHashRef.current) {
      restoredFromHashRef.current = false;
      return;
    }
    let cancelled = false;
    (async () => {
      const hash = await encode(project.document!);
      if (cancelled) return;
      window.history.replaceState(null, "", `#${hash}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.document]);

  // Apply palette + density + type by toggling classes on <body>.
  useEffect(() => {
    const cls = [
      tweaks.palette === "amber"
        ? "palette-amber"
        : tweaks.palette === "mint"
          ? "palette-mint"
          : "",
      tweaks.density === "compact"
        ? "density-compact"
        : tweaks.density === "roomy"
          ? "density-roomy"
          : "",
      tweaks.type === "serif" ? "type-serif" : tweaks.type === "mono" ? "type-mono" : "",
      tweaks.slogan && tweaks.slogan !== "exo" ? `slogan-${tweaks.slogan}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    document.body.className = cls;
  }, [tweaks]);

  const setTweak = <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => {
    setTweaks((prev) => ({ ...prev, [key]: value }));
  };

  const startBuild = (p: string) => {
    setPrompt(p);
    setView("loading");
  };

  const finishLoading = () => {
    const proj = pipelineToProject(loadDefaultFixture());
    setProject({ ...proj, prompt });
    setView("result");
  };

  const refine = async (refinement: string) => {
    if (refining || !project) return;
    refineCancelRef.current = false;
    setRefining(true);
    setRefineToast(null);
    await new Promise((r) => window.setTimeout(r, 900));
    // resetToLanding() flipped the cancel flag while we were awaiting →
    // the user navigated away. Don't resurrect the dead project.
    if (refineCancelRef.current) {
      setRefining(false);
      return;
    }
    const { project: next, changed } = applyRefinement(project, refinement);
    setProject(next);
    setRefining(false);

    let msg = changed ? `Updated: ${refinement}` : "Got it — no changes needed";
    if (tweaks.useAi) {
      const aiMsg = await summarizeChange(refinement, next);
      // Same cancel check after the optional AI await.
      if (refineCancelRef.current) return;
      if (aiMsg) msg = aiMsg;
    }
    setRefineToast(msg);
    if (refineToastTimerRef.current !== null) {
      window.clearTimeout(refineToastTimerRef.current);
    }
    refineToastTimerRef.current = window.setTimeout(() => {
      refineToastTimerRef.current = null;
      setRefineToast(null);
    }, 2400);
  };

  const goLanding = () => {
    // Logo / new-project click owns the navigation, so clear the hash too.
    resetToLanding({ clearHash: true });
  };

  return (
    <div className="app">
      <Header
        view={view}
        prompt={prompt}
        project={project}
        headerCtaVisible={headerCtaVisible}
        onLogo={goLanding}
        onChangePrompt={goLanding}
        onAccountToggle={() => setAccountOpen((v) => !v)}
        accountOpen={accountOpen}
        onCloseAccount={() => setAccountOpen(false)}
        onNewProject={goLanding}
        onScrollToInput={() =>
          (window as Window & { __volteux_focusInput?: () => void }).__volteux_focusInput?.()
        }
        user={user}
        onSignInClick={() => setAuthOpen(true)}
        onSignOut={() => {
          setUser(null);
          setAccountOpen(false);
        }}
      />

      {view === "landing" && (
        <div className="view active">
          <LandingView
            onSubmit={startBuild}
            onSeeExample={() => {
              const exampleText = "a robot arm that waves when something gets close";
              setPrompt(exampleText);
              const proj = pipelineToProject(loadDefaultFixture());
              setProject({ ...proj, prompt: exampleText });
              setView("result");
            }}
            setHeaderCtaVisible={setHeaderCtaVisible}
          />
        </div>
      )}

      {view === "loading" && (
        <div className="view active">
          <LoadingView prompt={prompt} onComplete={finishLoading} />
        </div>
      )}

      {view === "result" && project && (
        <div className="view active">
          <ResultView
            project={project}
            onRefine={refine}
            refining={refining}
            onFlash={() => setFlashing(true)}
            refineToast={refineToast}
          />
        </div>
      )}

      {tweaksOpen && (
        <TweaksPanel tweaks={tweaks} setTweak={setTweak} onClose={() => setTweaksOpen(false)} />
      )}

      {/* Hidden hotkey: press "T" anywhere to toggle the tweaks panel */}
      <TweaksHotkey onToggle={() => setTweaksOpen((v) => !v)} />

      {authOpen && (
        <SignInModal
          onClose={() => setAuthOpen(false)}
          onAuth={(u) => {
            setUser(u);
            setAuthOpen(false);
          }}
        />
      )}

      <FlashModal
        open={flashing}
        onClose={() => setFlashing(false)}
        project={project}
      />
    </div>
  );
}

function TweaksHotkey({ onToggle }: { onToggle: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "t" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        // Don't intercept while typing in inputs / contenteditable
        if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
        onToggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onToggle]);
  return null;
}
