import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TangentChildren, type TangentChildView, type WorkerChildView } from "./children";

export interface TangentWorkspaceProps {
  main: { id: string; title: string };
  tangents: readonly TangentChildView[];
  workers: readonly WorkerChildView[];
  selectedTangentId: string | null;
  navigationDisabled?: boolean;
  onSelectTangent: (id: string) => void;
  onCloseTangent: () => void;
  // These must return stable, independently scoped Chat instances. All open
  // tangents stay mounted; active means visible observation, not execution.
  renderMain: (active: boolean) => ReactNode;
  renderTangent: (tangent: TangentChildView, active: boolean) => ReactNode;
}

function useNarrow() {
  const [narrow, setNarrow] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(max-width: 767px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function TangentWorkspace(props: TangentWorkspaceProps) {
  const { main, tangents, workers, selectedTangentId } = props;
  const [pane, setPane] = useState<"main" | "tangent">(selectedTangentId ? "tangent" : "main");
  const narrow = useNarrow();
  const strip = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const available = tangents.filter((t) => t.parentId === main.id && t.lifecycle === "open");
  const selected = available.find((t) => t.id === selectedTangentId);
  const selectedId = selected?.id ?? null;
  const previous = useRef(selectedId);
  useEffect(() => {
    if (previous.current !== selectedId) {
      setPane(selectedId ? "tangent" : "main");
      previous.current = selectedId;
    }
  }, [selectedId]);
  const effectivePane = selected ? pane : "main";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={strip}>
        <TangentChildren
          parentId={main.id}
          tangents={tangents}
          workers={workers}
          selectedTangentId={selectedId}
          selectionDisabled={props.navigationDisabled ?? false}
          onSelectTangent={(id) => {
            setPane("tangent");
            props.onSelectTangent(id);
          }}
        />
      </div>
      {selected && (
        <Tabs
          value={effectivePane}
          onValueChange={(value: unknown) => {
            if (value === "main") setPane("main");
            if (value === "tangent") setPane("tangent");
          }}
          className="md:hidden"
        >
          <TabsList aria-label="Chat pane" className="md:hidden">
            <TabsTrigger id={`${panelId}-main-tab`} aria-controls={`${panelId}-main`} value="main">
              {main.title}
            </TabsTrigger>
            <TabsTrigger
              id={`${panelId}-tangent-tab`}
              aria-controls={`${panelId}-tangent`}
              value="tangent"
            >
              {selected.title}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      <div className="flex min-h-0 flex-1">
        <div
          id={`${panelId}-main`}
          role={narrow && selected ? "tabpanel" : "region"}
          aria-labelledby={narrow && selected ? `${panelId}-main-tab` : undefined}
          hidden={narrow && effectivePane !== "main"}
          className={`min-h-0 min-w-0 flex-1 flex-col ${!narrow || effectivePane === "main" ? "flex" : ""}`}
          aria-label={`Main chat: ${main.title}`}
        >
          {props.renderMain(!narrow || effectivePane === "main")}
        </div>
        <div
          id={`${panelId}-tangent`}
          role={narrow && selected ? "tabpanel" : "region"}
          aria-labelledby={narrow && selected ? `${panelId}-tangent-tab` : undefined}
          hidden={!selected || (narrow && effectivePane !== "tangent")}
          className={`min-h-0 min-w-0 flex-1 flex-col md:border-l ${selected && (!narrow || effectivePane === "tangent") ? "flex" : ""}`}
          aria-label={selected ? `Tangent chat: ${selected.title}` : "Tangent chat"}
        >
          {available.map((item) => (
            <div
              key={item.id}
              hidden={selectedId !== item.id}
              className={selectedId === item.id ? "flex min-h-0 flex-1 flex-col" : undefined}
            >
              <header className="flex items-center justify-between gap-2">
                <h2>
                  {item.title} · {item.model}
                </h2>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const opener = strip.current?.querySelector<HTMLButtonElement>(
                      'button[aria-pressed="true"]',
                    );
                    props.onCloseTangent();
                    setPane("main");
                    opener?.focus();
                  }}
                >
                  Close tangent
                </Button>
              </header>
              <TangentChildren
                parentId={item.id}
                tangents={[]}
                workers={workers}
                selectedTangentId={null}
                onSelectTangent={props.onSelectTangent}
              />
              {props.renderTangent(
                item,
                selectedId === item.id && (!narrow || effectivePane === "tangent"),
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
