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
    }),
  );
  expect(selection).toContain('aria-label="Choose task"');
  expect(selection).toContain('aria-pressed="true"');
  expect(selection).not.toContain("aria-expanded");
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
