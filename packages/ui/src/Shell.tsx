import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
type ShellCtx = { accountMenu: (align?: "left" | "right") => ReactNode };
const ShellContext = createContext<ShellCtx>({ accountMenu: () => null });

/**
 * The page's scroller. On iOS 26 the document's own scroll view gets a system "scroll edge effect" (a progressive blur) under the
 * status bar and toolbars, which smeared our title and avatar. So the document never scrolls: the shell is exactly one viewport
 * tall and this element scrolls inside it, below the safe area, where the system draws no effect.
 */
export const APP_SCROLL_ID = "app-scroll";
/**
 * Where every page's title bar is rendered (a portal), ABOVE the scroller rather than sticky inside it. The page content then
 * never scrolls underneath the header, so iOS 26 has nothing to draw its top "scroll edge" blur over: on long pages the
 * blur used to appear exactly where content slid under the pinned header, below the status bar.
 */
export const APP_HEADER_ID = "app-header";
export function appScroller(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.getElementById(APP_SCROLL_ID);
}

/** ok = connected (green, gently pulsing), wait = connecting / needs a scan / not responding (amber), error = server offline, idle = not linked (grey). */
export type StatusTone = "ok" | "wait" | "error" | "idle";
export const STATUS_BG: Record<StatusTone, string> = { ok: "bg-ok", wait: "bg-warn", error: "bg-error", idle: "bg-outline" };
/** The same colours as text (currentColor), for rings and the box-shadow pulse. */
export const STATUS_TEXT: Record<StatusTone, string> = { ok: "text-ok", wait: "text-warn", error: "text-error", idle: "text-outline" };
/** Connected and connecting breathe; offline and not linked stay still. */
export const statusPulses = (tone: StatusTone) => tone === "ok" || tone === "wait";
export function StatusDot({ tone, size = 10, ring }: { tone: StatusTone; size?: number; /** A ring in the surface colour, for sitting on top of something. */ ring?: boolean }) {
  // The pulse is a box-shadow animation (paint only). A scale/opacity animation would make iOS composite this dot and
  // everything it overlaps into a layer, which rasterised the header avatar blurry.
  return (
    <span
      aria-hidden
      className={cx("inline-flex flex-none rounded-full", STATUS_BG[tone], STATUS_TEXT[tone], statusPulses(tone) && "status-pulse", ring && "ring-2 ring-surface")}
      style={{ width: size, height: size }}
    />
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
  railFooter,
  banner,
  logo,
  children,
}: {
  nav: NavEntry[];
  /** Used for the logo link's label, e.g. "Nothing BOT Comedy". */
  appName: string;
  /** The account button (and menu). Rendered in the rail on desktop and in each page header on phones. */
  accountMenu: (align?: "left" | "right") => ReactNode;
  /** Pinned under the account button in the desktop rail. */
  railFooter?: ReactNode;
  /** Full-width strip above the page (e.g. demo banner). */
  banner?: ReactNode;
  /** The app's own mark for the rail; defaults to the curator app's Logo. */
  logo?: ReactNode;
  children: ReactNode;
}) {
  const loc = useLocation();
  // A new page starts at its top (the document used to be the scroller; now it's <main>).
  useEffect(() => {
    appScroller()?.scrollTo(0, 0);
  }, [loc.pathname]);
  // Nothing may ever scroll the document or the shell frame (scrollIntoView, focus(), drag autoscroll and keyboard all can, even
  // on overflow:hidden boxes). If anything does, put it back at once and say so in dev, so a page that does it is found.
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const se = () => document.scrollingElement as HTMLElement;
    const fix = (what: string) => {
      if (import.meta.env.DEV) console.warn(`[shell] ${what} scrolled; resetting. Something called scrollIntoView/focus/scrollTo on a page.`, document.activeElement);
      window.scrollTo(0, 0);
      se().scrollTop = 0;
      if (frame.current) frame.current.scrollTop = 0;
    };
    const onDoc = () => se().scrollTop !== 0 && fix("the document");
    const onFrame = () => frame.current && frame.current.scrollTop !== 0 && fix("the shell frame");
    window.addEventListener("scroll", onDoc, { passive: true });
    frame.current?.addEventListener("scroll", onFrame, { passive: true });
    const f = frame.current;
    if (import.meta.env.DEV && se().scrollHeight > innerHeight + 1) console.warn("[shell] the document is taller than the viewport; something sits outside main#app-scroll.");
    return () => {
      window.removeEventListener("scroll", onDoc);
      f?.removeEventListener("scroll", onFrame);
    };
  }, []);
  return (
    <ShellContext.Provider value={{ accountMenu }}>
      {/* One viewport tall, and padded below the status bar: the scroller (main) starts under it, so nothing ever scrolls beneath the notch. */}
      <div ref={frame} className="flex h-dvh overflow-clip bg-surface pt-[env(safe-area-inset-top)]">
        {/* Rail >= 600px */}
        <nav aria-label="Main" className="hidden h-full w-24 flex-none flex-col items-center gap-3 bg-surface pt-5 pb-5 sm:flex">
          <NavLink to="/" aria-label={`${appName} home`} className="mb-5">
            {logo ?? <Logo className="size-11" />}
          </NavLink>
          {nav.map((n) => (
            <NavItem key={n.to} {...n} rail />
          ))}
          <div className="flex-1" />
          {accountMenu("left")}
          {railFooter}
        </nav>

        {/* The header slot sits above the scroller in a column: the scroller starts below the header, so nothing scrolls under it. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div id={APP_HEADER_ID} className="relative z-30 flex-none bg-surface" />
          <main id={APP_SCROLL_ID} className="min-h-0 min-w-0 flex-1 overflow-x-clip overflow-y-auto overscroll-y-contain pb-[calc(var(--nav-h)+1rem)] [-webkit-overflow-scrolling:touch] sm:pb-0">
            {banner}
            {/* CSS keyframes, not AnimatePresence: they always run to the end, so a route can never get stuck invisible. */}
            <div key={loc.pathname} className="page-enter">
              {children}
            </div>
          </main>
        </div>

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

export function PageHeader({ title, subtitle, actions, trailing, bar, children, width = "full" }: { title: ReactNode; /** "narrow" keeps the header on the same centred column as a max-w-3xl page body. */ width?: "full" | "narrow"; /** A toolbar pinned as part of the header (e.g. date nav). Same sticky box, so it can never drift from the title bar. */ bar?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; /** Small control kept on the title's line at every width (e.g. a help link). */ trailing?: ReactNode; children?: ReactNode }) {
  const { accountMenu } = useContext(ShellContext);
  const ref = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  const collapsible = !!subtitle;
  // Inside AppShell the bar renders into the header slot above the scroller (see APP_HEADER_ID); elsewhere it stays inline and sticky.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setSlot(document.getElementById(APP_HEADER_ID)), []);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    // --page-header-h is what sticky bars INSIDE the scroller offset by: 0 when the header lives above the scroller.
    // --app-header-h is the header's real height, for layouts sized against the viewport (100dvh minus the header).
    const publish = () => {
      headerOwner = el;
      const h = `${el.getBoundingClientRect().height}px`;
      root.style.setProperty("--page-header-h", slot ? "0px" : h);
      root.style.setProperty("--app-header-h", h);
    };
    const ro = new ResizeObserver(() => headerOwner === el || !headerOwner?.isConnected ? publish() : undefined);
    publish();
    ro.observe(el);
    return () => {
      ro.disconnect();
      // Only the header that set the value clears it: a page re-rendering its header must not wipe the new one's.
      if (headerOwner === el) {
        headerOwner = null;
        root.style.removeProperty("--page-header-h");
        root.style.removeProperty("--app-header-h");
      }
    };
  }, [slot]);
  // Phone collapse. Layout is measured, never animated: the header's box is its COLLAPSED height (so --page-header-h is what
  // sticky sub-bars need) plus a bottom margin of the collapsible height D, so the page always flows at the expanded height and
  // scrolling never jumps. The subtitle is an overlay: scroll progress p (0..1 over the first D pixels of scroll)
  // drives only transforms and opacity, so the pinned bar lands exactly on the content edge at every frame.
  useEffect(() => {
    const el = ref.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const sc: HTMLElement | Window = appScroller() ?? window;
    let d = 0;
    let frame = 0;
    const top = () => (sc instanceof Window ? window.scrollY : sc.scrollTop);
    const apply = () => {
      frame = 0;
      const y = top();
      const p = d > 0 ? Math.min(1, Math.max(0, y / d)) : 0;
      el.style.setProperty("--p", p.toFixed(3));
      if ((p > 0.5) !== (el.dataset.collapsed === "1")) el.dataset.collapsed = p > 0.5 ? "1" : "0";
      setStuck(y > Math.max(2, d - 1));
    };
    const measure = () => {
      d = 0; // nothing collapses any more (see the header markup); kept for the stuck shadow and --page-header-h
      el.style.setProperty("--d", `${d}px`);
      el.style.setProperty("--hh", `${Math.max(0, inner.offsetHeight - d)}px`);
      apply();
    };
    const onScroll = () => (frame ||= requestAnimationFrame(apply));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(inner);
    if (subRef.current) ro.observe(subRef.current);
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      sc.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [collapsible, slot]);
  const titleBar = (
    <>
    {/* Desktop breathing room above the title. Outside the bar, so the bar itself never changes height. */}
    <div aria-hidden className="hidden h-6 sm:block" />
    <header
      ref={ref}
      data-stuck={stuck || undefined}
      data-collapsible={collapsible || undefined}
      // The solid colour MUST be on this sticky element itself. Safari on iOS 26 looks for a sticky/fixed, full-width bar at the
      // top with an opaque background-color and extends that colour under the status bar; when it finds none (our colour used
      // to live only on the child layer below, so this element was transparent) it draws its frosted "scroll edge" blur over
      // the title and avatar instead. Requests and Chats looked fine only because their own sticky strips carry bg-surface.
      className={cx("group/hdr z-30 bg-surface", slot ? "relative" : "sticky top-0")}
    >
      {/* Hairline/shadow layer (no backdrop-filter: iOS repaints it every scroll frame, which flickers). Only this changes when stuck. */}
      <div
        aria-hidden
        className={cx(
          "absolute inset-0 -z-10 bg-surface transition-shadow duration-200 motion-reduce:transition-none",
          stuck ? "shadow-[0_1px_0_var(--color-outline-variant),0_6px_12px_-8px_rgb(0_0_0/0.5)]" : "shadow-[0_1px_0_transparent]",
        )}
      />
      <div ref={innerRef} className="relative px-4 pt-3 pb-2 sm:px-8 sm:pt-4 sm:pb-3">
      <div className={cx(width === "narrow" && "mx-auto w-full max-w-[44rem]")}>
      {/* Phones: the title row is the first row. The account button sits at its right edge, centred on the title's line (desktop keeps it in the nav rail). */}
      <div className="absolute top-3 right-4 z-10 flex h-11 items-center sm:hidden">{accountMenu()}</div>
      {/* Wraps instead of squeezing: the title keeps its natural width, so a wide action (week switcher) drops to a second line
          rather than turning "Requests" into "Re…". */}
      <div className="relative flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 max-sm:pr-[3.25rem]">
        <h1
          // No scale on the title: a scaled text layer renders blurry on iPhone. The title keeps its size; the subtitle collapses.
          className="min-w-0 max-w-full flex-auto truncate type-headline-m sm:type-display-s"
        >
          {title}
        </h1>
        {trailing && <div className="flex flex-none items-center">{trailing}</div>}
        {actions && <div className="flex flex-none items-center gap-1.5 sm:gap-2">{actions}</div>}
      </div>
      {/* No scroll-linked transforms anywhere in the header: iOS drew a transformed header as a blurry bitmap (title and avatar).
          The subtitle sits below the pinned header on every width and simply scrolls away with the page. */}
      <div>
        {children}
        {bar && <div className="mt-2 sm:mt-3">{bar}</div>}
      </div>
      </div>
      </div>
    </header>
    </>
  );
  return (
    <>
    {slot ? createPortal(titleBar, slot) : titleBar}
    {/* The subtitle sits under the pinned title bar and scrolls away with the page (phones and desktop alike). */}
    {subtitle && (
      <div ref={subRef} className="px-4 pt-0.5 pb-3 sm:px-8">
        <p className={cx("min-w-0 max-w-full type-body-m text-on-surface-variant", width === "narrow" && "mx-auto w-full max-w-[44rem]")}>{subtitle}</p>
      </div>
    )}
    </>
  );
}
