// The WebSocket protocol between the portal (server/providers.ts) and a provider's connector: FFBox's, for
// now (docs/ffbox-connector-contract.md, docs/ffbox-integration.md). The connector dials out to /provider;
// every message is JSON data, one per frame, and neither side can make the other run anything.
// Phase 1 is read-only: the connector reports, the portal records and shows. The phase 3 work messages (submit,
// diagnose, stop, and the connector's accepted/refused) are defined below, with the person each is for
// (`requestedBy`), but the portal does not send them yet.
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { redactSecrets } from './secrets.ts';

/**
 * The protocol number the welcome names. Information only since 2026-10-03 (docs/ffbox-connector-contract.md, "No
 * negotiation"): nothing is gated on it, and a hello of any number, or none, is answered. The welcome echoes a hello's
 * 1 or 2 (the connector checks 1 <= welcome.protocol <= its own) and says 2 otherwise.
 */
export const PROVIDER_PROTOCOL = 2;

/**
 * welcome.accepts: every connector→portal message this portal's code handles beyond the reports. Static, never the
 * intake settings: a board_check or request while the intake is off is answered error not_enabled, so a change of
 * settings never needs a new welcome.
 */
export const PORTAL_ACCEPTS: readonly string[] = ['board_check', 'board_summary', 'request', 'accepted', 'refused', 'result', 'metrics', 'dev_request', 'dev_chunk', 'dev_message', 'dev_received', 'updater'];

/** A connector token: `ffpv1_` and 32 random bytes, base64url. The portal keeps only its SHA-256. */
export const PROVIDER_TOKEN = /^ffpv1_[A-Za-z0-9_-]{43}$/;
export const PROVIDER_TOKEN_ANYWHERE = /ffpv1_[A-Za-z0-9_-]{43}/g;

export function mintProviderToken(): string {
  return `ffpv1_${randomBytes(32).toString('base64url')}`;
}

export const tokenSha256 = (token: string) => createHash('sha256').update(token).digest('hex');

/** Close codes the portal uses. The connector's backoff depends on them (docs/ffbox-connector-contract.md). */
export const CLOSE = {
  /** A newer connection with the same token took over. */
  replaced: 4000,
  /** A frame that cannot be parsed (not JSON, no type, a field of the wrong JSON type), a bad hello, or too many invalid messages. */
  badMessage: 4400,
  /** The provider was switched off (providers.ffbox.enabled false) while connected. */
  disabled: 4403,
  /** No hello within HELLO_TIMEOUT_MS. */
  noHello: 4408,
  /** More messages than the rate limit allows. */
  tooFast: 4429,
} as const;

export const LIMITS = {
  /** Largest frame the portal reads. */
  maxMessageBytes: 64 * 1024,
  /** Token bucket for connector messages: the steady rate, and the burst a catch-up may use. */
  messagesPerSecond: 100,
  burst: 1000,
  helloTimeoutMs: 10_000,
  /** Invalid messages tolerated per minute before the portal closes with 4400. */
  invalidPerMinute: 20,
} as const;

// ---------------------------------------------------------------- building blocks

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const iso = z.string().max(40).regex(ISO, 'an ISO 8601 time with a zone, e.g. 2026-09-27T10:15:00Z');
const count = z.number().int().min(0).max(1_000_000);
const cursor = z.string().min(1).max(120);
/** A container class name, e.g. "ffagent". */
const className = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

const modelName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/);
/** full: any well-briefed task. simple: small, well-scoped work only (docs/ffbox-integration.md, routing). */
const tier = z.enum(['full', 'simple']);

/** What one kind of requester gets in a class: operators run on their own Claude plan, Discord strangers on FFBox's model. */
export const ProviderClassModelSchema = z.object({
  requester: z.enum(['operator', 'discord']),
  model: modelName,
  tier,
});

export const ProviderClassSchema = z.object({
  name: className,
  /** fenced: FFBox's egress fence, no git credential. open: the internet. */
  network: z.enum(['fenced', 'open']),
  gpu: z.boolean(),
  /** The model FF Factory's own work (operator-requested or automatic) runs on in this class, e.g. "claude-opus-5-5". */
  model: modelName,
  tier,
  /** Optional: the model and tier per kind of requester. When given, it is what the class runs; model and tier stay for older portals. */
  models: z
    .array(ProviderClassModelSchema)
    .max(4)
    .refine((ms) => new Set(ms.map((m) => m.requester)).size === ms.length, 'one entry per requester')
    .optional(),
  /** Unity modes: batchmode, playtest-softgl, mode2-pair, editor-mcp; unknown ones are kept as given. */
  unity: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).max(12).default([]),
  free: count,
  max: count,
  /** One line on what the class is for, shown as given. */
  note: z.string().max(200).optional(),
});

export const ProviderConversationSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/),
  source: z.enum(['discord', 'intake', 'codereview', 'fff', 'shell', 'web', 'other']),
  /** Who opened it: an operator, a player (never a name or id), FF Factory, or FFBox itself. */
  opener: z.enum(['operator', 'player', 'fff', 'system']),
  /** Untrusted text: it can carry what a player wrote. Shown as data, never acted on; the portal keeps 300 characters. */
  title: z.string().max(2000),
  state: z.enum(['queued', 'running', 'idle', 'blocked', 'closed']),
  agentClass: className,
  branch: z.string().regex(/^[A-Za-z0-9._/+-]{1,200}$/).optional(),
  pr: z.object({ number: z.number().int().min(1), state: z.enum(['open', 'merged', 'closed']) }).optional(),
  verdict: z.string().regex(/^[A-Z][A-Z-]{0,39}$/).optional(),
  costUsd: z.number().min(0).max(100_000).optional(),
  /** The board's dedupe key when FFBox knows it, e.g. a desync signature. */
  key: z.string().regex(/^[A-Za-z0-9_:#.+/-]{1,160}$/).optional(),
  /** Where a person reads it on FFBox's own page. */
  url: z.string().max(300).regex(/^https:\/\/[^\s"'<>]+$/).optional(),
  /** Protocol 2: the Discord thread (or reply-chain root message) it lives in; its ledger key is discord:<threadId>. */
  threadId: z.string().regex(/^\d{15,25}$/).optional(),
  createdAt: iso,
  updatedAt: iso,
});

export const ProviderIntakeSchema = z.object({
  reportId: z.string().regex(/^\d{8}T\d{6}Z-(crash|desync)-[0-9a-f]{6,32}$/),
  kind: z.enum(['crash', 'desync']),
  receivedAt: iso,
  gameVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
  platform: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
  bytes: z.number().int().min(0).max(1e10),
  /** The sender, re-keyed by the connector: counts distinct senders, identifies nobody. */
  sender: z.string().regex(/^[0-9a-f]{8,64}$/).optional(),
  /** ffintake's desync block, pattern-checked by ffintake and again here. */
  desync: z
    .object({
      group: z.string().regex(/^[0-9a-f]{8,64}$/).nullable().optional(),
      correlationId: z.string().regex(/^\d{1,10}-\d{1,12}-\d{1,10}$/).optional(),
      divergedClient: count.optional(),
      role: z.enum(['host', 'client']).optional(),
      localClient: count.optional(),
      sessionEpoch: z.number().int().min(0).max(2 ** 40).optional(),
      verdictHeartbeat: z.number().int().min(0).max(2 ** 40).optional(),
      divergedSurfaces: z.string().regex(/^[A-Za-z0-9]{1,40}(\+[A-Za-z0-9]{1,40}){0,39}$/).optional(),
      happenedAt: iso.optional(),
      why: z.string().regex(/^[a-z_]{1,40}$/).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------- connector → portal

// Readers strip unknown fields (zod's default) and never use .strict(): a newer connector may add any field.

/** protocol, accepts and queries are information only (shown, never gating anything) and may be absent. */
export const HelloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.number().int().optional(),
  provider: z.literal('ffbox'),
  connector: z.object({ version: z.string().regex(/^[A-Za-z0-9._+-]{1,40}$/), commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional() }),
  /** FFBox's own page, for links (LAN-only is fine: people open it, the portal never does). */
  web: z.string().max(300).regex(/^https:\/\/[^\s"'<>]+$/).optional(),
  /**
   * What the connector says it takes, e.g. "board", "board_maybe", "query", and the phase 3 work messages
   * (WORK_MESSAGES). Kept for display; words that are not `^[a-z_]{1,32}$` are dropped, not refused.
   */
  accepts: z.array(z.string()).max(64).optional(),
  /** The read-only queries it says it answers. For display only: the portal asks any query whatever this says. */
  queries: z.array(z.string()).max(64).optional(),
});

/** An accepts or queries list as kept: the well-formed words only, at most 20. */
export const offerWords = (words: readonly string[] | undefined) => (words ?? []).filter((w) => /^[a-z_]{1,32}$/.test(w)).slice(0, 20);

export const CapacitySchema = z.object({
  type: z.literal('capacity'),
  classes: z.array(ProviderClassSchema).max(10),
  /** Turns waiting for a container. */
  queue: count,
  state: z.enum(['running', 'draining', 'updating', 'stopped']),
  /** Why work waits, one line each (a subscription hold, quiet hours). */
  holds: z.array(z.string().max(160)).max(10).default([]),
  /** ffwatch, which writes the feed the connector reads: up false means down or restarting since `at` (when it last wrote). */
  ffwatch: z.object({ up: z.boolean(), at: iso.optional() }).optional(),
});

export const ConversationMessageSchema = z.object({ type: z.literal('conversation'), cursor, conversation: ProviderConversationSchema });
export const IntakeMessageSchema = z.object({ type: z.literal('intake'), cursor, event: ProviderIntakeSchema });


export type ProviderHello = z.infer<typeof HelloSchema>;
export type ProviderCapacityMessage = z.infer<typeof CapacitySchema>;

// ---------------------------------------------------------------- portal → connector

export type ToConnector =
  /** The answer to a valid hello: where each stream left off, so the connector resends only what is newer. */
  /** protocol: the hello's when it is 1 or 2, else 2. accepts: PORTAL_ACCEPTS, whatever the settings. */
  | { type: 'welcome'; protocol: number; provider: 'ffbox'; cursors: { conversation?: string; intake?: string }; limits: typeof LIMITS; accepts: readonly string[] }
  /**
   * A message the portal did not take; the connection stays up. unsupported: a message type this portal does not know
   * (ref: the type). bad_message: a known type with a value out of range or format (counted toward LIMITS.invalidPerMinute).
   */
  | { type: 'error'; code: 'bad_message' | 'unsupported' | 'hello_twice' | 'not_enabled'; message: string; ref?: string }
  /** The answer to board_check (docs/intake.md): what the ledger holds that matches, open or finished. */
  | { type: 'board'; ref: string; verdict: 'clear' | 'in_flight' | 'done' | 'maybe'; matches: BoardMatchWire[]; confidence?: number; update?: true }
  /** Receipt of a request FFBox filed: the ledger item it became (or the one it repeats). */
  | { type: 'filed'; ref: string; workId?: string; status: string; repeat?: boolean; why?: string }
  /** A read-only question (docs/ffbox-connector-contract.md, "Read-only queries"), whatever the hello listed. */
  | QueryMessage
  /** The answers to an operator's dev request and its follow-ups, and later replies to its thread ("Dev requests"). */
  | DevAck
  | DevFiled
  | DevReply
  | DevUpdate
  /** The work messages (docs/ffbox-connector-contract.md), sent only to a connector that lists them in hello.accepts. */
  | ToConnectorWork;

// ---------------------------------------------------------------- read-only queries (docs/ffbox-connector-contract.md)
//
// The portal asks, the connector answers from what ffwatch already wrote, cut down on FFBox's side (an allowlist for
// the config, ids for the ledger log, fixed words and numbers for the status). Nothing a query carries can make FFBox
// write, start or change anything. Adding one: docs/ffbox.md, "Asking FFBox".

/**
 * The queries the ffbox_activity tool offers. Not a gate: any name matching QUERY_NAME may be sent, and FFBox answers
 * error unsupported for one it does not know.
 */
export const PROVIDER_QUERIES = ['config', 'board_log', 'status', 'conversation'] as const;
export const QUERY_NAME = /^[a-z_]{1,32}$/;
export type ProviderQuery = (typeof PROVIDER_QUERIES)[number];

export const QUERY_LIMITS = {
  /** How long the portal waits for a query_result before it falls back to the last answer it kept. */
  timeoutMs: 10_000,
  /** Queries the portal sends per minute; the connector answers 30 a minute and refuses the rest. */
  perMinute: 30,
  /** Queries waiting for an answer at once. */
  inFlight: 8,
  /** conversation is answered on FFBox's next pass (about 5 s), and the connector gives up at 12 s. */
  timeoutMsByQuery: { conversation: 15_000 } as Record<string, number>,
  /** Conversations whose last answer is kept for the fallback. */
  keptConversations: 20,
} as const;

export interface QueryMessage {
  type: 'query';
  id: string;
  what: string;
  args?: Record<string, number>;
}

/** connector → portal: the answer to one query. `data` is FFBox's, already cut down there; shown as data, never acted on. */
export const QueryResultSchema = z.object({
  type: z.literal('query_result'),
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/),
  what: z.string().regex(/^[a-z_]{1,32}$/).optional(),
  ok: z.boolean(),
  /** When ffwatch wrote the answer. */
  at: iso.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  /**
   * unsupported, bad_args, not_ready, withheld, too_large, rate_limited, unavailable (ffwatch down), disabled (queries
   * off on FFBox); newer codes are kept as given.
   */
  error: z.string().regex(/^[a-z_]{1,32}$/).optional(),
  /** FFBox's words on a failure: why (reason), what to do (hint), what was wrong with the args (detail). Untrusted text. */
  reason: z.string().optional(),
  hint: z.string().optional(),
  detail: z.string().optional(),
});
export type QueryResult = z.infer<typeof QueryResultSchema>;

// ---------------------------------------------------------------- work messages (phase 3, docs/ffbox-connector-contract.md)
//
// Defined and tested now so both sides can build to them; the portal sends none until phase 3. Each carries the
// person it is for, `requestedBy`, and never a credential: FFBox maps `requestedBy.userId` to the Claude account
// it holds for that person, and refuses the work (`refused`, reason `unknown_requester` or `no_account`) when it
// has none. The portal builds them strictly (buildSubmit, buildDiagnose, buildStop): no field it does not know,
// so nothing can ride along.

/** The work messages a connector can take, as it lists them in hello.accepts. */
export const WORK_MESSAGES = ['submit', 'diagnose', 'stop'] as const;
export type WorkMessage = (typeof WORK_MESSAGES)[number];

/** The person a piece of work is for: an FF Factory login. An id and a name, nothing else (no email, no token). */
export const RequesterSchema = z
  .object({
    /** The FF Factory login name: stable, and what FFBox's operators block maps (`fff:<userId>`). */
    userId: z.string().regex(/^[a-zA-Z0-9._-]{2,32}$/),
    /** For people reading FFBox's pages and logs. Never used to pick an account. */
    displayName: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[^\u0000-\u001f<>`{}$\\[\]]+$/, 'one plain line'),
  })
  .strict();

/**
 * person: someone asked for it (a message, a button, the orchestrator acting on their message). automatic: the
 * portal started it by itself (intake triage, phase 4), and `requestedBy` is the configured system payer.
 */
export const TriggerSchema = z.enum(['person', 'automatic']);

/** FF Factory's id for one work request; accepted, refused and (later) result refer to it. */
const requestId = z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/);
const conversationId = z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/);
const gitRef = z.string().regex(/^[A-Za-z0-9._/+-]{1,200}$/);
const boardKey = z.string().regex(/^[A-Za-z0-9_:#.+/-]{1,160}$/);
const reportId = z.string().regex(/^\d{8}T\d{6}Z-(crash|desync)-[0-9a-f]{6,32}$/);

/** portal → connector: start a turn on FFBox (a new conversation, or the next turn of one it started). */
export const SubmitSchema = z
  .object({
    type: z.literal('submit'),
    id: requestId,
    requestedBy: RequesterSchema,
    trigger: TriggerSchema,
    title: z.string().min(1).max(300),
    /** The brief. Secrets are redacted before it is built (redactSecrets). */
    prompt: z.string().min(1).max(48_000),
    /** fenced by default. FFBox may still pick a stricter class; nothing here can force the open one. */
    class: z.enum(['fenced', 'open']).default('fenced'),
    /** Branch to base new work on (default develop), or to continue. */
    base: gitRef.optional(),
    branch: gitRef.optional(),
    /** A conversation this portal started earlier: this is its next turn. */
    conversation: conversationId.optional(),
    /** The task reads text from outside the team (players, the web). Forces the fenced class. */
    untrustedInput: z.boolean(),
    /** The board's dedupe key, when there is one. */
    key: boardKey.optional(),
  })
  .strict()
  .refine((m) => !(m.untrustedInput && m.class === 'open'), { message: 'untrustedInput work runs fenced', path: ['class'] });

/** portal → connector: diagnose filed intake reports, as the /intake button does. */
export const DiagnoseSchema = z
  .object({
    type: z.literal('diagnose'),
    id: requestId,
    requestedBy: RequesterSchema,
    trigger: TriggerSchema,
    reportIds: z.array(reportId).min(1).max(20),
    key: boardKey.optional(),
  })
  .strict();

/** portal → connector: stop a conversation this portal started. */
export const StopSchema = z
  .object({ type: z.literal('stop'), id: requestId, requestedBy: RequesterSchema, conversation: conversationId })
  .strict();

export const ToConnectorWorkSchema = z.discriminatedUnion('type', [SubmitSchema, DiagnoseSchema, StopSchema]);
export type SubmitMessage = z.infer<typeof SubmitSchema>;
export type DiagnoseMessage = z.infer<typeof DiagnoseSchema>;
export type StopMessage = z.infer<typeof StopSchema>;
export type ToConnectorWork = z.infer<typeof ToConnectorWorkSchema>;

/**
 * connector → portal: FFBox took a work request. `billedTo`: the user id whose account FFBox charges, which must
 * be `requestedBy.userId`; the portal flags any other.
 */
export const AcceptedSchema = z.object({
  type: z.literal('accepted'),
  ref: requestId,
  conversation: conversationId,
  billedTo: z.string().regex(/^[a-zA-Z0-9._-]{2,32}$/),
});

/**
 * connector → portal: FFBox would not take a work request. unknown_requester: no operator entry for
 * `requestedBy.userId`; no_account: an operator with no Claude account to bill. Neither falls back to another
 * person's account.
 */
export const RefusedSchema = z.object({
  type: z.literal('refused'),
  ref: requestId,
  reason: z.enum(['unknown_requester', 'no_account', 'class_not_allowed', 'budget_hold', 'draining', 'already_diagnosed', 'bad_request', 'other']),
  /** One line for people; FFBox's own words, shown as data. */
  message: z.string().max(300).optional(),
});

export const WorkReplySchema = z.discriminatedUnion('type', [AcceptedSchema, RefusedSchema]);
export type WorkReply = z.infer<typeof WorkReplySchema>;

type Input<T> = Omit<z.input<T & z.ZodTypeAny>, 'type'>;

/** A submit message, with its title and prompt redacted and every field checked; throws on anything wrong. */
export function buildSubmit(m: Input<typeof SubmitSchema>): SubmitMessage {
  return SubmitSchema.parse({ ...m, type: 'submit', title: redactSecrets(String(m.title ?? '')), prompt: redactSecrets(String(m.prompt ?? '')) });
}

export function buildDiagnose(m: Input<typeof DiagnoseSchema>): DiagnoseMessage {
  return DiagnoseSchema.parse({ ...m, type: 'diagnose' });
}

export function buildStop(m: Input<typeof StopSchema>): StopMessage {
  return StopSchema.parse({ ...m, type: 'stop' });
}

/** Whether a connector's hello said it takes this work message (a phase 1 connector takes none). */
export const acceptsWork = (accepts: readonly string[] | undefined, type: WorkMessage) => !!accepts?.includes(type);

/** What was wrong with a message, in one line (never echoing its content). */
export function describeIssues(e: z.ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(message)'}: ${i.message}`)
    .join('; ');
}

// ---------------------------------------------------------------- the intake, both ways (docs/intake.md)

/**
 * connector → portal: FFBox files a request into FF Factory's ledger: a fix branch to review and merge, an escalation
 * (a fork that needs the three-machine rig, a GPU), or an operator's request. It lands waiting for a person unless the
 * portal's intake.ffbox auto-approve rule allows it. Title and brief are untrusted text (they can carry what a player
 * wrote); the portal fences them off.
 */
export const RequestSchema = z.object({
  type: z.literal('request'),
  /** FFBox's id for it; the portal answers with "filed". */
  ref: requestId,
  kind: z.enum(['review-branch', 'escalate', 'dev']),
  title: z.string().min(1).max(300),
  brief: z.string().min(1).max(8000),
  /** Who opened the conversation behind it: an operator, a player, or FFBox itself. */
  opener: z.enum(['operator', 'player', 'system']),
  /** The operator it is for, when an operator asked (an FF Factory login; the portal checks it exists). Read without .strict(). */
  requestedBy: z.object(RequesterSchema.shape).optional(),
  conversation: conversationId.optional(),
  branch: gitRef.optional(),
  pr: z.number().int().min(1).optional(),
  verdict: z.string().regex(/^[A-Z][A-Z-]{0,39}$/).optional(),
  key: boardKey.optional(),
  url: z.string().max(300).regex(/^https:\/\/[^\s"'<>]+$/).optional(),
});

/**
 * connector → portal: before FFBox works a report or starts an operator's dev turn, it asks the ledger whether the
 * same work is open or done (docs/intake.md). The portal answers "board", or error not_enabled while
 * intake.ffbox.boardCheck is off.
 */
export const BoardCheckSchema = z.object({
  type: z.literal('board_check'),
  ref: requestId,
  keys: z.array(boardKey).max(20).default([]),
  /** Untrusted: compared by its words, never shown to a model. FFBox sends keys only. */
  title: z.string().max(300).optional(),
  /** Protocol 2: the FFBox conversation asking; the ledger requests filed from it are its own, not a match. */
  conversation: conversationId.optional(),
  /**
   * The start of the report, sanitized on FFBox (secrets and paths out), sent only when the welcome lists
   * "board_summary". Untrusted: split into words and compared (server/boardMatch.ts), never shown to a model.
   */
  summary: z.string().max(1000).optional(),
});

/**
 * One match in a board answer. watch (in flight, when the branch is known): the branch FFBox watches for the merge, the
 * PR once open, the repo and the branch it lands on. version / mergedIn / branch (done): the first release carrying the
 * fix (null while merged but unreleased), "<target>@<sha>", and the branch the work was on.
 */
export interface BoardMatchWire {
  id: string;
  status: string;
  title: string;
  score: number;
  why: string;
  updatedAt: string;
  watch?: { repo: string; branch: string; pr?: number; target: string };
  version?: string | null;
  mergedIn?: string | null;
  branch?: string;
}

/** connector → portal: a turn FF Factory submitted finished (or failed). The summary is untrusted text. */
export const ResultSchema = z.object({
  type: z.literal('result'),
  ref: requestId,
  conversation: conversationId,
  state: z.enum(['done', 'failed']),
  branch: gitRef.optional(),
  pr: z.number().int().min(1).optional(),
  verdict: z.string().regex(/^[A-Z][A-Z-]{0,39}$/).optional(),
  noBranchReason: z.string().max(300).optional(),
  summary: z.string().max(2000).optional(),
  costUsd: z.number().min(0).max(100_000).optional(),
  url: z.string().max(300).regex(/^https:\/\/[^\s"'<>]+$/).optional(),
});

export type ProviderRequestMessage = z.infer<typeof RequestSchema>;
export type BoardCheckMessage = z.infer<typeof BoardCheckSchema>;
export type ResultMessage = z.infer<typeof ResultSchema>;

// ---------------------------------------------------------------- dev requests (docs/ffbox-connector-contract.md, "Dev requests")
//
// An operator's ffdev turn, handed to FF Factory instead of a container on FFBox: the request and its files, filed at
// once as the request of the person the operator maps to, deduplicated against the ledger (server/devRequests.ts). The
// operator's later messages in that thread reach their orchestrator, whose replies go back as dev_reply.

export const DEV_LIMITS = {
  /** Files in one request, each file's size, and all of them together. A file is also capped by config attachments.maxMB. */
  maxFiles: 10,
  maxFileBytes: 200 * 1024 * 1024,
  maxRequestBytes: 500 * 1024 * 1024,
  /** Raw bytes in one dev_chunk: 60000 base64 characters in the frame, inside LIMITS.maxMessageBytes. */
  maxChunkBytes: 45_000,
  title: 120,
  brief: 8000,
  transcript: 24_000,
  /** A dev_message's text, and a dev_reply's. */
  message: 4000,
  reply: 4000,
  /** dev_filed.text: the line FFBox posts. */
  filedText: 1000,
} as const;

const devRef = z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/);
const devId = z.string().regex(/^[A-Za-z0-9._:@-]{1,64}$/);
const workIdPattern = z.string().regex(/^w\d{1,9}$/);

/** The operator as FFBox's config names it, and the ids it is known by there. Asserted by FFBox, whose token authenticates the link. */
export const DevOperatorSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
  discord: z.string().regex(/^\d{15,25}$/).optional(),
  github: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).optional(),
  shell: devId.optional(),
  web: devId.optional(),
});

/** The FFBox conversation a dev request comes from. Its title is the operator's text, redacted on FFBox: kept as data. */
export const DevConversationSchema = z.object({
  id: conversationId,
  source: z.enum(['discord', 'codereview', 'shell', 'web']),
  /** The watch alias of its channel (bug_reports, dev_chat, ...): what a batch request's scope names. */
  channel: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  title: z.string().max(300),
  url: z.string().max(300).regex(/^https:\/\/[^\s"'<>]+$/).optional(),
  threadId: z.string().regex(/^\d{15,25}$/).optional(),
  branch: gitRef.optional(),
  pr: z.number().int().min(1).optional(),
  createdAt: iso,
});

export const DevAttachmentSchema = z.object({
  n: z.number().int().min(0).max(63),
  name: z.string().min(1).max(200),
  size: z.number().int().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.string().max(80).optional(),
});

/** connector → portal: an operator's ffdev turn, handed over. Answered dev_ack at once and dev_filed after the last byte. */
export const DevRequestSchema = z.object({
  type: z.literal('dev_request'),
  ref: devRef,
  operator: DevOperatorSchema,
  conversation: DevConversationSchema,
  title: z.string().min(1).max(DEV_LIMITS.title),
  brief: z.string().min(1).max(DEV_LIMITS.brief),
  transcript: z.string().max(DEV_LIMITS.transcript).optional(),
  /** Ledger keys: discord:<thread>, branch:<name>, pr:<n>, report:<id>. Any other is dropped, never refused. */
  keys: z.array(z.string().max(200)).max(20).default([]),
  /** The count and size limits are the portal's to check (dev_ack too_large), so a request past them is refused, not bad_message. */
  attachments: z.array(DevAttachmentSchema).max(64).default([]),
  /** The operator asked to file it even if it repeats work (`!fff new`). */
  force: z.boolean().optional(),
});

/** connector → portal: file n's bytes from offset, base64, in order, file after file. */
export const DevChunkSchema = z.object({
  type: z.literal('dev_chunk'),
  ref: devRef,
  n: z.number().int().min(0).max(63),
  offset: z.number().int().min(0),
  data: z
    .string()
    .min(1)
    .max(Math.ceil(DEV_LIMITS.maxChunkBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64'),
});

/** connector → portal: the operator's follow-up in a thread linked to `request` (FF Factory's work id). */
export const DevMessageSchema = z.object({
  type: z.literal('dev_message'),
  ref: devRef,
  request: workIdPattern,
  operator: DevOperatorSchema,
  conversation: conversationId,
  text: z.string().min(1).max(DEV_LIMITS.message),
});

/** connector → portal: a dev_reply was written for ffwatch; the portal stops resending it. */
export const DevReceivedSchema = z.object({ type: z.literal('dev_received'), id: devRef });

export type DevRequestMessage = z.infer<typeof DevRequestSchema>;
export type DevChunkMessage = z.infer<typeof DevChunkSchema>;
export type DevMessageMessage = z.infer<typeof DevMessageSchema>;
export type DevReceivedMessage = z.infer<typeof DevReceivedSchema>;

export type DevAckError = 'unknown_operator' | 'rate_limited' | 'too_large' | 'not_enabled' | 'bad_request';
export type DevFiledError = 'sha_mismatch' | 'too_large' | 'bad_request' | 'error';
export type DevOutcome = 'filed' | 'covered' | 'fixed' | 'linked';

/** portal → connector: within 10 s of a dev_request or dev_message. ok false: FFBox runs the turn itself. */
export interface DevAck {
  type: 'dev_ack';
  ref: string;
  ok: boolean;
  error?: DevAckError;
  detail?: string;
}

/** A ledger request a dev_filed names: the one it joined, the fix, or the candidates it may repeat. */
export interface DevMatch {
  id: string;
  status: string;
  score: number;
  why: string;
}

/** portal → connector: after the last byte. `text` is the line FFBox posts: plain, at most DEV_LIMITS.filedText. */
export interface DevFiled {
  type: 'dev_filed';
  ref: string;
  ok: boolean;
  /** Absent when ok is false. */
  outcome?: DevOutcome;
  workId?: string;
  matches?: DevMatch[];
  text: string;
  error?: DevFiledError;
  detail?: string;
}

/** portal → connector: a later reply for the thread. from: "orchestrator" (the person's, reply_to_ffbox) or "fff" (FF Factory itself). */
export interface DevReply {
  type: 'dev_reply';
  id: string;
  request: string;
  conversation: string;
  text: string;
  from: 'orchestrator' | 'fff';
}

/**
 * portal → connector (w272): where a request an FFBox dev-request conversation is linked to stands, as it changes, with
 * the board answer's facts (BoardMatch): `watch` while it is worked and a branch is known, then `mergedIn` and `version`
 * once it is done. FFBox follows the branch and PR like a board_check in_flight match, announces the merge in the thread
 * and files the thread away by its own rules; a declined or cancelled request gets a short result. Nothing here is
 * routing for a person to read. Resent on every reconnect until dev_received; only the newest per conversation waits.
 */
export interface DevUpdate {
  type: 'dev_update';
  id: string;
  /** The request the conversation's link lives on now (a request merged into another continues as that one). */
  request: string;
  conversation: string;
  /** open while it is worked; done, declined (the ledger's rejected) or cancelled once it is finished. */
  status: 'open' | 'done' | 'declined' | 'cancelled';
  watch?: { repo: string; branch: string; pr?: number; target: string };
  /** done: the first release that carries it, null while merged but not released. */
  version?: string | null;
  /** done: `<target>@<sha>`, null when it finished with no merge. */
  mergedIn?: string | null;
  branch?: string;
  /** done with no merge: the request's outcome, one line, for the thread as its result. */
  result?: string;
}

/** Everything the connector may send. */
/** connector → portal: FFBox's load, memory and disks, every 30 s. Disks are named by role, never by path. */
export const MetricsSchema = z.object({
  type: z.literal('metrics'),
  at: iso,
  cpu: z
    .object({ load1: z.number().min(0).max(100_000), load5: z.number().min(0).max(100_000), load15: z.number().min(0).max(100_000), cores: z.number().int().min(1).max(4096) })
    .optional(),
  mem: z
    .object({
      totalBytes: z.number().int().min(1),
      usedBytes: z.number().int().min(0),
      swapTotalBytes: z.number().int().min(0).optional(),
      swapUsedBytes: z.number().int().min(0).optional(),
    })
    .optional(),
  disks: z
    .array(z.object({ role: z.string().regex(/^[a-z][a-z+]{0,63}$/), totalBytes: z.number().int().min(1), freeBytes: z.number().int().min(0) }))
    .max(12)
    .default([]),
});

/**
 * connector → portal: how FFBox's self-updater's last pass went, per checkout, sent when it changes (a pass starting
 * or ending) and on every new link. Every field but at, ok and each checkout's name, status and ok is optional, and
 * the words are not enumerated, so FFBox can say more without a portal release (w265).
 */
export const UpdaterCheckoutSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  status: z.string().regex(/^[a-z_]{1,40}$/),
  ok: z.boolean(),
  path: z.string().max(400).optional(),
  local: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  origin: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  message: z.string().max(1000).optional(),
  since: iso.optional(),
  checked_at: iso.optional(),
  ok_at: iso.optional(),
  updated_at: iso.optional(),
});

export const UpdaterSchema = z.object({
  type: z.literal('updater'),
  updater: z.object({
    at: iso,
    ok: z.boolean(),
    interval_secs: z.number().int().min(10).max(86_400).optional(),
    since: iso.optional(),
    running_since: iso.optional(),
    checkouts: z.array(UpdaterCheckoutSchema).max(12).default([]),
    warnings: z.array(z.string().max(1000)).max(20).default([]),
  }),
});
export type UpdaterMessage = z.infer<typeof UpdaterSchema>;

export const FromConnectorSchema = z.discriminatedUnion('type', [
  HelloSchema,
  CapacitySchema,
  ConversationMessageSchema,
  IntakeMessageSchema,
  AcceptedSchema,
  RefusedSchema,
  ResultSchema,
  RequestSchema,
  BoardCheckSchema,
  QueryResultSchema,
  MetricsSchema,
  UpdaterSchema,
  DevRequestSchema,
  DevChunkSchema,
  DevMessageSchema,
  DevReceivedSchema,
]);
export type FromConnector = z.infer<typeof FromConnectorSchema>;
/** Each connector→portal type's schema, by type: a type not here is answered error unsupported. */
export const FROM_CONNECTOR: ReadonlyMap<string, z.ZodType<FromConnector>> = new Map(FromConnectorSchema.options.map((o) => [o.shape.type.value, o as z.ZodType<FromConnector>]));
export const FROM_CONNECTOR_TYPES = [...FROM_CONNECTOR.keys()];

/**
 * Why a failed parse is fatal (docs/ffbox-connector-contract.md, "What closes the link"): a field missing or of the
 * wrong JSON type, as `<path>: <what was expected>`; undefined when it is not. A whole-number check (`expected int`) is
 * a value problem, like a range or a pattern, and not fatal.
 */
export function fatalIssue(e: z.ZodError): string | undefined {
  const i = e.issues.find((x) => x.code === 'invalid_type' && !('format' in x && x.format));
  if (!i) return undefined;
  return `${i.path.map(String).join('.') || '(message)'}: ${i.message.replace(/^Invalid input: /, '')}`;
}
