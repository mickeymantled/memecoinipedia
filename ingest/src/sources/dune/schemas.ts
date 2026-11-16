/**
 * Response shapes for the Dune API, written from Dune's documentation (read 2026-11-15), not
 * from live responses. Every field is lenient (nullish) because nothing was recorded.
 * Where two pages disagree, both spellings are accepted:
 *
 * - Usage: the example shows `billingPeriods`, the OpenAPI schema `billing_periods`.
 * - Status: the state is `QUERY_STATE_CANCELED` in the state list, while the timestamp field is
 *   `cancelled_at`. Both spellings of the state are treated as cancelled.
 */
import { z } from 'zod';

const num = z.number().nullish();
const str = z.string().nullish();

export const executeResponseSchema = z.object({
  execution_id: z.string().min(1),
  state: str,
});

export const resultMetadataSchema = z.object({
  column_names: z.array(z.string()).nullish(),
  column_types: z.array(z.string()).nullish(),
  row_count: num,
  total_row_count: num,
  datapoint_count: num,
  execution_time_millis: num,
  pending_time_millis: num,
  result_set_bytes: num,
  total_result_set_bytes: num,
});

export const statusResponseSchema = z.object({
  execution_id: str,
  query_id: num,
  state: z.string(),
  is_execution_finished: z.boolean().nullish(),
  submitted_at: str,
  execution_started_at: str,
  execution_ended_at: str,
  expires_at: str,
  cancelled_at: str,
  execution_cost_credits: num,
  queue_position: num,
  error: z
    .object({
      type: str,
      message: str,
      metadata: z.object({ line: num, column: num }).nullish(),
    })
    .nullish(),
  result_metadata: resultMetadataSchema.nullish(),
});
export type DuneStatusResponse = z.infer<typeof statusResponseSchema>;

export const cancelResponseSchema = z.object({ success: z.boolean() });

const periodSchema = z
  .object({
    start_date: str,
    end_date: str,
    credits_used: num,
    credits_included: num,
    // camelCase fallbacks, in case the live API follows the example's spelling.
    creditsUsed: num,
    creditsIncluded: num,
    startDate: str,
    endDate: str,
  })
  .transform((p) => ({
    startDate: p.start_date ?? p.startDate ?? null,
    endDate: p.end_date ?? p.endDate ?? null,
    creditsUsed: p.credits_used ?? p.creditsUsed ?? null,
    creditsIncluded: p.credits_included ?? p.creditsIncluded ?? null,
  }));

export const usageResponseSchema = z
  .object({
    private_queries: num,
    private_dashboards: num,
    bytes_used: num,
    bytes_allowed: num,
    billing_periods: z.array(periodSchema).nullish(),
    billingPeriods: z.array(periodSchema).nullish(),
  })
  .transform((u) => ({
    privateQueries: u.private_queries ?? null,
    privateDashboards: u.private_dashboards ?? null,
    bytesUsed: u.bytes_used ?? null,
    bytesAllowed: u.bytes_allowed ?? null,
    billingPeriods: u.billing_periods ?? u.billingPeriods ?? [],
  }));
