import { z } from 'zod';

// The API console (ADR 0046): a safe explorer of the panel's API. The operations come from the frozen description of
// the panel; the console sends only GET requests, always to the panel that is connected, with the stored token, and
// everything that comes back is masked before it leaves this server. Nothing in these schemas can carry a secret: the
// request names an operation and its parameters (never a URL or a header), and the answer is masked text.

export const CONSOLE_AVAILABILITIES = ['open', 'user_data', 'blocked', 'write'] as const;
export const PanelConsoleAvailabilitySchema = z.enum(CONSOLE_AVAILABILITIES).meta({
  id: 'PanelConsoleAvailability',
  description:
    "`open`: a read of the panel's own objects. `user_data`: a read about the people who use the panel (users, devices, subscriptions, requests, usage): off unless the installation allows it, and then needs `vault:reveal` and a fresh second factor. `blocked`: never sent (see `blockedReason`). `write`: not a GET; listed so the API can be read, never sent by this console (writes arrive with the approvals of a later phase).",
});
export type PanelConsoleAvailability = z.infer<typeof PanelConsoleAvailabilitySchema>;

export const CONSOLE_BLOCKED_REASONS = ['secret_material', 'side_effect'] as const;
export const PanelConsoleBlockedReasonSchema = z.enum(CONSOLE_BLOCKED_REASONS).meta({
  id: 'PanelConsoleBlockedReason',
  description:
    '`secret_material`: the answer is a key, a link that works as a credential or a subscription body. `side_effect`: a GET that creates something on the panel (a passkey challenge).',
});
export type PanelConsoleBlockedReason = z.infer<typeof PanelConsoleBlockedReasonSchema>;

export const PanelConsoleParamSchema = z
  .object({
    name: z.string(),
    in: z.enum(['path', 'query']),
    required: z.boolean(),
    description: z.string().nullable(),
    kind: z
      .enum(['string', 'number', 'boolean', 'structured'])
      .describe(
        "`structured` is an array or an object (the table state of the panel's own pages): the console does not send it.",
      ),
    format: z.enum(['uuid', 'date', 'date-time', 'email']).nullable(),
    enum: z.array(z.string()).nullable(),
    minimum: z.number().nullable(),
    maximum: z.number().nullable(),
    default: z.union([z.string(), z.number(), z.boolean()]).nullable(),
  })
  .meta({ id: 'PanelConsoleParam' });
export type PanelConsoleParam = z.infer<typeof PanelConsoleParamSchema>;

export const PanelConsoleOperationSchema = z
  .object({
    operationId: z
      .string()
      .describe("The panel's own identifier, e.g. `NodesController_getNodes`."),
    method: z.enum(['get', 'post', 'put', 'patch', 'delete']),
    path: z.string().describe('As the description of the panel writes it: `/api/nodes/{uuid}`.'),
    group: z.string().describe('The panel\'s tag without "Controller": `Nodes`.'),
    summary: z.string(),
    description: z.string().nullable(),
    availability: PanelConsoleAvailabilitySchema,
    blockedReason: PanelConsoleBlockedReasonSchema.nullable(),
    adminOnly: z
      .boolean()
      .describe(
        'The description says an API token may not call it: only an administrator session can, so the panel answers 403 to the token this console holds.',
      ),
    publicEndpoint: z.boolean().describe('The description lists no security for it.'),
    scopes: z.array(z.string()).describe('The scopes the description names; none today.'),
    deprecated: z.boolean(),
    parameters: z.array(PanelConsoleParamSchema),
    hasRequestBody: z.boolean(),
    responseContentTypes: z.array(z.string()),
  })
  .meta({ id: 'PanelConsoleOperation' });
export type PanelConsoleOperation = z.infer<typeof PanelConsoleOperationSchema>;

export const PanelConsoleOperationDetailSchema = PanelConsoleOperationSchema.extend({
  requestBodySchema: z
    .unknown()
    .describe(
      'JSON Schema of the request body, references followed; null for an operation without a body.',
    ),
  responseSchema: z
    .unknown()
    .describe(
      'JSON Schema of the successful answer, references followed; null when there is none.',
    ),
}).meta({ id: 'PanelConsoleOperationDetail' });
export type PanelConsoleOperationDetail = z.infer<typeof PanelConsoleOperationDetailSchema>;

export const PanelConsoleCatalogueSchema = z
  .object({
    specVersion: z.string().describe('The version of the panel the catalogue was made for.'),
    settings: z.object({
      userDataEnabled: z
        .boolean()
        .describe(
          '`SW_PANEL_CONSOLE_USER_DATA`: whether the operations about people can be sent at all.',
        ),
      ratePerMinute: z.number().int().positive(),
      maxBodyKib: z.number().int().positive(),
    }),
    counts: z.object({
      total: z.number().int(),
      get: z.number().int(),
      open: z.number().int(),
      userData: z.number().int(),
      blocked: z.number().int(),
      write: z.number().int(),
    }),
    operations: z.array(PanelConsoleOperationSchema),
  })
  .meta({
    id: 'PanelConsoleCatalogue',
    description:
      "Every operation of the panel's API, built from the frozen description that ships with this server: nothing is asked of the panel to list it.",
  });
export type PanelConsoleCatalogue = z.infer<typeof PanelConsoleCatalogueSchema>;

export const PanelConsoleOperationParamsSchema = z.object({
  operationId: z.string().min(1).max(200),
});

const ConsoleValue = z.union([z.string().max(2048), z.number(), z.boolean()]);

export const PanelConsoleRequestSchema = z
  .object({
    operationId: z
      .string()
      .min(1)
      .max(200)
      .describe('An operation of the catalogue. Nothing else is sent.'),
    pathParams: z
      .record(z.string().max(100), ConsoleValue)
      .optional()
      .describe(
        'Values for the `{placeholders}` of the path, checked against what the description says each one is.',
      ),
    query: z
      .record(z.string().max(100), ConsoleValue)
      .optional()
      .describe('Query parameters of the operation (only those it lists), checked the same way.'),
  })
  .meta({
    id: 'PanelConsoleRequest',
    description:
      'What to ask the panel. Never a URL or a header: the target is the connected panel, the path is the catalogue path with the checked values filled in.',
  });
export type PanelConsoleRequest = z.infer<typeof PanelConsoleRequestSchema>;

export const PanelConsoleResultSchema = z
  .object({
    operationId: z.string(),
    method: z.literal('get'),
    path: z
      .string()
      .describe(
        'The path of the operation with its placeholders, as in the catalogue. Never the values.',
      ),
    status: z.number().int().describe('The HTTP status the panel answered with, whatever it is.'),
    durationMs: z.number().int().nonnegative().describe('Retries and waits included.'),
    attempts: z.number().int().positive(),
    headers: z
      .record(z.string(), z.string())
      .describe('Only `content-type`, `content-length`, `retry-after` and `x-ratelimit-*`.'),
    contentType: z.string().nullable(),
    bodyFormat: z.enum(['json', 'text', 'empty']),
    body: z
      .string()
      .describe(
        'The masked answer: JSON indented by two spaces, or the masked text. Cut at the size limit (see `truncated`).',
      ),
    bodyBytes: z
      .number()
      .int()
      .nonnegative()
      .describe("The size of the panel's answer before masking and cutting."),
    truncated: z.boolean(),
    masked: z.boolean().describe('True when at least one value was replaced by a mask.'),
    maskedCount: z.number().int().nonnegative(),
    maskProfile: z
      .enum(['standard', 'personal'])
      .describe(
        '`personal` also hides who a person is (names, mail, addresses, device ids): the operations about people.',
      ),
    sentAt: z.iso.datetime(),
  })
  .meta({
    id: 'PanelConsoleResult',
    description:
      'The answer of the panel, as far as it may be shown. A 404 or a 403 from the panel is a result (200 here); a panel that cannot be reached, refuses the token or answers in a way that cannot be shown is an error with its own code.',
  });
export type PanelConsoleResult = z.infer<typeof PanelConsoleResultSchema>;

export const PanelConsoleIssuesSchema = z
  .object({
    issues: z.array(z.object({ path: z.string(), message: z.string() })),
  })
  .meta({
    id: 'PanelConsoleIssues',
    description:
      'The `details` of a `validation_failed` answer of the console: which field of the request is wrong, and how.',
  });
export type PanelConsoleIssues = z.infer<typeof PanelConsoleIssuesSchema>;

/** The limits the console runs with; the defaults of the settings `SW_PANEL_CONSOLE_*`. */
export const PANEL_CONSOLE_DEFAULTS = { ratePerMinute: 30, maxBodyKib: 1024 } as const;
