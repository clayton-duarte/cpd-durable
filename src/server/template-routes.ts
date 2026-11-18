import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ChatScope } from "./chats.ts";
import { discoverResources, MAX_RESOURCE_SECTION_BYTES } from "./resources/index.ts";
import {
  TemplateContentSchema,
  TemplateListSchema,
  type TemplateItem,
} from "../shared/templates.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function item(template: {
  path: string;
  name: string;
  text: string;
  truncated: boolean;
}): TemplateItem {
  return {
    id: hash(template.path),
    fingerprint: hash(JSON.stringify([template.path, template.text, template.truncated])),
    name: template.name,
    path: template.path,
    truncated: template.truncated,
  };
}
async function snapshot(scope: ChatScope) {
  const before = await scope.conversation.agent(BACKGROUND_CONTEXT);
  if (!before.cwd) throw new Error("Conversation working directory unavailable");
  const resources = await discoverResources(before.cwd);
  const after = await scope.conversation.agent(BACKGROUND_CONTEXT);
  if (before.cwd !== after.cwd) throw new Error("Conversation working directory changed");
  return resources;
}
export async function listTemplates(scope: ChatScope) {
  const resources = await snapshot(scope);
  const view = {
    conversationId: String(scope.conversation.id),
    templates: [] as TemplateItem[],
    issues: [] as { path: string; reason: string }[],
    omitted: 0,
  };
  const fits = () => Buffer.byteLength(JSON.stringify(view)) <= MAX_RESOURCE_SECTION_BYTES - 32;
  for (const template of resources.templates) {
    const parsed = TemplateItemSchemaSafe(item(template));
    if (!parsed) {
      view.omitted++;
      continue;
    }
    view.templates.push(parsed);
    if (!fits()) {
      view.templates.pop();
      view.omitted++;
    }
  }
  for (const issue of resources.issues) {
    if (!issue.path.includes("/.pi/prompts") && !issue.reason.includes("ancestor limit")) continue;
    if (view.issues.length >= 1000 || issue.path.length > 4096 || issue.reason.length > 4096) {
      view.omitted++;
      continue;
    }
    view.issues.push(issue);
    if (!fits()) {
      view.issues.pop();
      view.omitted++;
    }
  }
  return TemplateListSchema.parse(view);
}
function TemplateItemSchemaSafe(value: TemplateItem) {
  return value.name.length <= 1024 && value.path.length <= 4096 && value.name.length > 0
    ? value
    : undefined;
}
export async function readTemplate(scope: ChatScope, id: string, fingerprint: string) {
  const resources = await snapshot(scope);
  const template = resources.templates.find((entry) => hash(entry.path) === id);
  if (!template || item(template).fingerprint !== fingerprint) return undefined;
  return TemplateContentSchema.parse({
    conversationId: String(scope.conversation.id),
    template: item(template),
    text: template.text,
  });
}
