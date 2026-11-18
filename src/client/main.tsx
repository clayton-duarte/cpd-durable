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
import "./index.css";

const rootRoute = createRootRoute();
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/chats/{-$chatId}", params: {} });
  },
});
const chatsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chats/{-$chatId}",
  component: ChatWorkspace,
});
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, chatsRoute]) });

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
