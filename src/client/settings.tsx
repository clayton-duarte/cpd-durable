import { ModelTierSettings, type ModelTierSettingsApi } from "./model-tier-settings.tsx";

const api: ModelTierSettingsApi = {
  async read(signal) {
    const response = await fetch("/api/model-policy", signal ? { signal } : {});
    if (!response.ok) throw new Error("Model settings unavailable");
    return (await response.json()) as unknown;
  },
  async save(change, signal) {
    const response = await fetch("/api/model-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error("Model settings not confirmed");
    return (await response.json()) as unknown;
  },
};

export function Settings() {
  return <ModelTierSettings api={api} />;
}
