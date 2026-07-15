import { screen } from 'electron';
import type { ChatGptCodexAuthSource } from '../auth/auth-source';
import { captureAllDisplays } from '../capture';
import type { CaptureResult } from '../capture';
import { mapModelPoint } from '../coords';
import type { Point } from '../coords';
import { CodexResponsesSession, DEFAULT_CODEX_MODEL } from '../codex/responses-session';
import type {
  CodexFunctionCall,
  CodexResponsesCallbacks,
  CodexToolDef,
  CodexTurnResult,
  CodexUserTurn,
} from '../codex/responses-session';
import { asFiniteNumber, asRecord, errorMessage } from '../util/guards';
import type { ComputerInputController, MouseButton } from './input-controller';

const MAX_ACTIONS = 12;
const SETTLE_MS = 350;
/** Network budget for one Sol Responses request. */
const OPERATOR_TIMEOUT_MS = 45_000;
/** type_text upper bound (mirrored in the error copy below). */
const MAX_TYPE_TEXT_CHARS = 10_000;
/** click_at label echo cap (tool output back to Sol). */
const LABEL_MAX = 200;

const OPERATOR_INSTRUCTIONS = `you are the careful computer operator inside buddy.
the user has explicitly enabled computer use and asked you to carry out the supplied task.
you are gpt-5.6-sol, and you alone decide every click and keystroke; the realtime voice model can
only delegate the user's words and never supplies coordinates, text, or keys to an action tool.

rules:
- inspect the screenshots yourself. take exactly one action per response, then inspect the fresh screenshots.
- use click_at only with pixel coordinates in the named screenshot. aim at the center of the target.
- use type_text only when the intended field is visibly focused. use press_keys for shortcuts/navigation.
- never invent hidden state. if the target is unclear, stop and explain what prevented safe completion.
- do not perform a materially different action from the user's task.
- when the task is complete, answer with one short plain-language sentence and call no tool.`;

export function operatorInstructions(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'darwin') return OPERATOR_INSTRUCTIONS;
  return `${OPERATOR_INSTRUCTIONS}
- this is macOS: use META or COMMAND for native Command-key shortcuts (for example META+L and
  META+TAB). CTRL means the distinct Control key and is not a substitute for Command.`;
}

export const CLICK_AT_TOOL: CodexToolDef = {
  type: 'function',
  name: 'click_at',
  description:
    'Click the center of a visible target. Coordinates are pixels in the named screenshot.',
  parameters: {
    type: 'object',
    properties: {
      screen: { type: 'integer', description: 'Screenshot index: screen0 is 0.' },
      x: { type: 'integer', description: 'Target center X in screenshot pixels.' },
      y: { type: 'integer', description: 'Target center Y in screenshot pixels.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      count: { type: 'integer', enum: [1, 2] },
      label: { type: 'string', description: 'Short visible target label.' },
    },
    required: ['screen', 'x', 'y', 'label'],
  },
};

export const TYPE_TEXT_TOOL: CodexToolDef = {
  type: 'function',
  name: 'type_text',
  description: 'Type literal Unicode text into the currently focused field.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Exact literal text to type.' } },
    required: ['text'],
  },
};

export const PRESS_KEYS_TOOL: CodexToolDef = {
  type: 'function',
  name: 'press_keys',
  description: 'Press a key or chord. Examples: ["ENTER"], ["CTRL","L"], ["ALT","TAB"].',
  parameters: {
    type: 'object',
    properties: {
      keys: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
    },
    required: ['keys'],
  },
};

function pressKeysTool(platform: NodeJS.Platform = process.platform): CodexToolDef {
  if (platform !== 'darwin') return PRESS_KEYS_TOOL;
  return {
    ...PRESS_KEYS_TOOL,
    description:
      'Press a macOS key or chord. Examples: ["ENTER"], ["META","L"], ["META","TAB"]. META and COMMAND are the Command key.',
  };
}

// ---------------------------------------------------------------------------
// Pure tool-argument parsing (unknown -> typed | error). The error strings are
// tool outputs the model reads — they are part of the wire copy; keep exact.
// ---------------------------------------------------------------------------

/** Result of narrowing one tool call's untrusted arguments. */
export type ParsedArgs<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ClickArgs {
  screen: number;
  x: number;
  y: number;
  button: MouseButton;
  count: 1 | 2;
  /** Echoed back to Sol, capped at LABEL_MAX chars; '' when absent. */
  label: string;
}

export function parseClickArgs(value: unknown): ParsedArgs<ClickArgs> {
  const args = asRecord(value);
  if (args === null) return { ok: false, error: 'arguments were not valid json' };
  const screenIndex = asFiniteNumber(args['screen']);
  const x = asFiniteNumber(args['x']);
  const y = asFiniteNumber(args['y']);
  if (screenIndex === null || x === null || y === null)
    return { ok: false, error: 'screen, x, and y must be numbers' };
  return {
    ok: true,
    value: {
      screen: screenIndex,
      x,
      y,
      button: isButton(args['button']) ? args['button'] : 'left',
      count: args['count'] === 2 ? 2 : 1,
      label: typeof args['label'] === 'string' ? args['label'].slice(0, LABEL_MAX) : '',
    },
  };
}

export interface TypeTextArgs {
  text: string;
}

export function parseTypeTextArgs(value: unknown): ParsedArgs<TypeTextArgs> {
  const args = asRecord(value);
  if (args === null) return { ok: false, error: 'arguments were not valid json' };
  const text = args['text'];
  if (typeof text !== 'string' || text.length > MAX_TYPE_TEXT_CHARS)
    return { ok: false, error: 'text must be at most 10000 characters' };
  return { ok: true, value: { text } };
}

export interface PressKeysArgs {
  keys: string[];
}

export function parsePressKeysArgs(value: unknown): ParsedArgs<PressKeysArgs> {
  const args = asRecord(value);
  if (args === null) return { ok: false, error: 'arguments were not valid json' };
  const keys = args['keys'];
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 8)
    return { ok: false, error: 'keys must be an array of one to eight strings' };
  if (!keys.every((key): key is string => typeof key === 'string'))
    return { ok: false, error: 'keys must be an array of one to eight strings' };
  return { ok: true, value: { keys } };
}

/**
 * One executed tool call's output, JSON-serialized back to Sol via
 * `function_call_output` — the success/error shapes are pinned wire payloads.
 */
export type ToolOutcome =
  | { ok: true; clicked: string }
  | { ok: true; typed_characters: number }
  | { ok: true; pressed: string[] }
  | { ok?: never; error: string };

// ---------------------------------------------------------------------------

export interface ComputerUseResult {
  ok: boolean;
  summary: string;
  actions: number;
  quotaExhausted: boolean;
}

export interface ComputerUseOperatorOptions {
  auth: ChatGptCodexAuthSource;
  input: ComputerInputController;
  initialCaptures?: CaptureResult[];
  isAllowed(): boolean;
  capture?: () => Promise<CaptureResult[]>;
  buildSession?: (auth: ChatGptCodexAuthSource) => CodexResponsesSession;
  /** DIP -> physical px conversion (tests inject; default Electron `screen`). */
  dipToScreenPoint?: (point: Point) => Point;
}

export class ComputerUseOperator {
  private readonly capture: () => Promise<CaptureResult[]>;
  private readonly dipToScreenPoint: (point: Point) => Point;
  private readonly session: CodexResponsesSession;
  private captures: CaptureResult[];
  private finalText = '';

  constructor(private readonly options: ComputerUseOperatorOptions) {
    this.capture = options.capture ?? captureAllDisplays;
    this.dipToScreenPoint = options.dipToScreenPoint ?? inputPointFromDip;
    this.captures = options.initialCaptures ?? [];
    this.session =
      options.buildSession?.(options.auth) ??
      new CodexResponsesSession({
        auth: options.auth,
        model: DEFAULT_CODEX_MODEL,
        instructions: operatorInstructions(),
        tools: [CLICK_AT_TOOL, TYPE_TEXT_TOOL, pressKeysTool()],
        reasoningEffort: 'low',
        serviceTier: 'priority',
        timeoutMs: OPERATOR_TIMEOUT_MS,
      });
  }

  async run(task: string): Promise<ComputerUseResult> {
    if (!this.options.isAllowed()) return stopped(0);
    if (this.captures.length === 0) this.captures = await this.capture();
    if (this.captures.length === 0)
      return failure('i could not see the screen, so i did not act.', 0);

    let calls: CodexFunctionCall[] = [];
    const callbacks: CodexResponsesCallbacks = {
      onFunctionCall: (call) => calls.push(call),
      onTextDone: (_id, text) => {
        if (text.trim()) this.finalText = text.trim();
      },
    };
    let result = await this.session.submit(this.turn(task), callbacks);
    let actions = 0;

    for (;;) {
      const failed = resultFailure(result, actions);
      if (failed) return failed;
      if (!this.options.isAllowed()) {
        this.session.cancel();
        return stopped(actions);
      }
      if (calls.length === 0) {
        return { ok: true, summary: this.finalText || 'done.', actions, quotaExhausted: false };
      }
      if (actions >= MAX_ACTIONS)
        return failure(
          'i stopped after twelve actions before the task was clearly complete.',
          actions,
        );

      const [first, ...extra] = calls;
      calls = [];
      if (!first) return failure('the operator returned an empty action.', actions);
      const output = await this.execute(first);
      this.session.sendToolOutput(first.callId, output);
      for (const call of extra) {
        this.session.sendToolOutput(call.callId, {
          error: 'only one action is allowed per screen observation',
        });
      }
      if (output.ok !== true) return failure(output.error || 'the action failed.', actions);
      actions += 1;
      await delay(SETTLE_MS);
      if (!this.options.isAllowed()) {
        this.session.cancel();
        return stopped(actions);
      }
      this.captures = await this.capture();
      if (this.captures.length === 0)
        return failure('i lost sight of the screen after acting, so i stopped.', actions);
      result = await this.session.continueWithTurn(
        this.turn(
          'the previous action completed. inspect this fresh screen state and either take the next single action or finish.',
        ),
        callbacks,
      );
    }
  }

  private turn(text: string): CodexUserTurn {
    return {
      context: captureContext(this.captures),
      text,
      images: this.captures.map((capture) => ({ jpegBase64: capture.jpegBase64 })),
    };
  }

  private async execute(call: CodexFunctionCall): Promise<ToolOutcome> {
    let args: Record<string, unknown> | null;
    try {
      args = asRecord(JSON.parse(call.argsJson || '{}'));
    } catch {
      args = null;
    }
    if (args === null) return { error: 'arguments were not valid json' };

    try {
      if (call.name === 'click_at') {
        const parsed = parseClickArgs(args);
        if (!parsed.ok) return { error: parsed.error };
        const click = parsed.value;
        const capture = this.captures.find((item) => item.meta.screenIndex === click.screen);
        if (!capture) return { error: 'that screenshot does not exist' };
        const mapped = mapModelPoint({ x: click.x, y: click.y }, capture.meta);
        const physical = this.dipToScreenPoint(mapped.global);
        await this.options.input.click(physical.x, physical.y, click.button, click.count);
        return { ok: true, clicked: click.label };
      }
      if (call.name === 'type_text') {
        const parsed = parseTypeTextArgs(args);
        if (!parsed.ok) return { error: parsed.error };
        await this.options.input.typeText(parsed.value.text);
        return { ok: true, typed_characters: parsed.value.text.length };
      }
      if (call.name === 'press_keys') {
        const parsed = parsePressKeysArgs(args);
        if (!parsed.ok) return { error: parsed.error };
        await this.options.input.pressKeys(parsed.value.keys);
        return { ok: true, pressed: parsed.value.keys };
      }
      return { error: `unknown tool: ${call.name}` };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }
}

function captureContext(captures: CaptureResult[]): string {
  return captures
    .map((capture) => {
      const m = capture.meta;
      return `screen${m.screenIndex}: ${m.imageW}x${m.imageH} screenshot pixels${m.isActive ? ' (active)' : ''}; coordinates use this image.`;
    })
    .join('\n');
}

/** CoreGraphics mouse coordinates are macOS global logical points, matching Electron DIPs. */
export function inputPointFromDip(
  point: Point,
  platform: NodeJS.Platform = process.platform,
): Point {
  return platform === 'darwin'
    ? { x: Math.round(point.x), y: Math.round(point.y) }
    : screen.dipToScreenPoint(point);
}
function isButton(value: unknown): value is MouseButton {
  return value === 'left' || value === 'right' || value === 'middle';
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function failure(summary: string, actions: number): ComputerUseResult {
  return { ok: false, summary, actions, quotaExhausted: false };
}
function stopped(actions: number): ComputerUseResult {
  return failure('computer use was turned off or the turn was superseded, so i stopped.', actions);
}
function resultFailure(result: CodexTurnResult, actions: number): ComputerUseResult | null {
  if (result.quotaExhausted)
    return {
      ok: false,
      summary: 'chatgpt fast-mode usage is unavailable right now, so i did not continue.',
      actions,
      quotaExhausted: true,
    };
  if (result.aborted) return stopped(actions);
  if (result.error) return failure(`the sol operator stopped: ${result.error.message}`, actions);
  return null;
}
