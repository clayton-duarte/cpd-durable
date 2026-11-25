import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  redirect,
} from "@tanstack/react-router";
import { ChatWorkspace } from "./chat-workspace.tsx";
import { CHATS_PATH } from "./paths.ts";
import "./index.css";

const rootRoute = createRootRoute();
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: CHATS_PATH, params: {} });
  },
});
// The chat route stays mounted while a message thread opens below it, so the
// transcript, drafts and scroll position survive opening and closing the panel.
const chatsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: CHATS_PATH,
  validateSearch: (search: Record<string, unknown>): { tangent?: string | number } => {
    const value = search["tangent"];
    return value === undefined
      ? {}
      : { tangent: typeof value === "string" || typeof value === "number" ? value : "" };
  },
  component: ChatWorkspace,
});
const threadRoute = createRoute({
  getParentRoute: () => chatsRoute,
  path: "/threads/{-$threadSlug}",
  component: ChatWorkspace,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, chatsRoute.addChildren([threadRoute])]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root.");
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
