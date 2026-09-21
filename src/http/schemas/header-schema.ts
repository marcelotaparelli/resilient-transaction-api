import { z } from "zod";

export const clientIdSchema = z.string().trim().min(1).max(128);
export const idempotencyKeySchema = z.string().trim().min(1).max(128);
export const transactionIdSchema = z.string().uuid();
