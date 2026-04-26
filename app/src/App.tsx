import { useEffect, useState } from "react";
import Header from "./components/Header";
import SignInModal from "./components/SignInModal";
import TweaksPanel from "./components/TweaksPanel";
import LandingView from "./views/LandingView";
import LoadingView from "./views/LoadingView";
import ResultView from "./views/ResultView";
import { applyRefinement, summarizeChange } from "./data/projects";
import { pipelineToProject } from "./data/adapter";
import { loadDefaultFixture } from "./data/fixtures";
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
  const [user, setUser] = useState<User | null>(loadUser);
  const [tweaks, setTweaks] = useState<Tweaks>(TWEAK_DEFAULTS);

  // Persist user to localStorage
  useEffect(() => {
    if (user) localStorage.setItem("volteux_user", JSON.stringify(user));
    else localStorage.removeItem("volteux_user");
  }, [user]);

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
            onFlash={() => {
              setRefineToast("Flashing to your Uno… (demo)");
              window.setTimeout(() => setRefineToast(null), 2400);
            }}
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
