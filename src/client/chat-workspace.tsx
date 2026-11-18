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
import { RegenerationReceiptSchema, RecentRegenerationsSchema } from "../shared/regeneration.ts";
import type { z } from "zod";
import {
  EditBranchReceiptSchema,
  RecentEditOperationsSchema,
  type RecentEditOperation,
} from "../shared/branch-operations.ts";
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
  const [recentEdits, setRecentEdits] = useState<RecentEditOperation[] | null>(null);
  const [recoveryError, setRecoveryError] = useState(false);
  const [recoveryReload, setRecoveryReload] = useState(0);
  const [selectedRecovery, setSelectedRecovery] = useState<string | null>(null);
  const cancelEdit = useRef<HTMLButtonElement>(null);
  const cancelFork = useRef<HTMLButtonElement>(null);
  const [regenerating, setRegenerating] = useState<{
    sourceId: string;
    entryId: string;
    requestId: string;
  } | null>(null);
  const [recentRegenerations, setRecentRegenerations] = useState<
    z.infer<typeof RecentRegenerationsSchema>["operations"] | null
  >(null);
  const [regenerationReadError, setRegenerationReadError] = useState(false);
  const [regenerationReadRevision, setRegenerationReadRevision] = useState(0);
  const [regenerationUncertain, setRegenerationUncertain] = useState(false);
  const uncertainRegenerations = useRef(new Map<string, string>());
  const cancelRegeneration = useRef<HTMLButtonElement>(null);
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
    if (!regenerating) return;
    const controller = new AbortController();
    setRecentRegenerations(null);
    setRegenerationReadError(false);
    void fetch(`/api/chats/${regenerating.sourceId}/regenerations/${regenerating.entryId}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unavailable");
        const result = RecentRegenerationsSchema.parse(await response.json());
        if (
          result.operations.some(
            (item) =>
              item.sourceId !== regenerating.sourceId || item.entryId !== regenerating.entryId,
          )
        )
          throw new Error("Wrong scope");
        if (!controller.signal.aborted) setRecentRegenerations(result.operations);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRegenerationReadError(true);
      });
    return () => controller.abort();
  }, [regenerating?.sourceId, regenerating?.entryId, regenerationReadRevision]);
  useEffect(() => {
    if (!editing) return;
    const controller = new AbortController();
    setRecentEdits(null);
    setRecoveryError(false);
    void fetch(`/api/chats/${editing.sourceId}/edit-operations/${editing.entryId}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Recovery unavailable");
        const result = RecentEditOperationsSchema.parse(await response.json());
        if (
          result.operations.some(
            (item) => item.sourceId !== editing.sourceId || item.entryId !== editing.entryId,
          )
        )
          throw new Error("Wrong recovery scope");
        if (!controller.signal.aborted) setRecentEdits(result.operations);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRecoveryError(true);
      });
    return () => controller.abort();
  }, [editing?.sourceId, editing?.entryId, recoveryReload]);

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
  async function regenerate(request: NonNullable<typeof regenerating>) {
    if (managementInFlight.current || inFlight.current) return;
    managementInFlight.current = true;
    setManaging(true);
    setError(null);
    try {
      const response = await fetch(`/api/chats/${request.sourceId}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw new Error("Not confirmed");
      const receipt = RegenerationReceiptSchema.parse(await response.json());
      if (
        receipt.sourceId !== request.sourceId ||
        receipt.entryId !== request.entryId ||
        receipt.status !== "admitted" ||
        !receipt.submissionId
      )
        throw new Error("Invalid receipt");
      mutationVersion.current++;
      const listResponse = await fetch("/api/chats");
      if (!listResponse.ok) throw new Error("Catalog unavailable");
      const next = ChatCatalogSchema.parse(await listResponse.json());
      if (!next.chats.some((item) => item.id === receipt.branchId && item.status === "regular"))
        throw new Error("Chat unavailable");
      setCatalog(next);
      setRegenerating(null);
      setRegenerationUncertain(false);
      uncertainRegenerations.current.delete(`${request.sourceId}:${request.entryId}`);
      if (activeChatId.current === request.sourceId) switchChat(receipt.branchId);
      setReload((value) => value + 1);
    } catch {
      setRegenerating(activeChatId.current === request.sourceId ? request : null);
      setRegenerationUncertain(true);
      uncertainRegenerations.current.set(
        `${request.sourceId}:${request.entryId}`,
        request.requestId,
      );
      setError(
        "Regeneration was not confirmed. Retry this same request or close and recover it later.",
      );
    } finally {
      managementInFlight.current = false;
      setManaging(false);
    }
  }
  async function openRegeneration(
    item: z.infer<typeof RecentRegenerationsSchema>["operations"][number],
  ) {
    if (!regenerating || managementInFlight.current || inFlight.current) return;
    const source = regenerating.sourceId;
    const entry = regenerating.entryId;
    managementInFlight.current = true;
    setManaging(true);
    try {
      const [operationsResponse, catalogResponse] = await Promise.all([
        fetch(`/api/chats/${source}/regenerations/${entry}`),
        fetch("/api/chats"),
      ]);
      if (!operationsResponse.ok || !catalogResponse.ok) throw new Error("Unavailable");
      const operations = RecentRegenerationsSchema.parse(
        await operationsResponse.json(),
      ).operations;
      const next = ChatCatalogSchema.parse(await catalogResponse.json());
      if (
        !operations.some(
          (candidate) =>
            candidate.sourceId === source &&
            candidate.entryId === entry &&
            candidate.requestId === item.requestId &&
            candidate.branchId === item.branchId &&
            candidate.status === "admitted",
        ) ||
        !next.chats.some((chat) => chat.id === item.branchId && chat.status === "regular")
      )
        throw new Error("Unavailable");
      setCatalog(next);
      setRegenerating(null);
      setRegenerationUncertain(false);
      if (activeChatId.current === source) switchChat(item.branchId);
    } catch {
      setError("The recovered chat is no longer available. Check previous regenerations again.");
      setRegenerationReadRevision((value) => value + 1);
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
          : selectedRecovery
            ? "Resume was rejected. The replacement must exactly match the original, and the branch must remain available and unchanged."
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
                onRegenerate={(entryId) => {
                  if (
                    managementInFlight.current ||
                    inFlight.current ||
                    regenerating ||
                    editing ||
                    id !== activeChatId.current
                  )
                    return;
                  setError(null);
                  const existing = uncertainRegenerations.current.get(`${id}:${entryId}`);
                  setRegenerationUncertain(existing !== undefined);
                  setRegenerating({
                    sourceId: id,
                    entryId: String(entryId),
                    requestId: existing ?? crypto.randomUUID(),
                  });
                }}
                onEdit={(entryId, text) => {
                  if (
                    managementInFlight.current ||
                    inFlight.current ||
                    editing ||
                    regenerating ||
                    id !== activeChatId.current
                  )
                    return;
                  setError(null);
                  setEditUncertain(false);
                  setSelectedRecovery(null);
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
        open={regenerating !== null}
        onOpenChange={(open) => {
          if (!open && !managing) {
            setRegenerating(null);
            setRegenerationUncertain(false);
          }
        }}
      >
        <AlertDialogContent initialFocus={cancelRegeneration}>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate in a new chat?</AlertDialogTitle>
            <AlertDialogDescription>
              The source chat and its draft stay unchanged. The new chat inherits context before
              this answer and configuration at that boundary. Regeneration may repeat tool calls and
              external effects; earlier effects are not undone. Admission does not mean the answer
              has completed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {recentRegenerations === null && (
            <p>
              {regenerationReadError
                ? "Could not check previous regenerations."
                : "Checking previous regenerations…"}
            </p>
          )}
          {regenerationReadError && (
            <Button
              variant="outline"
              onClick={() => setRegenerationReadRevision((value) => value + 1)}
            >
              Retry checking
            </Button>
          )}
          {recentRegenerations && recentRegenerations.length > 0 && (
            <div className="space-y-2">
              <p>
                Previous operations for this answer. Recover one, or deliberately start another.
              </p>
              {recentRegenerations.map((item) => (
                <div key={item.requestId} className="flex items-center gap-2">
                  <span>
                    Chat {item.branchId}: {item.status}
                  </span>
                  {item.status === "admitted" ? (
                    <Button
                      variant="outline"
                      disabled={managing}
                      onClick={() => {
                        void openRegeneration(item);
                      }}
                    >
                      Open created chat
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={managing}
                      onClick={() => {
                        if (regenerating)
                          void regenerate({ ...regenerating, requestId: item.requestId });
                      }}
                    >
                      Resume prepared regeneration
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          {error && regenerationUncertain && (
            <ErrorState
              title="Regeneration not confirmed"
              detail={error}
              retrying={managing}
              onRetry={() => {
                if (regenerating) void regenerate(regenerating);
              }}
            />
          )}
          {error && !regenerationUncertain && <p role="alert">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelRegeneration} disabled={managing}>
              {regenerationUncertain ? "Close and recover later" : "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={managing || recentRegenerations === null}
              onClick={(event) => {
                event.preventDefault();
                if (regenerating) void regenerate(regenerating);
              }}
            >
              {regenerationUncertain
                ? "Retry same regeneration"
                : recentRegenerations?.length
                  ? "Create another regeneration"
                  : "Regenerate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
          {recentEdits === null && (
            <p>{recoveryError ? "Could not check previous edits." : "Checking previous edits…"}</p>
          )}
          {recoveryError && (
            <Button variant="outline" onClick={() => setRecoveryReload((value) => value + 1)}>
              Retry checking previous edits
            </Button>
          )}
          {recentEdits && recentEdits.length > 0 && (
            <div className="space-y-2">
              <p>
                Previous edits for this message. Choose one to recover it, or deliberately create
                another chat below.
              </p>
              {recentEdits.map((operation) => (
                <div key={operation.requestId} className="flex items-center gap-2">
                  <span>
                    Chat {operation.branchId}: {operation.status}
                  </span>
                  {operation.status === "admitted" ? (
                    <Button
                      variant="outline"
                      disabled={managing}
                      onClick={() => {
                        setEditing(null);
                        setEditUncertain(false);
                        switchChat(operation.branchId);
                      }}
                    >
                      Open created chat
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={managing}
                      onClick={() => {
                        if (!editing) return;
                        setEditing({ ...editing, requestId: operation.requestId });
                        setSelectedRecovery(operation.requestId);
                        setEditUncertain(false);
                        setError(null);
                      }}
                    >
                      Select prepared edit
                    </Button>
                  )}
                </div>
              ))}
              {selectedRecovery && (
                <div>
                  <p>
                    Resume only if the replacement text you entered matches the original exactly.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (editing) setEditing({ ...editing, requestId: crypto.randomUUID() });
                      setSelectedRecovery(null);
                      setError(null);
                    }}
                  >
                    Choose a new edit instead
                  </Button>
                </div>
              )}
            </div>
          )}
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
                    "Edit delivery was not confirmed. Reopen the message edit to recover previous operations.",
                  );
                  setReload((value) => value + 1);
                }
              }}
            >
              {editUncertain ? "Close and recover later" : "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={managing || recentEdits === null}
              onClick={(event) => {
                event.preventDefault();
                void editBranch();
              }}
            >
              {editUncertain
                ? "Retry same edit"
                : recentEdits?.some(
                      (item) => item.requestId === editing?.requestId && item.status === "prepared",
                    )
                  ? "Resume selected edit"
                  : recentEdits?.length
                    ? "Create another edited chat"
                    : "Create edited chat"}
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
