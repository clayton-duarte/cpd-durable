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
import { MessageBranches } from "@/components/assistant-ui/elements/message-branches";
import { Button } from "@/components/ui/button";
import { EditBranchReceiptSchema } from "../shared/branch-operations.ts";
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
  const [forking, setForking] = useState<{
    sourceId: string;
    at: string;
    requestId: string;
  } | null>(null);
  const [editing, setEditing] = useState<{
    sourceId: string;
    entryId: string;
    requestId: string;
    text: string;
  } | null>(null);
  const [editUncertain, setEditUncertain] = useState(false);
  const cancelEdit = useRef<HTMLButtonElement>(null);
  const cancelFork = useRef<HTMLButtonElement>(null);
  const activeChatId = useRef(chatId);
  activeChatId.current = chatId;
  const mutationVersion = useRef(0);
  const managementInFlight = useRef(false);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const selected = catalog?.chats.find((item) => item.id === chatId);
  const family = (catalog?.chats ?? []).filter(
    (item) =>
      (item.status === "regular" || item.id === selected?.id) &&
      (item.branchRootId ?? item.id) === (selected?.branchRootId ?? selected?.id),
  );
  const parent = catalog?.chats.find((item) => item.id === selected?.parentId);
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
    setForking((current) => (current?.sourceId === chatId ? current : null));
  }, [chatId]);

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
  async function rename(id: string, title: string) {
    if (managementInFlight.current || inFlight.current)
      throw new Error("Another chat action is pending.");
    const item = catalog?.chats.find((item) => item.id === id);
    if (!item) throw new Error("Chat unavailable.");
    managementInFlight.current = true;
    mutationVersion.current++;
    setManaging(true);
    try {
      const response = await fetch(`/api/chats/${id}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, expected: item.title }),
      });
      if (!response.ok) throw new Error("Rename was not confirmed. Refresh before trying again.");
      const next = ChatCatalogSchema.parse(await response.json());
      mutationVersion.current++;
      setCatalog(next);
      setError(null);
    } catch (error) {
      setError("Rename was not confirmed. Refresh before trying again.");
      throw error;
    } finally {
      managementInFlight.current = false;
      setManaging(false);
    }
  }
  async function fork() {
    if (!forking || managementInFlight.current || inFlight.current) return;
    const request = forking;
    managementInFlight.current = true;
    mutationVersion.current++;
    setManaging(true);
    setError(null);
    try {
      const response = await fetch(`/api/chats/${request.sourceId}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: request.requestId, at: request.at }),
      });
      if (!response.ok) throw new Error("Fork not confirmed");
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
      setForking(null);
      if (activeChatId.current === request.sourceId) switchChat(created.id);
      setReload((value) => value + 1);
    } catch {
      setError(
        "Fork could not be confirmed. Retry uses the same saved boundary and request identity.",
      );
    } finally {
      managementInFlight.current = false;
      setManaging(false);
    }
  }
  async function editBranch() {
    if (!editing || managementInFlight.current || inFlight.current) return;
    const request = editing;
    managementInFlight.current = true;
    setManaging(true);
    setError(null);
    let uncertain = true;
    try {
      const response = await fetch(`/api/chats/${request.sourceId}/edit-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        uncertain = editUncertain || response.status >= 500;
        throw new Error("Edit could not be confirmed.");
      }
      const receipt = EditBranchReceiptSchema.parse(await response.json());
      if (
        receipt.sourceId !== request.sourceId ||
        receipt.entryId !== request.entryId ||
        receipt.status !== "admitted" ||
        !receipt.submissionId
      )
        throw new Error("Mismatched edit receipt.");
      mutationVersion.current++;
      const catalogResponse = await fetch("/api/chats");
      if (!catalogResponse.ok) throw new Error("Edit admitted; chat list unavailable.");
      const next = ChatCatalogSchema.parse(await catalogResponse.json());
      if (!next.chats.some((item) => item.id === receipt.branchId))
        throw new Error("Edit branch unavailable.");
      setCatalog(next);
      setEditing(null);
      setEditUncertain(false);
      if (activeChatId.current === request.sourceId) switchChat(receipt.branchId);
      setReload((value) => value + 1);
    } catch {
      setEditUncertain(uncertain);
      setError(
        uncertain
          ? "Edit delivery could not be confirmed. Retry uses the same source, entry, text and request ID."
          : "Edit was rejected. The original chat remains unchanged.",
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
        onRename: rename,
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
          canRename: true,
          runningIds: new Set(catalog?.chats.filter((item) => item.running).map((item) => item.id)),
        }}
      />
      <SidebarInset className="h-dvh min-w-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 px-3">
          <SidebarTrigger />
          <span className="truncate text-sm">{selected?.title ?? "Chats"}</span>
          {selected?.parentId && (
            <span className="truncate text-xs text-muted-foreground">
              Entry {selected.forkEntryId} from {parent?.title ?? "unavailable source"}
            </span>
          )}
          {parent && (
            <Button size="sm" variant="ghost" onClick={() => switchChat(parent.id)}>
              Open source chat
            </Button>
          )}
          {family.length > 1 && (
            <MessageBranches
              aria-label="Saved conversation branches"
              className="shrink-0 [&>p]:hidden"
              variants={family.map((item) => item.title)}
              index={family.findIndex((item) => item.id === selected?.id)}
              previousLabel="Show previous saved branch"
              nextLabel="Show next saved branch"
              onIndexChange={(index) => {
                const next = family[index];
                if (next) switchChat(next.id);
              }}
            />
          )}
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
                onFork={(entryId) => {
                  if (managementInFlight.current || inFlight.current || id !== activeChatId.current)
                    return;
                  setError(null);
                  setForking({ sourceId: id, at: String(entryId), requestId: crypto.randomUUID() });
                }}
                onEdit={(entryId, text) => {
                  if (
                    managementInFlight.current ||
                    inFlight.current ||
                    editing ||
                    id !== activeChatId.current
                  )
                    return;
                  setError(null);
                  setEditUncertain(false);
                  setEditing({
                    sourceId: id,
                    entryId: String(entryId),
                    text,
                    requestId: crypto.randomUUID(),
                  });
                }}
              />
            </div>
          ))}
        </div>
      </SidebarInset>
      <AlertDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !managing && !editUncertain) setEditing(null);
        }}
      >
        <AlertDialogContent initialFocus={cancelEdit}>
          <AlertDialogHeader>
            <AlertDialogTitle>Edit in a new chat?</AlertDialogTitle>
            <AlertDialogDescription>
              The original chat and its draft remain unchanged. A new chat inherits history before
              the entire saved entry. Earlier-boundary configuration is inherited; editing the first
              entry uses the source chat’s current saved configuration. Sending the replacement
              starts a new response and may execute tools.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <ErrorState
              title="Edit not confirmed"
              detail={error}
              retrying={managing}
              onRetry={() => {
                void editBranch();
              }}
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              ref={cancelEdit}
              disabled={managing}
              onClick={() => {
                if (editUncertain) {
                  setEditing(null);
                  setEditUncertain(false);
                  setError(
                    "Edit delivery was not confirmed. Inspect the chat list before trying a new edit.",
                  );
                  setReload((value) => value + 1);
                }
              }}
            >
              {editUncertain ? "Close and inspect chats" : "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={managing}
              onClick={(event) => {
                event.preventDefault();
                void editBranch();
              }}
            >
              {editUncertain ? "Retry same edit" : "Create edited chat"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={forking !== null}
        onOpenChange={(open) => {
          if (!open && !managing) setForking(null);
        }}
      >
        <AlertDialogContent initialFocus={cancelFork}>
          <AlertDialogHeader>
            <AlertDialogTitle>Fork from saved entry {forking?.at}?</AlertDialogTitle>
            <AlertDialogDescription>
              Create an independent durable chat inheriting history through this entire entry,
              inclusively. Agent configuration is copied at that boundary. Live work, later entries
              and unsent drafts are not copied. This does not regenerate an answer or replay tools.
              The source keeps running unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <ErrorState
              title="Fork not confirmed"
              detail={error}
              retrying={managing}
              onRetry={() => {
                void fork();
              }}
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelFork} disabled={managing}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={managing}
              onClick={(event) => {
                event.preventDefault();
                void fork();
              }}
            >
              Create fork
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
