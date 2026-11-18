import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { ThreadListSidebar } from "@/components/assistant-ui/elements/threadlist-sidebar.aui";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { ChatCatalogSchema, ChatSummarySchema, type ChatCatalog } from "../shared/chats.ts";
import { ChatPage } from "./chat-page.tsx";
import { ApiErrorSchema } from "../shared/chat.ts";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";

export function ChatWorkspace() {
  return (
    <SidebarProvider>
      <Workspace />
    </SidebarProvider>
  );
}

function Workspace() {
  const { chatId } = useParams({ from: "/chats/{-$chatId}" });
  const navigate = useNavigate({ from: "/chats/{-$chatId}" });
  const sidebar = useSidebar();
  const [catalog, setCatalog] = useState<ChatCatalog>();
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const creation = useRef<string | null>(null);
  const inFlight = useRef(false);
  const [reload, setReload] = useState(0);
  const [visited, setVisited] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const mutationVersion = useRef(0);
  const managementInFlight = useRef(false);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const selected = catalog?.chats.find((item) => item.id === chatId);
  const fallback =
    catalog?.chats.find((item) => item.id === catalog.rootId && item.status === "regular") ??
    catalog?.chats.find((item) => item.status === "regular");
  const retained = visited.filter((id) => catalog?.chats.some((item) => item.id === id));
  const mounted =
    selected && !retained.includes(selected.id) ? [...retained, selected.id] : retained;
  useEffect(() => {
    if (selected)
      setVisited((current) =>
        current.includes(selected.id) ? current : [...current, selected.id],
      );
  }, [selected?.id]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const version = mutationVersion.current;
      try {
        const response = await fetch("/api/chats");
        if (!response.ok) throw new Error("Catalog unavailable");
        const next = ChatCatalogSchema.parse(await response.json());
        if (active && version === mutationVersion.current) {
          setCatalog(next);
          setError((current) => (current === "Chat list could not be refreshed." ? null : current));
        }
      } catch {
        if (active) setError("Chat list could not be refreshed.");
      } finally {
        if (active)
          timer = setTimeout(() => {
            void refresh();
          }, 2000);
      }
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [reload]);

  useEffect(() => {
    if (!chatId && catalog) {
      const fallback =
        catalog.chats.find((item) => item.id === catalog.rootId && item.status === "regular") ??
        catalog.chats.find((item) => item.status === "regular");
      if (fallback) void navigate({ params: { chatId: fallback.id }, replace: true });
    }
  }, [chatId, catalog, navigate]);

  function switchChat(id: string) {
    sidebar.setOpenMobile(false);
    void navigate({ params: { chatId: id } });
  }
  async function create() {
    if (inFlight.current || managementInFlight.current) return;
    inFlight.current = true;
    mutationVersion.current++;
    creation.current ??= crypto.randomUUID();
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: creation.current }),
      });
      if (!response.ok) {
        if (response.status < 500) creation.current = null;
        throw new Error("Creation unavailable");
      }
      const created = ChatSummarySchema.parse(await response.json());
      mutationVersion.current++;
      setCatalog((current) =>
        current
          ? {
              ...current,
              chats: [...current.chats.filter((item) => item.id !== created.id), created],
            }
          : { rootId: created.id, chats: [created] },
      );
      creation.current = null;
      switchChat(created.id);
      setReload((value) => value + 1);
    } catch {
      setError("Chat creation could not be confirmed. Retry safely.");
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
  }
  async function manage(id: string, action: "archive" | "unarchive" | "delete") {
    if (managementInFlight.current || inFlight.current) return;
    managementInFlight.current = true;
    mutationVersion.current++;
    setManaging(true);
    setError(null);
    try {
      const response = await fetch(`/api/chats/${id}/manage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        const failure = ApiErrorSchema.parse(await response.json());
        throw new Error(failure.error);
      }
      const next = ChatCatalogSchema.parse(await response.json());
      mutationVersion.current++;
      setCatalog(next);
      setDeleting(null);
      setReload((value) => value + 1);
      if (chatId === id && action !== "unarchive") {
        const fallback = next.chats.find((item) => item.status === "regular");
        sidebar.setOpenMobile(false);
        void navigate({ params: { chatId: fallback?.id }, replace: true });
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Chat action could not be confirmed. Refresh the list before retrying.",
      );
    } finally {
      managementInFlight.current = false;
      setManaging(false);
    }
  }
  // This runtime presents navigation metadata only. Each Chat below retains its
  // own immutable runtime; pi-durable alone owns execution and transcripts.
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    convertMessage: (message) => message,
    onNew: async () => {},
    adapters: {
      threadList: {
        threadId: chatId ?? "workspace",
        threads: (catalog?.chats ?? [])
          .filter((item) => item.status === "regular")
          .map((item) => ({
            id: item.id,
            title: item.title,
            status: "regular" as const,
          })),
        archivedThreads: (catalog?.chats ?? [])
          .filter((item) => item.status === "archived")
          .map((item) => ({ id: item.id, title: item.title, status: "archived" as const })),
        onArchive: (id) => manage(id, "archive"),
        onUnarchive: (id) => manage(id, "unarchive"),
        onDelete: async (id) => {
          setDeleting(id);
        },
        isLoading: !catalog,
        onSwitchToNewThread: create,
        onSwitchToThread: switchChat,
      },
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadListSidebar
        collapsible="offcanvas"
        threadList={{
          createDisabled: creating || managing || !catalog,
          canManage: true,
          runningIds: new Set(catalog?.chats.filter((item) => item.running).map((item) => item.id)),
        }}
      />
      <SidebarInset className="h-dvh min-w-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 px-3">
          <SidebarTrigger />
          <span className="truncate text-sm">{selected?.title ?? "Chats"}</span>
        </header>
        {error && (
          <ErrorState
            title="Chats unavailable"
            detail={error}
            retrying={creating}
            onRetry={() => {
              if (creation.current) void create();
              else {
                setError(null);
                setReload((value) => value + 1);
              }
            }}
          />
        )}
        {catalog && chatId && !selected && (
          <ErrorState
            title="Chat not found"
            retrying={false}
            detail="This chat is not available in this session."
            actionLabel={
              fallback
                ? fallback.id === catalog.rootId
                  ? "Open original chat"
                  : "Open another chat"
                : "New chat"
            }
            onRetry={() => {
              if (fallback) switchChat(fallback.id);
              else void create();
            }}
          />
        )}
        <div className="relative min-h-0 flex-1">
          {mounted.map((id) => (
            <div
              key={id}
              inert={id !== selected?.id}
              aria-hidden={id !== selected?.id}
              className="absolute inset-0 flex min-h-0 flex-col"
              style={{ visibility: id === selected?.id ? "visible" : "hidden" }}
            >
              <ChatPage
                chatId={id}
                active={id === selected?.id}
                readOnly={catalog?.chats.find((item) => item.id === id)?.status === "archived"}
              />
            </div>
          ))}
        </div>
      </SidebarInset>
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !managing) setDeleting(null);
        }}
      >
        <AlertDialogContent initialFocus={cancelDelete}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat?</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently remove “{catalog?.chats.find((item) => item.id === deleting)?.title}” from
              this app and discard its unsent draft. This cannot be undone here. Underlying
              pi-durable records remain in storage; this does not erase them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <ErrorState
              title="Delete not confirmed"
              detail={error}
              retrying={managing}
              onRetry={() => {
                if (deleting) void manage(deleting, "delete");
              }}
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelDelete} disabled={managing}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={managing}
              onClick={(event) => {
                event.preventDefault();
                if (deleting) void manage(deleting, "delete");
              }}
            >
              Delete chat
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AssistantRuntimeProvider>
  );
}
