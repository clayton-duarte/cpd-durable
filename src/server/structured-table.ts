import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { TableInputSchema, TableInputShape } from "../shared/structured-table.ts";

/** A pure formatter: its data is supplied by its caller, not independently verified. */
export function createTableExtension() {
  return defineExtension({
    name: "cpd-display-table",
    tools: [
      defineTool({
        name: "display_table",
        description:
          "Present caller-provided scalar table data. This does not query or verify the data.",
        parameters: TableInputShape,
        prepareArguments: (input) => TableInputSchema.parse(input),
        replay: "safe",
        callers: ["model", "tools"],
        async execute(input) {
          const table = TableInputSchema.parse(input);
          return {
            output: [
              {
                type: "text" as const,
                text: `Caller-provided table: ${table.rows.length} rows, ${table.columns.length} columns.`,
              },
            ],
            details: { version: 1, table: JSON.parse(JSON.stringify(table)) as JsonValue },
          };
        },
      }),
    ],
  });
}
