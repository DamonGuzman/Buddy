/**
 * Responses-API wire shapes for the Codex `/responses` backend, shared by
 * every consumer that keeps client-side history (the backend requires
 * `store:false` and rejects `previous_response_id`, so each client replays
 * its full `input` list every round).
 *
 * Two levels of typing live here on purpose:
 *
 *  - `ResponseInputItem` — the strict discriminated union of every item shape
 *    THIS app actually puts on the wire. `codex/responses-session.ts` builds
 *    its history exclusively from these.
 *  - `ResponseItem` — the deliberately loose escape hatch (moved here from
 *    `agents/types.ts`, which re-exports it): the agent loop appends items
 *    returned by the backend to history VERBATIM, including shapes we do not
 *    model (reasoning items, web_search calls, ...). Every
 *    `ResponseInputItem` is assignable to `ResponseItem`.
 *
 * All members are type aliases (not interfaces) so they carry the implicit
 * index signature that makes them assignable to `Record<string, unknown>`.
 * Property order in literals of these types is load-bearing for tests that
 * pin the serialized request bodies — keep `type` first.
 */

// --- user-message content parts ---
export type InputTextPart = { type: 'input_text'; text: string };
/** `image_url` is a data URI (`data:image/jpeg;base64,...`), never a link. */
export type InputImagePart = { type: 'input_image'; image_url: string };
export type UserContentPart = InputTextPart | InputImagePart;

// --- assistant-message content parts ---
export type OutputTextPart = { type: 'output_text'; text: string };

// --- history items ---
export type UserMessageItem = { type: 'message'; role: 'user'; content: UserContentPart[] };
export type AssistantMessageItem = {
  type: 'message';
  role: 'assistant';
  content: OutputTextPart[];
};
export type FunctionCallItem = {
  type: 'function_call';
  call_id: string;
  name: string;
  /** Raw JSON string of the arguments, exactly as streamed. */
  arguments: string;
};
export type FunctionCallOutputItem = {
  type: 'function_call_output';
  call_id: string;
  /** JSON-stringified tool result. */
  output: string;
};

/** Every request-`input` item shape this app constructs itself. */
export type ResponseInputItem =
  UserMessageItem | AssistantMessageItem | FunctionCallItem | FunctionCallOutputItem;

/**
 * One item in the request `input` list / streamed output. Kept loose on
 * purpose: items returned by the backend are appended to history VERBATIM.
 * (Re-exported by `agents/types.ts`; narrow to `ResponseInputItem` where the
 * items are client-built.)
 */
export type ResponseItem = Record<string, unknown>;

/** Responses-API `tool_choice`: a mode keyword or a named-function choice. */
export type CodexToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; name: string };
