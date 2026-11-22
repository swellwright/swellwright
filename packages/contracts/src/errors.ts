import { z } from 'zod';

/** Stable, machine-readable error codes. Clients branch on `code`, never on `message`. */
export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'step_up_required',
  'vault_sealed',
  // A secret whose expiry has passed is never handed to a consumer (ADR 0042). `details` has `secretId`, `secretName`.
  'secret_expired',
  'not_found',
  'conflict',
  'rate_limited',
  'not_ready',
  // Servers over SSH (ADR 0037). `host_key_mismatch` and `host_key_replace_required` carry `details`.
  'host_key_not_pinned',
  'host_key_mismatch',
  'host_key_replace_required',
  'address_not_allowed',
  'no_access_entry',
  'ssh_connect_failed',
  'ssh_auth_failed',
  'ssh_key_invalid',
  'ssh_timeout',
  'ssh_failed',
  'facts_unreadable',
  // Commands and scripts (ADR 0038). `confirmation_required` carries `details: { level }`.
  'confirmation_required',
  // Artifacts and their distribution (ADR 0039). `artifact_hash_mismatch` carries `details`.
  'artifact_broken',
  'artifact_busy',
  'artifact_destination_conflict',
  'artifact_hash_mismatch',
  'sudo_unavailable',
  // The Remnawave panel (ADR 0041). `panel_contract_changed` names the endpoint and the field in its details.
  'panel_not_connected',
  'panel_unauthorized',
  'panel_forbidden',
  'panel_unreachable',
  'panel_timeout',
  'panel_contract_changed',
  'panel_unsupported_version',
  'panel_rate_limited',
  // The API console (ADR 0046). The refusals say what is wrong; `console_operation_blocked` carries `details.reason`.
  'console_operation_unknown',
  'console_operation_blocked',
  'console_user_data_disabled',
  'console_response_too_large',
  'console_response_unsupported',
  // Snapshots of the panel (ADR 0043).
  'snapshot_other_panel',
  'snapshot_too_large',
  'snapshot_corrupt',
  'internal_error',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES).meta({ id: 'ErrorCode' });
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** The envelope of every non-2xx response. */
export const ApiErrorSchema = z
  .object({
    error: z.object({
      code: ErrorCodeSchema,
      message: z
        .string()
        .describe('Human-readable text for logs and developers, not for branching.'),
      requestId: z.string().describe('Also sent in the x-request-id response header.'),
      details: z
        .unknown()
        .optional()
        .describe('Optional structured details, for example validation issues.'),
    }),
  })
  .meta({ id: 'ApiError', description: 'Error envelope.' });
export type ApiError = z.infer<typeof ApiErrorSchema>;
