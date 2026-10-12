import { z } from 'zod';

export const createOrderSchema = z.object({
  customerId: z.string().min(1, 'Customer ID is required'),
  gameId: z.string().min(1, 'Game ID is required'),
  packageId: z.string().min(1, 'Package ID is required'),
  playerUid: z.string().min(1, 'Player UID is required'),
  amount: z.number().positive('Amount must be greater than zero'),
  currency: z.string().default('THB'),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const listOrdersQuerySchema = z.object({
  tab: z.enum(['current', 'history'], {
    errorMap: () => ({ message: "tab must be either 'current' or 'history'" }),
  }),
  page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 1))
    .refine((val) => !isNaN(val) && val > 0, { message: 'page must be a positive integer' }),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 10))
    .refine((val) => !isNaN(val) && val > 0 && val <= 100, {
      message: 'limit must be between 1 and 100',
    }),
});

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

export const reportIssueSchema = z.object({
  customerId: z.string().min(1, 'Customer ID is required'),
  issueType: z.string().min(1, 'Issue type is required'),
  description: z.string().min(5, 'Description must be at least 5 characters'),
});

export type ReportIssueInput = z.infer<typeof reportIssueSchema>;

export const retryUidSchema = z.object({
  newPlayerUid: z.string().min(1, 'New player UID is required'),
});

export type RetryUidInput = z.infer<typeof retryUidSchema>;

export const refundSchema = z.object({
  reason: z.string().optional().default('Customer requested refund'),
});

export type RefundInput = z.infer<typeof refundSchema>;
