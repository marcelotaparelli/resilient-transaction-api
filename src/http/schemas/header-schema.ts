import { z } from "zod";

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const transactionIdSchema = z.string().uuid();
