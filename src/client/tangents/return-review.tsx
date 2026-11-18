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
const DeliverySchema = z.strictObject({
  revision: z.number().int().positive(),
  delivery: z.enum(["available", "admitted"]),
  submissionId: z.number().int().positive().nullable(),
  accepted: z.boolean(),
});
const HeadConflictSchema = z.object({ currentHead: z.string().nullable() });
type DeliveryChoice = {
  revision: number;
  expectedHead?: string | null;
  acknowledgeRetired?: boolean;
};
type Status = z.infer<typeof StatusSchema>;

export function ReturnReview({
  parentId,
  item,
  active,
  readOnly,
  mutationAllowed,
}: {
  parentId: string;
  item: TangentView;
  active: boolean;
  readOnly: boolean;
  mutationAllowed?: (() => boolean) | undefined;
}) {
  const revision = item.latestHandoff.revision;
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [headConflict, setHeadConflict] = useState<{ head: string | null } | null>(null);
  const [retryDelivery, setRetryDelivery] = useState<DeliveryChoice | null>(null);
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
      mutationAllowed?.() === false ||
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
  async function deliver(choice: DeliveryChoice) {
    if (
      !active ||
      readOnly ||
      mutationAllowed?.() === false ||
      pending ||
      error ||
      writing.current ||
      status?.admitted ||
      item.lifecycle !== "open"
    )
      return;
    writing.current = true;
    const current = ++epoch.current;
    setPending(true);
    setDeliveryError(null);
    setRetryDelivery(choice);
    try {
      const response = await fetch(`/api/chats/${parentId}/tangents/${item.id}/deliver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(choice),
      });
      const body: unknown = await response.json().catch(() => null);
      if (epoch.current !== current) return;
      if (!response.ok) {
        const conflict = response.status === 409 ? HeadConflictSchema.safeParse(body) : null;
        if (conflict?.success) {
          setHeadConflict({ head: conflict.data.currentHead });
          setRetryDelivery(null);
          setDeliveryError(
            "The parent context changed. Review the report and explicitly choose whether to deliver to the current context.",
          );
        } else {
          setDeliveryError(
            "Delivery was not confirmed. The parent must be idle; check its state before retrying the same choice.",
          );
        }
        return;
      }
      const result = DeliverySchema.parse(body);
      if (result.revision !== revision || result.delivery !== "admitted") throw new Error();
      setRetryDelivery(null);
      setHeadConflict(null);
      setStatus((previous) =>
        previous ? { ...previous, admitted: true, accepted: result.accepted } : previous,
      );
    } catch {
      if (epoch.current === current)
        setDeliveryError(
          "Delivery was not confirmed. Retry the same choice or check the parent state.",
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
      {deliveryError && <p role="alert">{deliveryError}</p>}
      {headConflict && (
        <div>
          <p>
            Current context head: {headConflict.head ?? "empty"}. The report may refer to retired
            context.
          </p>
          <Button
            type="button"
            disabled={!active || readOnly || pending || !!error || !!status?.admitted}
            onClick={() => {
              void deliver(
                retryDelivery ?? {
                  revision,
                  expectedHead: headConflict.head,
                  acknowledgeRetired: true,
                },
              );
            }}
          >
            {retryDelivery ? "Retry delivery" : "Deliver to current context"}
          </Button>
        </div>
      )}
      {!headConflict && !status?.admitted && (
        <Button
          type="button"
          disabled={
            !active || readOnly || pending || !!error || !status || item.lifecycle !== "open"
          }
          onClick={() => {
            void deliver(retryDelivery ?? { revision });
          }}
        >
          {retryDelivery ? "Retry delivery" : "Bring findings back"}
        </Button>
      )}
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
