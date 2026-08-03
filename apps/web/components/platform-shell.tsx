"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { CloseIcon, MenuIcon } from "@/components/icons";
import { responseMessage } from "@/lib/client-http";
import {
  DEFAULT_USER_SETTINGS,
  type AuthState,
  type PlannerSeed,
  type PlatformView,
  type WorkspaceState,
} from "@quoteredy/core/types";

const NAV: Array<{
  id: PlatformView;
  label: string;
  code: string;
  href: string;
}> = [
  { id: "dashboard", label: "Overview", code: "01", href: "/" },
  { id: "planner", label: "Planning", code: "02", href: "/planner" },
  { id: "library", label: "Zoo library", code: "03", href: "/library" },
  { id: "parts", label: "Parts", code: "04", href: "/parts" },
  { id: "drawings", label: "Drawings", code: "05", href: "/drawings" },
  { id: "results", label: "Results", code: "06", href: "/results" },
  { id: "reports", label: "Reports", code: "07", href: "/reports" },
  { id: "factory", label: "My factory", code: "08", href: "/factory" },
  { id: "settings", label: "Settings", code: "09", href: "/settings" },
];

const VIEW_PATHS = Object.fromEntries(
  NAV.map((item) => [item.id, item.href]),
) as Record<PlatformView, string>;

const EMPTY_WORKSPACE: WorkspaceState = {
  folders: [],
  machines: [],
  reports: [],
  documents: [],
  parts: [],
  drawings: [],
  settings: {
    ...DEFAULT_USER_SETTINGS,
    hasAiApiKey: false,
    hasZooApiToken: false,
  },
  stats: { reports: 0, ready: 0, machines: 0, documents: 0 },
};

interface PlatformContextValue {
  auth: AuthState;
  workspace: WorkspaceState;
  loadWorkspace: () => Promise<void>;
  plannerSeed: PlannerSeed | null;
  planProject: (project: PlannerSeed) => void;
  navigate: (view: PlatformView) => void;
}

const PlatformContext = createContext<PlatformContextValue | null>(null);

export function usePlatform(): PlatformContextValue {
  const context = useContext(PlatformContext);
  if (!context)
    throw new Error("usePlatform must be used inside PlatformShell.");
  return context;
}

export function PlatformShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [auth, setAuth] = useState<AuthState>({
    loading: true,
    authenticated: true,
    configured: true,
    user: null,
  });
  const [workspace, setWorkspace] = useState<WorkspaceState>(EMPTY_WORKSPACE);
  const [notice, setNotice] = useState<string | null>(null);
  const [plannerSeed, setPlannerSeed] = useState<PlannerSeed | null>(null);
  const [zooMinutes, setZooMinutes] = useState<number | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const activeNav = useMemo(
    () => NAV.find((item) => item.href === pathname) ?? NAV[0],
    [pathname],
  );

  const loadWorkspace = useCallback(async () => {
    if (!auth.authenticated) return;
    try {
      const response = await fetch("/api/platform", { cache: "no-store" });
      if (!response.ok)
        throw new Error(
          await responseMessage(response, "Workspace unavailable."),
        );
      setWorkspace((await response.json()) as WorkspaceState);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Workspace unavailable.",
      );
    }
  }, [auth.authenticated]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("auth_error");
    if (authError) queueMicrotask(() => setNotice(authError));
    void fetch("/api/auth/session", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Session check failed.");
        const session = (await response.json()) as Omit<AuthState, "loading">;
        if (!session.authenticated) {
          window.location.replace("/login");
          return;
        }
        setAuth({ ...session, loading: false });
      })
      .catch(() => {
        window.location.replace("/login");
      });
    if (params.has("auth") || params.has("auth_error")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadWorkspace);
  }, [loadWorkspace]);

  // Remaining Zoo usage minutes for the top bar; the endpoint caches
  // server-side, so a periodic refresh stays cheap.
  useEffect(() => {
    if (!auth.authenticated) return;
    let cancelled = false;
    const loadUsage = async () => {
      try {
        const response = await fetch("/api/zoo/usage", { cache: "no-store" });
        if (!response.ok) return;
        const usage = (await response.json()) as {
          minutesRemaining: number | null;
        };
        if (!cancelled) setZooMinutes(usage.minutesRemaining);
      } catch {
        // The badge simply stays hidden when usage cannot be read.
      }
    };
    void loadUsage();
    const timer = setInterval(() => void loadUsage(), 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [auth.authenticated]);

  // Resolve the effective theme: an explicit user choice wins, "system"
  // follows the device preference (and reacts to live changes).
  const themePreference = workspace.settings.theme;
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const resolved =
        themePreference === "system"
          ? media.matches
            ? "light"
            : "dark"
          : themePreference;
      document.documentElement.dataset.theme = resolved;
      try {
        window.localStorage.setItem("qr-theme", themePreference);
      } catch {
        // Storage may be unavailable; the theme still applies this session.
      }
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [themePreference]);

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  async function disconnectZoo() {
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok)
        throw new Error(await responseMessage(response, "Sign-out failed."));
      window.location.assign("/login");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Sign-out failed.");
    }
  }

  const navigate = useCallback(
    (next: PlatformView) => {
      setMenuOpen(false);
      router.push(VIEW_PATHS[next]);
    },
    [router],
  );

  const planProject = useCallback(
    (project: PlannerSeed) => {
      setPlannerSeed(project);
      navigate("planner");
    },
    [navigate],
  );

  const contextValue = useMemo<PlatformContextValue>(
    () => ({
      auth,
      workspace,
      loadWorkspace,
      plannerSeed,
      planProject,
      navigate,
    }),
    [auth, workspace, loadWorkspace, plannerSeed, planProject, navigate],
  );

  const connectionLabel = auth.loading ? "Checking Zoo" : "Zoo connected";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <button
        aria-label="Close navigation"
        className={`sidebar-scrim ${menuOpen ? "visible" : ""}`}
        onClick={() => setMenuOpen(false)}
        tabIndex={menuOpen ? 0 : -1}
        type="button"
      />
      <aside
        className={`sidebar ${menuOpen ? "open" : ""}`}
        id="platform-navigation"
      >
        <button
          aria-label="Close navigation"
          className="sidebar-close"
          onClick={() => setMenuOpen(false)}
          ref={closeButtonRef}
          type="button"
        >
          <CloseIcon />
        </button>
        <Link
          aria-label="QuoteReady Studio overview"
          className="brand"
          href="/"
          onClick={() => setMenuOpen(false)}
        >
          <span className="brand-mark">QS</span>
          <span>
            QUOTE<span className="brand-accent">READY</span>
            <small>STUDIO</small>
          </span>
        </Link>
        <div className="product-tag">
          <span /> Manufacturing intelligence
        </div>
        <nav aria-label="Platform navigation">
          {NAV.map((item) => (
            <Link
              aria-current={activeNav.id === item.id ? "page" : undefined}
              className={activeNav.id === item.id ? "active" : ""}
              href={item.href}
              key={item.id}
              onClick={() => setMenuOpen(false)}
            >
              <span>{item.code}</span>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="zoo-proof">
            <span>Z</span>
            <div>
              <strong>
                {auth.authenticated ? "Zoo connected" : "Zoo ready"}
              </strong>
              <small>Geometry + Agent APIs</small>
            </div>
          </div>
          <p>API Makeathon · 2026</p>
        </div>
      </aside>

      <main className="app-main" id="main-content">
        <header className="topbar">
          <button
            aria-controls="platform-navigation"
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close navigation" : "Open navigation"}
            className="menu-toggle"
            onClick={() => setMenuOpen((open) => !open)}
            ref={menuButtonRef}
            type="button"
          >
            {menuOpen ? <CloseIcon /> : <MenuIcon />}
          </button>
          <div>
            <span className="topbar-code">{activeNav.code}</span>
            <strong>{activeNav.label}</strong>
          </div>
          <div className="topbar-actions">
            {zooMinutes !== null && (
              <span
                className="usage-badge"
                title={`${zooMinutes.toLocaleString("en-US")} Zoo usage minutes remaining (billed per minute)`}
              >
                {zooMinutes >= 10_000
                  ? new Intl.NumberFormat("en-US", {
                      notation: "compact",
                      maximumFractionDigits: 1,
                    }).format(zooMinutes)
                  : zooMinutes}{" "}
                min Zoo left
              </span>
            )}
            <span className="system-status">
              <i /> {connectionLabel}
            </span>
            {auth.user && (
              <div className="user-menu">
                <span className="user-avatar">
                  {auth.user.name.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <strong>{auth.user.name}</strong>
                  <small>{auth.user.email}</small>
                </div>
                <button onClick={() => void disconnectZoo()} type="button">
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>

        {notice && (
          <div className="global-notice" role="alert">
            {notice}
            <button
              aria-label="Dismiss message"
              onClick={() => setNotice(null)}
              type="button"
            >
              <CloseIcon />
            </button>
          </div>
        )}

        <div className="view-container">
          <PlatformContext.Provider value={contextValue}>
            {children}
          </PlatformContext.Provider>
        </div>
      </main>
    </div>
  );
}
