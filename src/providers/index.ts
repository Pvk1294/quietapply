import type { ProviderId } from "../core/config.js";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { fake } from "./fake.js";
import type { Provider } from "./types.js";

export const PROVIDERS: Record<ProviderId, Provider> = { "claude-code": claudeCode, codex, fake };

export function getProvider(id: ProviderId): Provider {
  return PROVIDERS[id];
}
