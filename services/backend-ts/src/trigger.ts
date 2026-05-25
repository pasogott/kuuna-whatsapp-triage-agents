const triggerPrefixes = ["kuuna:", "/kuuna", "!kuuna"] as const;
const defaultAliases = ["agent", "kuuna"] as const;

export type TriggerDecision = {
  shouldExecute: boolean;
  reason: string;
  triggerType: "mention" | "reply" | "prefix" | null;
};

export type TriggerEvent = {
  message: {
    text?: string | null;
    reply_to_provider_message_id?: string | null;
    reply_to_provider_user_id?: string | null;
    mentions: string[];
  };
};

export type TriggerOptions = {
  agentMentionIds?: string[];
  replyToAgent?: boolean;
};

export function evaluateTrigger(event: TriggerEvent, options: TriggerOptions = {}): TriggerDecision {
  if (hasAgentMention(event, options)) {
    return { shouldExecute: true, reason: "agent_mention_present", triggerType: "mention" };
  }
  if (hasAgentReply(event, options)) {
    return {
      shouldExecute: true,
      reason: "reply_to_agent_message_present",
      triggerType: "reply",
    };
  }
  const text = (event.message.text ?? "").trimStart();
  if (triggerPrefixes.some((prefix) => text.startsWith(prefix))) {
    return { shouldExecute: true, reason: "prefix_match", triggerType: "prefix" };
  }
  return { shouldExecute: false, reason: "no_trigger_match", triggerType: null };
}

function configuredCsvValues(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((value) => normalizeMention(value))
      .filter(Boolean),
  );
}

function normalizeMention(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function hasAgentMention(event: TriggerEvent, options: TriggerOptions): boolean {
  const configuredIds = identityCandidates([
    ...configuredCsvValues("AGENT_MENTION_IDS"),
    ...(options.agentMentionIds ?? []),
  ]);
  const aliases = new Set([...defaultAliases, ...configuredCsvValues("AGENT_MENTION_ALIASES")]);

  for (const mention of event.message.mentions) {
    const normalized = normalizeMention(mention);
    if (
      configuredIds.size > 0 &&
      Array.from(identityCandidates([mention])).some((candidate) => configuredIds.has(candidate))
    ) {
      return true;
    }
    if (aliases.has(normalized)) return true;
  }

  const text = event.message.text ?? "";
  for (const alias of aliases) {
    if (new RegExp(`(^|\\s)@${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\b|[^\\w])`, "i").test(text)) {
      return true;
    }
  }
  return false;
}

function hasAgentReply(event: TriggerEvent, options: TriggerOptions): boolean {
  if (!event.message.reply_to_provider_message_id) return false;
  if (options.replyToAgent) return true;

  const replyToProviderUserId = event.message.reply_to_provider_user_id;
  if (!replyToProviderUserId) return false;

  const configuredIds = identityCandidates([
    ...configuredCsvValues("AGENT_MENTION_IDS"),
    ...(options.agentMentionIds ?? []),
  ]);
  if (configuredIds.size === 0) return false;

  return Array.from(identityCandidates([replyToProviderUserId])).some((candidate) => configuredIds.has(candidate));
}

function identityCandidates(values: Iterable<string>): Set<string> {
  const candidates = new Set<string>();
  for (const value of values) {
    const normalized = normalizeMention(value);
    if (!normalized) continue;
    candidates.add(normalized);

    const phone = phoneFromJid(normalized) ?? (/^\d{5,20}$/.test(normalized) ? normalized : null);
    if (phone) {
      candidates.add(phone);
      candidates.add(`${phone}@s.whatsapp.net`);
    }
  }
  return candidates;
}

function phoneFromJid(jid: string): string | null {
  const [user, server] = jid.split("@", 2);
  if (!user || server === "lid") return null;
  const phone = user.split(":", 1)[0]?.replace(/\D/g, "") ?? "";
  return phone.length >= 5 ? phone : null;
}
