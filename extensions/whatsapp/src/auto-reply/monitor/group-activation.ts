import { updateSessionStore } from "openclaw/plugin-sdk/config-runtime";
import { resolveWhatsAppLegacyGroupSessionKey } from "../../group-session-key.js";
import { resolveWhatsAppInboundPolicy } from "../../inbound-policy.js";
import { loadSessionStore, resolveStorePath } from "../config.runtime.js";
import { normalizeGroupActivation } from "./group-activation.runtime.js";

type LoadConfigFn = typeof import("../config.runtime.js").loadConfig;

export async function resolveGroupActivationFor(params: {
  cfg: ReturnType<LoadConfigFn>;
  accountId?: string | null;
  agentId: string;
  sessionKey: string;
  conversationId: string;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const legacySessionKey = resolveWhatsAppLegacyGroupSessionKey({
    sessionKey: params.sessionKey,
    accountId: params.accountId,
  });
  const legacyEntry = legacySessionKey ? store[legacySessionKey] : undefined;
  const scopedEntry = store[params.sessionKey];
  const activation = scopedEntry?.groupActivation ?? legacyEntry?.groupActivation;
  if (activation !== undefined && scopedEntry?.groupActivation === undefined) {
    await updateSessionStore(storePath, (nextStore) => {
      const nextScopedEntry = nextStore[params.sessionKey];
      if (nextScopedEntry?.groupActivation !== undefined) {
        return;
      }
      nextStore[params.sessionKey] = {
        ...nextScopedEntry,
        groupActivation: activation,
      };
    });
  }
  const requireMention = resolveWhatsAppInboundPolicy({
    cfg: params.cfg,
    accountId: params.accountId,
  }).resolveConversationRequireMention(params.conversationId);
  const defaultActivation = !requireMention ? "always" : "mention";
  return normalizeGroupActivation(activation) ?? defaultActivation;
}
