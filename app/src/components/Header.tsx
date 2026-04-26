import type { Project, User, ViewName } from "../types";

interface HeaderProps {
  view: ViewName;
  prompt: string;
  project: Project | null;
  headerCtaVisible: boolean;
  onLogo: () => void;
  onChangePrompt: () => void;
  onAccountToggle: () => void;
  accountOpen: boolean;
  onCloseAccount: () => void;
  onNewProject: () => void;
  onScrollToInput: () => void;
  user: User | null;
  onSignInClick: () => void;
  onSignOut: () => void;
}

export default function Header({
  view,
  prompt,
  project,
  headerCtaVisible,
  onLogo,
  onChangePrompt,
  onAccountToggle,
  accountOpen,
  onCloseAccount,
  onNewProject,
  onScrollToInput,
  user,
  onSignInClick,
  onSignOut,
}: HeaderProps) {
  return (
    <div className="header">
      <div className="wordmark" onClick={onLogo}>
        Volteux<span className="dot">.</span>
      </div>

      {view === "landing" && (
        <>
          <div className="header-spacer" />
          <button
            className={`header-cta ${headerCtaVisible ? "visible" : ""}`}
            onClick={onScrollToInput}
            aria-hidden={!headerCtaVisible}
          >
            Build it
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
          <div className="header-auth">
            {!user && (
              <button className="signin-cta" onClick={onSignInClick}>
                Get started
              </button>
            )}
            {user && (
              <>
                <button className="signin-link" title="Your saved projects">
                  My projects
                </button>
                <div className="avatar avatar-sm" onClick={onAccountToggle} title={user.email}>
                  {user.initials}
                </div>
              </>
            )}
          </div>
          {accountOpen && user && (
            <div className="menu" onMouseLeave={onCloseAccount}>
              <div className="menu-header">{user.email}</div>
              <button className="menu-item">My projects</button>
              <button className="menu-item">Saved parts</button>
              <button className="menu-item">Connected boards</button>
              <div className="menu-divider" />
              <button className="menu-item">Settings</button>
              <button className="menu-item">Help &amp; docs</button>
              <div className="menu-divider" />
              <button className="menu-item muted" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          )}
        </>
      )}

      {view !== "landing" && (
        <>
          <div className="header-spacer" />
          <div className="prompt-chip" title="Click to start over" onClick={onChangePrompt}>
            <span className="quote">{prompt}</span>
            <span className="edit">↻ change idea</span>
          </div>
          <div className="header-spacer" />
          {view === "result" && project && (
            <div className="classification-chip">
              <span className="dot" />
              <span>
                {project.board} · {project.confidence}% match
              </span>
            </div>
          )}
          <div className="header-actions">
            {view === "result" && (
              <>
                <button className="btn-new" onClick={onNewProject} title="Start a new project">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  New
                </button>
                <button className="icon-btn" title="Save project" aria-label="Save project">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                    <polyline points="17 21 17 13 7 13 7 21" />
                    <polyline points="7 3 7 8 15 8" />
                  </svg>
                </button>
                <button className="icon-btn" title="Share" aria-label="Share">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="18" cy="5" r="3" />
                    <circle cx="6" cy="12" r="3" />
                    <circle cx="18" cy="19" r="3" />
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                  </svg>
                </button>
              </>
            )}
            <div className="avatar" onClick={onAccountToggle} title="Account">
              {user?.initials ?? "TK"}
            </div>
          </div>

          {accountOpen && (
            <div className="menu" onMouseLeave={onCloseAccount}>
              <div className="menu-header">{user?.email ?? "talia@volteux.app"}</div>
              <button className="menu-item">My projects</button>
              <button className="menu-item">Saved parts</button>
              <button className="menu-item">Connected boards</button>
              <div className="menu-divider" />
              <button className="menu-item">Settings</button>
              <button className="menu-item">Help &amp; docs</button>
              <div className="menu-divider" />
              <button className="menu-item muted" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
