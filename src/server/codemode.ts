import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
  createCodemodeExtension,
  type CodemodeNamespace,
} from "@earendil-works/pi-durable/codemode";

/**
 * One sandbox per host, shared by its conversations. Install `extension` in the
 * same registry as native tools before opening the Harness; close the Harness
 * before close(). No model filters are changed, so native tools remain offered.
 *
 * QuickJS confines script mechanics, not native tool authority: nested tools
 * retain the conversation's OS permissions, environment and cwd. The SDK owns
 * journal, replay, output/store limits and nested task cancellation.
 */
export function createCodeMode(options: { namespaces?: readonly CodemodeNamespace[] } = {}) {
  // `execute()` has a five-minute default; disable it as well as avoiding a
  // host-added deadline for the SDK's durable `start()` path.
  const sandbox = new CodemodeSandbox({ timeoutMs: Infinity });
  const extension = createCodemodeExtension({
    sandbox,
    models: false,
    ...(options.namespaces ? { namespaces: options.namespaces } : {}),
  });
  let closed = false;
  return {
    extension,
    async close() {
      if (closed) return;
      closed = true;
      await sandbox.close();
    },
  };
}
