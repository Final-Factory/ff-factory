// Where a person reads an FFBox conversation (w426). FFBox's own page (a conversation's `url`, the hello's `web`) is
// on Lothsahn's home network only, e.g. https://192.168.51.10:8787/conversation/684, so FF Factory links its own page,
// which renders the conversation from the connector's `conversation` answer, and keeps FFBox's link as the second one.

/** FF Factory's page for one FFBox conversation; `base` (the portal's public URL) makes it a whole link. */
export const ffboxConversationHref = (id: string, base?: string) => `${base ? base.replace(/\/+$/, '') + '/' : ''}#/provider/ffbox/conversation/${encodeURIComponent(id)}`;

/** What a link to FFBox's own page is called wherever it shows: it opens only on Lothsahn's network. */
export const FFBOX_LAN_LABEL = "on Loth's network";

/** Whether a ledger request's FFBox conversation is a real one (FFBox's id), not a stand-in for a request without one. */
export const isFfboxConversationId = (id: string | undefined): id is string => !!id && /^[A-Za-z0-9._:-]{1,80}$/.test(id) && !id.startsWith('request-');
