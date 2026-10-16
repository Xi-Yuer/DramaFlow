import type { ConversationSummary, PlatformMessage } from '@dramaflow/contracts';

/** Select an older, bounded prefix. Summaries are derived; the source messages stay untouched. */
export function selectSummaryMessages(
  messages: PlatformMessage[],
  previous?: ConversationSummary,
): PlatformMessage[] {
  const covered = new Set(previous?.messageIds ?? []);
  const remaining = messages.filter((message) => !covered.has(message.id));
  if (remaining.length < 8) return [];
  const candidates = remaining.slice(0, Math.min(20, remaining.length - 4));
  // Do not detach an assistant response from the user message retained in the recent suffix.
  while (candidates.at(-1)?.role === 'user') candidates.pop();
  return candidates.length >= 2 ? candidates : [];
}
