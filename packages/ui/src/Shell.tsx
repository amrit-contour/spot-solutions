import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { cx, type Icon } from "./ui";
import { Logo } from "./Logo";

export type NavEntry = {
  to: string;
  label: string;
  /** Shorter label for the phone bottom bar. */
  short?: string;
  icon: Icon;
  /** Small count bubble on the icon (e.g. updates that need you). Omit or 0 for none. */
  badge?: ReactNode;
  /** Screen-reader text appended to the badge. */
  badgeLabel?: string;
  /** Left out of the phone bottom bar (reachable from the account menu instead). */
  phoneHidden?: boolean;
};

/** What PageHeader needs from the app around it, supplied by AppShell. */
type ShellCtx = { accountMenu: (align?: "left" | "right") => ReactNode; phoneStatus?: ReactNode };
const ShellContext = createContext<ShellCtx>({ accountMenu: () => null });

export function StatusDot({ tone }: { tone: "ok" | "wait" | "error" | "idle" }) {
  const c = { ok: "bg-ok", wait: "bg-primary", error: "bg-error", idle: "bg-outline" }[tone];
  return (
    <span className="relative inline-flex size-2.5">
      {tone !== "idle" && tone !== "error" && <span className={cx("pulse-ring absolute inset-0 rounded-full", c)} />}
      <span className={cx("relative size-2.5 rounded-full", c)} />
    </span>
  );
}

function NavItem({ to, label, short, icon: I, badge, badgeLabel, rail }: NavEntry & { rail?: boolean }) {
  return (
    <NavLink to={to} end={to === "/"} className="group flex min-w-0 flex-1 flex-col items-center gap-1 outline-none sm:flex-none">
      {({ isActive }) => (
        <>
          <span className={cx("state-layer relative grid h-8 w-12 place-items-center sm:w-14 rounded-full transition-colors duration-200", isActive ? "text-on-nav-active" : "text-on-surface-variant", rail && "h-8")}>
            {isActive && <motion.span layoutId={rail ? "nav-rail" : "nav-bar"} className="absolute inset-0 rounded-full bg-nav-active" transition={{ type: "spring", duration: 0.45, bounce: 0.2 }} />}
            <I className="icon relative size-6" />
            {badge ? (
              <span className="absolute top-0 right-2.5 grid min-w-4 place-items-center rounded-full bg-error px-1 type-label-s leading-4 text-on-error ring-2 ring-surface sm:right-2.5">
                {badge}
                {badgeLabel && <span className="sr-only"> {badgeLabel}</span>}
              </span>
            ) : null}
          </span>
          <span className={cx("type-label-m max-sm:text-[11px]! max-sm:tracking-normal! transition-colors", isActive ? "text-on-surface" : "text-on-surface-variant")}>{short && !rail ? short : label}</span>
        </>
      )}
    </NavLink>
  );
}

/**
 * The app frame: a nav rail on desktop, a bottom bar on phones, and the page in between.
 * The nav list, app name and the account menu come from the app, so every Spot app shares one shell.
 */
export function AppShell({
  nav,
  appName,
  accountMenu,
  phoneStatus,
  railFooter,
  banner,
  children,
}: {
  nav: NavEntry[];
  /** Used for the logo link's label, e.g. "Nothing BOT Comedy". */
  appName: string;
  /** The account button (and menu). Rendered in the rail on desktop and in each page header on phones. */
  accountMenu: (align?: "left" | "right") => ReactNode;
  /** Shown at the left of each page header on phones (e.g. connection status). */
  phoneStatus?: ReactNode;
  /** Pinned under the account button in the desktop rail. */
  railFooter?: ReactNode;
  /** Full-width strip above the page (e.g. demo banner). */
  banner?: ReactNode;
  children: ReactNode;
}) {
  const loc = useLocation();
  return (
    <ShellContext.Provider value={{ accountMenu, phoneStatus }}>
      <div className="flex min-h-dvh bg-surface">
        {/* Installed app: the status bar / notch area is painted with the page colour, so scrolled content never shows through it. */}
        <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-50 h-[env(safe-area-inset-top)] bg-surface" />
        {/* Rail >= 600px */}
        <nav aria-label="Main" className="sticky top-0 hidden h-dvh w-24 flex-none flex-col items-center gap-3 bg-surface pt-[calc(1.25rem+env(safe-area-inset-top))] pb-5 sm:flex">
          <NavLink to="/" aria-label={`${appName} home`} className="mb-5">
            <Logo className="size-11" />
          </NavLink>
          {nav.map((n) => (
            <NavItem key={n.to} {...n} rail />
          ))}
          <div className="flex-1" />
          {accountMenu("left")}
          {railFooter}
        </nav>

        <main className="min-w-0 flex-1 pt-[env(safe-area-inset-top)] pb-[calc(var(--nav-h)+1rem)] sm:pb-0">
          {banner}
          {/* CSS keyframes, not AnimatePresence: they always run to the end, so a route can never get stuck invisible. */}
          <div key={loc.pathname} className="page-enter">
            {children}
          </div>
        </main>

        {/* Bottom bar < 600px */}
        <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 flex h-[var(--nav-h)] items-center bg-surface-container px-1 pb-[var(--nav-pad)] sm:hidden">
          {nav.filter((n) => !n.phoneHidden).map((n) => (
            <NavItem key={n.to} {...n} />
          ))}
        </nav>
      </div>
    </ShellContext.Provider>
  );
}

/**
 * Every page's title bar. It stays pinned at the top while the page scrolls (one fixed height; it frosts over content),
 * and publishes its height as --page-header-h so bars below it (StickyBar, Requests tabs) pin just under it.
 */
/** The header currently publishing --page-header-h (one page at a time). */
let headerOwner: HTMLElement | null = null;

export function PageHeader({ title, subtitle, actions, trailing, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; /** Small control kept on the title's line at every width (e.g. a help link). */ trailing?: ReactNode; children?: ReactNode }) {
  const { accountMenu, phoneStatus } = useContext(ShellContext);
  const ref = useRef<HTMLElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const publish = () => {
      headerOwner = el;
      root.style.setProperty("--page-header-h", `${el.getBoundingClientRect().height}px`);
    };
    const ro = new ResizeObserver(() => headerOwner === el || !headerOwner?.isConnected ? publish() : undefined);
    publish();
    ro.observe(el);
    // Also after the shrink/grow transition settles, in case the last resize frame was mid-animation.
    el.addEventListener("transitionend", publish);
    return () => {
      ro.disconnect();
      el.removeEventListener("transitionend", publish);
      // Only the header that set the value clears it: a page re-rendering its header must not wipe the new one's.
      if (headerOwner === el) {
        headerOwner = null;
        root.style.removeProperty("--page-header-h");
      }
    };
  }, []);
  // Frosted as soon as anything scrolls under it. The bar's height never changes, so there's no threshold dance.
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      const y = window.scrollY;
      setStuck(y > 2);
    };
    const onScroll = () => (frame ||= requestAnimationFrame(read));
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <>
    {/* Desktop breathing room above the title. Outside the sticky bar, so the bar itself never changes height. */}
    <div aria-hidden className="hidden h-6 sm:block" />
    <header
      ref={ref}
      data-stuck={stuck || undefined}
      // One fixed height, scrolled or not: only the glass and the hairline change. Anything that resized here would make
      // the bars pinned under it (they read its height) lag a frame behind and flash a gap while scrolling.
      className="sticky top-[env(safe-area-inset-top)] isolate z-30 px-4 pt-4 pb-3 sm:px-8 sm:pt-4"
    >
      {/* The glass is its own layer behind the bar's content and runs up under the notch strip, so the avatar, status and
          title always sit on top of it at full strength. */}
      <div
        aria-hidden
        className={cx(
          "pointer-events-none absolute inset-x-0 bottom-0 -top-[env(safe-area-inset-top)] -z-10 border-b transition-[background-color,border-color] duration-200 motion-reduce:transition-none",
          stuck ? "border-outline-variant bg-surface/85 backdrop-blur-md" : "border-transparent bg-surface",
        )}
      />
      {/* Phones: status + account on top. Desktop keeps both in the nav rail. */}
      <div className="mb-2 flex items-center gap-3 sm:hidden">
        <div className="mr-auto min-w-0">{phoneStatus}</div>
        {accountMenu()}
      </div>
      <div className="flex items-center gap-3">
        <h1 className="min-w-0 flex-1 truncate type-headline-m sm:type-display-s">{title}</h1>
        {trailing && <div className="flex flex-none items-center">{trailing}</div>}
        {/* Page actions live on the title's line at every width; the title truncates to make room. */}
        {actions && <div className="flex flex-none items-center gap-1.5 sm:gap-2">{actions}</div>}
      </div>
      {children}
    </header>
    {/* The subtitle scrolls away with the page instead of collapsing inside the bar. */}
    {subtitle && <p className="px-4 pb-2 type-body-l text-on-surface-variant sm:px-8">{subtitle}</p>}
    </>
  );
}
