import { z } from "zod";

export const transactionSchema = z.object({
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z
    .string()
    .trim()
    .length(3)
    .regex(/^[A-Za-z]{3}$/)
    .transform((currency) => currency.toUpperCase()),
  description: z.string().trim().min(1).max(200),
}).strict();
