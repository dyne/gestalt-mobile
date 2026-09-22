/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Adapters between kimi web's pending approvals/questions and the codex-shaped
 * server requests the relay's interaction pipeline already speaks. Synthesized
 * requests reuse `item/commandExecution/requestApproval`,
 * `item/fileChange/requestApproval`, and `item/tool/requestUserInput` so
 * `toPendingInteraction` and the client interaction UI work unchanged.
 */

export type KimiApprovalItem = Readonly<{
  approval_id: string;
  tool_name?: string;
  action?: string;
  tool_input_display?: unknown;
  created_at?: unknown;
  expires_at?: unknown;
}>;

export type KimiQuestionOption = Readonly<{
  id: string;
  label: string;
  description?: string;
}>;

export type KimiQuestionEntry = Readonly<{
  id: string;
  question: string;
  header?: string;
  body?: string;
  options?: readonly KimiQuestionOption[];
}>;

export type KimiQuestionItem = Readonly<{
  question_id: string;
  questions?: readonly KimiQuestionEntry[];
}>;

export type SynthesizedServerRequest = Readonly<{
  id: number;
  method: string;
  params: Record<string, unknown>;
}>;

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
}

function bounded(value: unknown, max = 1_000): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, max);
}

function displayText(display: unknown): string {
  if (!display || typeof display !== 'object') return '';
  const record = display as Record<string, unknown>;
  for (const key of ['command', 'path', 'detail', 'description', 'text']) {
    if (typeof record[key] === 'string') return bounded(record[key], 500);
  }
  try {
    return bounded(JSON.stringify(display), 500);
  } catch {
    return '';
  }
}

/** Command-shaped approvals steer to commandExecution; file mutations to fileChange. */
export function approvalToServerRequest(
  id: number,
  item: KimiApprovalItem,
): SynthesizedServerRequest | null {
  const approvalId = safeId(item.approval_id);
  if (!approvalId) return null;
  const toolName = (item.tool_name ?? '').toLowerCase();
  const fileLike = /file|write|edit|patch|str_replace|apply|notebook/.test(toolName);
  const detail = displayText(item.tool_input_display);
  return {
    id,
    method: fileLike ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
    params: {
      itemId: approvalId,
      ...(item.tool_name ? { toolName: bounded(item.tool_name, 128) } : {}),
      ...(item.action ? { reason: bounded(item.action, 256) } : {}),
      ...(detail ? { [fileLike ? 'changes' : 'command']: detail } : {}),
    },
  };
}

export function questionToServerRequest(
  id: number,
  item: KimiQuestionItem,
): SynthesizedServerRequest | null {
  const questionId = safeId(item.question_id);
  if (!questionId) return null;
  const questions = (item.questions ?? []).flatMap((question) => {
    if (!safeId(question.id) || typeof question.question !== 'string') return [];
    return [
      {
        id: question.id,
        question: bounded(question.question, 1_000),
        ...(question.header ? { header: bounded(question.header, 200) } : {}),
        ...(question.body ? { body: bounded(question.body, 2_000) } : {}),
        ...(question.options && question.options.length
          ? {
              options: question.options.flatMap((option) =>
                safeId(option.id) && typeof option.label === 'string'
                  ? [
                      {
                        id: option.id,
                        label: bounded(option.label, 200),
                        ...(option.description
                          ? { description: bounded(option.description, 500) }
                          : {}),
                      },
                    ]
                  : [],
              ),
            }
          : {}),
      },
    ];
  });
  return {
    id,
    method: 'item/tool/requestUserInput',
    params: { questions },
  };
}

/** Translates a relay approval decision into a kimi approval decision. */
export function kimiApprovalDecision(value: unknown): 'approved' | 'rejected' | 'cancelled' | null {
  if (value === 'accept' || value === 'acceptForSession') return 'approved';
  if (value === 'decline') return 'rejected';
  if (value === 'cancel') return 'cancelled';
  return null;
}

/**
 * Translates a relay userInput response (`{answers: {<qid>: {answers: string[]}}}`)
 * into kimi's question answers map. An answer matching an option id or label
 * becomes a single choice; anything else becomes free text.
 */
export function kimiQuestionAnswers(
  item: KimiQuestionItem,
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const answers = (value as Record<string, unknown>).answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const result: Record<string, unknown> = {};
  for (const [questionId, rawAnswer] of Object.entries(answers as Record<string, unknown>)) {
    const reply = rawAnswer && typeof rawAnswer === 'object' ? rawAnswer : {};
    const texts = Array.isArray((reply as { answers?: unknown }).answers)
      ? ((reply as { answers: unknown[] }).answers.filter(
          (entry) => typeof entry === 'string',
        ) as string[])
      : [];
    if (!texts.length) {
      result[questionId] = { kind: 'skipped' };
      continue;
    }
    const question = (item.questions ?? []).find((candidate) => candidate.id === questionId);
    const option = question?.options?.find(
      (candidate) => candidate.id === texts[0] || candidate.label === texts[0],
    );
    result[questionId] = option
      ? { kind: 'single', option_id: option.id }
      : { kind: 'other', text: texts.join('\n').slice(0, 4_000) };
  }
  return Object.keys(result).length ? result : null;
}

export function decodeApprovalItems(data: unknown): KimiApprovalItem[] {
  const items = (data as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is KimiApprovalItem => {
    if (!item || typeof item !== 'object') return false;
    return safeId((item as KimiApprovalItem).approval_id) !== undefined;
  });
}

export function decodeQuestionItems(data: unknown): KimiQuestionItem[] {
  const items = (data as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is KimiQuestionItem => {
    if (!item || typeof item !== 'object') return false;
    return safeId((item as KimiQuestionItem).question_id) !== undefined;
  });
}
