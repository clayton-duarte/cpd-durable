import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { TangentView } from "../../shared/tangents.ts";

const StatusSchema = z.strictObject({
  revision: z.number().int().positive(),
  admitted: z.boolean(),
  placed: z.boolean(),
  submissionStatus: z.unknown(),
  accepted: z.boolean(),
});
const AcceptSchema = z.strictObject({
  revision: z.number().int().positive(),
  accepted: z.boolean(),
});
type Status = z.infer<typeof StatusSchema>;

export function ReturnReview({
  parentId,
  item,
  active,
  readOnly,
}: {
  parentId: string;
  item: TangentView;
  active: boolean;
  readOnly: boolean;
}) {
  const revision = item.latestHandoff.revision;
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState(false);
  const epoch = useRef(0);
  const writing = useRef(false);
  useEffect(() => {
    const current = ++epoch.current;
    if (!active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch(
          `/api/chats/${parentId}/tangents/${item.id}/returns/${revision}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error();
        const next = StatusSchema.parse(await response.json());
        if (next.revision !== revision) throw new Error();
        if (alive && epoch.current === current && !writing.current) {
          setStatus(next);
          setError(null);
        }
      } catch {
        if (alive && epoch.current === current && !writing.current)
          setError("Return status unavailable. Refresh before accepting.");
      } finally {
        if (alive)
          timer = setTimeout(() => {
            void poll();
          }, 2000);
      }
    }
    void poll();
    return () => {
      alive = false;
      epoch.current++;
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, parentId, item.id, revision, reload]);

  async function accept() {
    if (
      !active ||
      readOnly ||
      pending ||
      error ||
      !status?.placed ||
      status.accepted ||
      writing.current
    )
      return;
    writing.current = true;
    const current = ++epoch.current;
    setPending(true);
    try {
      const response = await fetch(`/api/chats/${parentId}/tangents/${item.id}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision }),
      });
      if (!response.ok) throw new Error();
      const result = AcceptSchema.parse(await response.json());
      if (result.revision !== revision || !result.accepted) throw new Error();
      if (epoch.current !== current) return;
      setStatus((previous) => (previous ? { ...previous, accepted: true } : previous));
      setError(null);
    } catch {
      if (epoch.current === current)
        setError(
          "Acceptance was not confirmed. Refresh the status and review the report before retrying.",
        );
    } finally {
      writing.current = false;
      setPending(false);
      setReload((value) => value + 1);
    }
  }
  return (
    <section aria-label={`Return report revision ${revision}`}>
      <p>
        Return report from {item.title} ·{" "}
        {item.model.name ?? `${item.model.provider}/${item.model.modelId}`} · revision {revision}
      </p>
      <Textarea
        readOnly
        aria-label="Return handoff for review"
        value={JSON.stringify(item.latestHandoff.handoff, null, 2)}
      />
      <p>
        {!status
          ? "Checking delivery status…"
          : status.placed
            ? "Placed in parent context"
            : status.admitted
              ? "Admitted; not yet placed"
              : "Available; not admitted"}
      </p>
      {status?.submissionStatus != null && (
        <p>
          Submission status:{" "}
          {typeof status.submissionStatus === "string"
            ? status.submissionStatus
            : JSON.stringify(status.submissionStatus)}
        </p>
      )}
      <p>
        {status?.accepted ? "Accepted by parent review." : "Not accepted by parent review."}{" "}
        Acceptance records a review decision, not model comprehension.
      </p>
      <p>Delivery integration pending.</p>
      {error && <p role="alert">{error}</p>}
      <Button
        type="button"
        disabled={!active || readOnly || pending || !!error || !status?.placed || !!status.accepted}
        onClick={() => {
          void accept();
        }}
      >
        Accept reviewed return
      </Button>
    </section>
  );
}
