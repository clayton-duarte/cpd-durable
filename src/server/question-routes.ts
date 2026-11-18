import { type ConversationId } from "@earendil-works/pi-durable";
import { QuestionAnswerSchema, QuestionProjectionSchema } from "../shared/questions.ts";
import { CatalogDoc, ChatLifecycleError, type ChatScope } from "./chats.ts";
import { readQuestions, resolveQuestion, type QuestionAccessGuard } from "./questions.ts";

/** Catalog policy must be evaluated in the very same SDK transaction as task and question state. */
function catalogGuard(onArchived: (archived: boolean) => void): QuestionAccessGuard {
  return async (tx, id, action) => {
    const catalog = await tx.doc(CatalogDoc);
    const item = catalog.items.find((entry) => entry.id === id);
    if (!item || item.status === "deleted") throw new ChatLifecycleError("Chat not found.", 404);
    const archived = item.status === "archived";
    onArchived(archived);
    if (archived && action === "resolve")
      throw new ChatLifecycleError("Restore this archived chat before answering.", 409);
  };
}

export async function questionProjection(scope: ChatScope) {
  let archived = false;
  const questions = await readQuestions(
    scope.conversation,
    scope.conversation.id,
    catalogGuard((value) => {
      archived = value;
    }),
  );
  return QuestionProjectionSchema.parse({
    conversationId: String(scope.conversation.id),
    questions: questions.map((question) =>
      archived ? { ...question, actionable: false } : question,
    ),
  });
}

export async function answerQuestion(scope: ChatScope, input: unknown) {
  const request = QuestionAnswerSchema.parse(input);
  try {
    return await resolveQuestion(
      scope.conversation,
      scope.conversation.id as ConversationId,
      request.questionId,
      request.taskId,
      request.revision,
      request.resolution,
      catalogGuard(() => {}),
    );
  } catch (error) {
    if (error instanceof ChatLifecycleError) throw error;
    throw new ChatLifecycleError(
      "Question changed, was cancelled, or the answer is invalid. Refresh before trying again.",
      409,
    );
  }
}
