// The curator app's pages, one chunk each (see @spot/ui lazyRoute). Pages outside the signed-in app are in App.tsx.
import { lazyRoute, prefetchRoutes as prefetch, type RouteComponent } from "@spot/ui";

export const Home = lazyRoute(() => import("../routes/Calendar").then((m) => ({ default: m.Home })));
export const Requests = lazyRoute(() => import("../routes/Requests").then((m) => ({ default: m.Requests })));
export const Messages = lazyRoute(() => import("../routes/Messages").then((m) => ({ default: m.Messages })));
export const LineupBoard = lazyRoute(() => import("../routes/Lineup").then((m) => ({ default: m.LineupBoard })));
export const Comics = lazyRoute(() => import("../routes/Comics").then((m) => ({ default: m.Comics })));
export const Shows = lazyRoute(() => import("../routes/Shows").then((m) => ({ default: m.Shows })));
export const SettingsPage = lazyRoute(() => import("../routes/Settings").then((m) => ({ default: m.SettingsPage })));
export const ServerPage = lazyRoute(() => import("../routes/Server").then((m) => ({ default: m.ServerPage })));
export const AdminArea = lazyRoute(() => import("../routes/Admin").then((m) => ({ default: m.AdminArea })));
export const HelpPage = lazyRoute(() => import("../routes/Help").then((m) => ({ default: m.HelpPage })));

const BY_PATH: Record<string, RouteComponent> = { "/": Home, "/requests": Requests, "/messages": Messages, "/lineup": LineupBoard, "/comics": Comics, "/shows": Shows, "/settings": SettingsPage };

/** Once signed in: the open page's chunk now, the everyday pages while idle, and any page whose link is hovered or touched. */
export const prefetchRoutes = () => prefetch(BY_PATH, ["/requests", "/lineup", "/comics", "/shows", "/messages", "/", "/settings"]);

// The page being opened starts downloading with the main bundle, not after sign-in has finished and the router has rendered.
BY_PATH[location.pathname]?.preload();
