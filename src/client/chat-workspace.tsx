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
  const selected = catalog?.chats.find((item) => item.id === chatId);
  const mounted = selected && !visited.includes(selected.id) ? [...visited, selected.id] : visited;
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
      try {
        const response = await fetch("/api/chats");
        if (!response.ok) throw new Error("Catalog unavailable");
        const next = ChatCatalogSchema.parse(await response.json());
        if (active) {
          // No delete API exists. An older list must not retire a chat whose
          // creation was acknowledged while that read was in flight.
          setCatalog((current) => ({
            ...next,
            chats: [
              ...next.chats,
              ...(current?.chats.filter(
                (item) => !next.chats.some((entry) => entry.id === item.id),
              ) ?? []),
            ],
          }));
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
    if (!chatId && catalog) void navigate({ params: { chatId: catalog.rootId }, replace: true });
  }, [chatId, catalog?.rootId, navigate]);

  function switchChat(id: string) {
    sidebar.setOpenMobile(false);
    void navigate({ params: { chatId: id } });
  }
  async function create() {
    if (inFlight.current) return;
    inFlight.current = true;
    creation.current ??= crypto.randomUUID();
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: creation.current }),
      });
      if (!response.ok) throw new Error("Creation unavailable");
      const created = ChatSummarySchema.parse(await response.json());
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
  // This runtime presents navigation metadata only. Each Chat below retains its
  // own immutable runtime; pi-durable alone owns execution and transcripts.
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    convertMessage: (message) => message,
    onNew: async () => {},
    adapters: {
      threadList: {
        threadId: chatId ?? "workspace",
        threads: (catalog?.chats ?? []).map((item) => ({
          id: item.id,
          title: item.title,
          status: "regular" as const,
        })),
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
          createDisabled: creating || !catalog,
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
            actionLabel="Open original chat"
            onRetry={() => switchChat(catalog.rootId)}
          />
        )}
        {mounted.map((id) => (
          <div
            key={id}
            hidden={id !== selected?.id}
            className="min-h-0 flex-1"
            style={{ display: id === selected?.id ? "flex" : "none", flexDirection: "column" }}
          >
            <ChatPage chatId={id} active={id === selected?.id} />
          </div>
        ))}
      </SidebarInset>
    </AssistantRuntimeProvider>
  );
}
