import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { TaskCard } from "../src/client/components/assistant-ui/elements/task-card.tsx";

it("retains the stock disclosure mode and accepts a domain-neutral selection label", () => {
  const disclosure = renderToStaticMarkup(
    createElement(TaskCard, { label: "Task", state: "waiting", children: "Details" }),
  );
  expect(disclosure).toContain('aria-expanded="false"');
  const selection = renderToStaticMarkup(
    createElement(TaskCard, {
      label: "Task",
      state: "working",
      onSelect: () => {},
      selected: true,
      selectionLabel: "Choose task",
      stateLabel: "Working with details",
    }),
  );
  expect(selection).toContain('aria-label="Choose task"');
  expect(selection).toContain('aria-pressed="true"');
  expect(selection).toContain('aria-description="Working with details"');
  expect(selection).not.toContain('<span class="sr-only">Working with details</span>');
  expect(selection).not.toContain("aria-expanded");
  expect(disclosure).toContain('<span class="sr-only">waiting</span>');
});

it("rejects conflicting selection and disclosure at runtime", () => {
  const invalid = {
    label: "Task",
    state: "waiting",
    onSelect: () => {},
    selected: false,
    selectionLabel: "Choose task",
    children: "Details",
  } as unknown as ComponentProps<typeof TaskCard>;
  expect(() => renderToStaticMarkup(createElement(TaskCard, invalid))).toThrow(
    "TaskCard selection cannot also disclose children",
  );
});

it("separates visible label and metadata outside their individually trimmed spans", () => {
  const selection = renderToStaticMarkup(
    createElement(TaskCard, {
      label: "Architecture review",
      meta: "idle · Model 2",
      state: "waiting",
      onSelect: () => {},
      selected: true,
      selectionLabel: "Selected tangent: Architecture review idle · Model 2",
    }),
  );
  expect(selection).toMatch(/Architecture review<\/span> <span[^>]*>idle · Model 2<\/span>/);
});
