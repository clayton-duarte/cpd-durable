import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import { CatalogDoc } from "./chats.ts";

// This is only one half of the integration: create/fork/edit must consult the
// same document before their own writes, or reverse-direction collisions remain.
export const BranchIdentityDoc = defineDoc<{ requests: { id: string; action: string }[] }>({
  kind: "cpd.branch-identities",
  version: 1,
  scope: "session",
  initial: () => ({ requests: [] }),
  checkpointWhen: () => true,
});

export class BranchIdentityError extends Error {}

export async function assertBranchIdentityAvailable(tx: Tx, id: string) {
  const identities = await tx.doc(BranchIdentityDoc);
  if (identities.requests.some((item) => item.id === id))
    throw new BranchIdentityError("Branch request identity already in use.");
}

export async function reserveBranchIdentity(tx: Tx, id: string, action: string) {
  const catalog = await tx.doc(CatalogDoc);
  const identities = await tx.doc(BranchIdentityDoc);
  if (
    catalog.requests?.some((item) => item.requestId === id) ||
    catalog.items.some((item) => item.requestId === id) ||
    catalog.forks?.some((item) => item.requestId === id) ||
    identities.requests.some((item) => item.id === id)
  )
    throw new BranchIdentityError("Branch request identity already in use.");
  return () => identities.requests.push({ id, action });
}
