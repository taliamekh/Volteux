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
import type { Project, Tweaks, User, ViewName } from "./types";

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
    return raw ? (JSON.parse(raw) as User) : null;
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

  // Persist user to localStorage
  useEffect(() => {
    if (user) localStorage.setItem("volteux_user", JSON.stringify(user));
    else localStorage.removeItem("volteux_user");
  }, [user]);

  // Restore project from URL hash on mount. If decode fails (empty hash,
  // gibberish, schema-invalid payload), fall through to landing — no toast,
  // no console error spam. Per CLAUDE.md "no silent failures", decode itself
  // surfaces failure as `null`; the caller (this effect) decides UX.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hash = window.location.hash;
      if (!hash) return;
      const doc = await decode(hash);
      if (cancelled || !doc) return;
      const restored = pipelineToProject(doc);
      restoredFromHashRef.current = true;
      setProject(restored);
      setView("result");
    })();
    return () => {
      cancelled = true;
    };
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
    setRefining(true);
    setRefineToast(null);
    await new Promise((r) => window.setTimeout(r, 900));
    const { project: next, changed } = applyRefinement(project, refinement);
    setProject(next);
    setRefining(false);

    let msg = changed ? `Updated: ${refinement}` : "Got it — no changes needed";
    if (tweaks.useAi) {
      const aiMsg = await summarizeChange(refinement, next);
      if (aiMsg) msg = aiMsg;
    }
    setRefineToast(msg);
    window.setTimeout(() => setRefineToast(null), 2400);
  };

  const goLanding = () => {
    setView("landing");
    setPrompt("");
    setProject(null);
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
