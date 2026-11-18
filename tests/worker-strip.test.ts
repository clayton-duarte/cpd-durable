import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { WorkerStrip } from "../src/client/workers/strip.tsx";

it("renders supplied status and an inspect action without inventing progress", () => {
  const html = renderToStaticMarkup(
    createElement(WorkerStrip, {
      workers: [
        {
          requestId: "request",
          taskId: "42",
          childId: "43",
          mode: "background",
          model: { provider: "provider", modelId: "model" },
          modelName: "Actual model",
          status: "unknown",
          stop: "requested",
          answerEntryId: null,
          delivery: "notify-only",
        },
      ],
      onInspect: () => {},
    }),
  );
  expect(html).toContain('data-slot="agent-status"');
  expect(html).toContain("unknown · Actual model");
  expect(html).toContain("Inspect worker 42");
  expect(html).not.toContain("%");
});
