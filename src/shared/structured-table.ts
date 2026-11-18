import { z } from "zod";

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const ColumnId = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .refine((id) => !forbidden.has(id));
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !/[<>]/.test(value), "Markup is not supported.");
const Scalar = z.union([text(8192), z.number().finite(), z.boolean(), z.null()]);
const Column = z.strictObject({
  id: ColumnId,
  label: text(200).refine((value) => value.length > 0),
  type: z.enum(["string", "number", "boolean"]).optional(),
});

// Kept separately for the SDK's input schema conversion; cross-field checks run at execution.
export const TableInputShape = z.strictObject({
  columns: z.array(Column).min(1).max(20),
  rows: z.array(z.record(ColumnId, Scalar)).max(200),
  title: text(300).optional(),
  caption: text(1000).optional(),
  source: text(300).optional(),
});

const ValidTable = TableInputShape.superRefine((table, ctx) => {
  const ids = new Set(table.columns.map((column) => column.id));
  if (ids.size !== table.columns.length)
    ctx.addIssue({ code: "custom", message: "Column IDs must be unique." });
  for (const row of table.rows) {
    for (const [key, value] of Object.entries(row)) {
      const column = table.columns.find((item) => item.id === key);
      if (!column) ctx.addIssue({ code: "custom", message: "Row contains an unknown column." });
      else if (value !== null && column.type && typeof value !== column.type)
        ctx.addIssue({ code: "custom", message: "Cell type does not match its column." });
    }
  }
  if (new TextEncoder().encode(JSON.stringify(table)).length > 65536)
    ctx.addIssue({ code: "custom", message: "Table exceeds the 65536-byte limit." });
});

export const TableInputSchema = z
  .unknown()
  .superRefine((input, ctx) => {
    if (!input || typeof input !== "object" || !("rows" in input) || !Array.isArray(input.rows))
      return;
    for (const row of input.rows as unknown[]) {
      if (row && typeof row === "object")
        for (const key of Object.keys(row))
          if (forbidden.has(key)) ctx.addIssue({ code: "custom", message: "Unsafe row key." });
    }
  })
  .pipe(ValidTable);

export const TableDetailsSchema = z.strictObject({
  version: z.literal(1),
  table: TableInputSchema,
});
