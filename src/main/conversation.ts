/**
 * Public facade of the conversation package. The orchestrator itself lives
 * in `src/main/conversation/` — this module keeps the historical import path
 * (`./conversation`) stable for index.ts, the debug server, and the tests.
 */

export { Conversation } from './conversation/conversation';
export type { ConversationDebugInfo, ConversationDeps } from './conversation/conversation';
export type { CodexTextSession } from './conversation/codex-text-turn';
export { CAPTURE_FAILED_CONTEXT, MIN_COMMIT_AUDIO_MS } from './conversation/constants';
export type {
  AgentsPort,
  OverlayPort,
  PanelPort,
  RecorderPort,
  SettingsPort,
} from './conversation/ports';
export type { RestGroundPort, UiaSnapPort } from './conversation/pointer-pipeline';
