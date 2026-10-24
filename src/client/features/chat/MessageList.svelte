<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte';
  import AutopilotAttention from '../autopilot/AutopilotAttention.svelte';
  import type { OrgPlanAttention } from '../autopilot/contracts.js';
  import { boundedAttentionReport } from '../../../shared/contracts/attention-report.js';
  import { parseOrgPlanAttention } from '../../../shared/contracts/org-plan-attention.js';
  import ActivityList from './ActivityList.svelte';
  import WorkDetails from './WorkDetails.svelte';
  import InteractionList from './InteractionList.svelte';
  import PendingChatRequests from './PendingChatRequests.svelte';
  import type { HistoryActivity } from './activity-summary.js';
  import type { ChatMessage } from './message-store.js';
  import { visibleInteraction, withoutDialogueEchoes } from './interaction-timeline.js';
  import { groupMessages } from './message-groups.js';
  import { formatElapsedAfter, formatMessageTime, formatRelativeAge } from './message-time.js';
  import { summarizeChangedFiles, summarizeFileChangeTotals } from './file-change-summary.js';
  import MessageContent from './MessageContent.svelte';
  import type { ProjectedInteraction } from './chat-projection.js';
  import type { SubmittedQuizAnswer } from './quiz-submission.js';

  type Props = {
    messages: ChatMessage[];
    activities: HistoryActivity[];
    activeTurnId?: string | null;
    autopilotAuditTruncated?: boolean;
    interactions?: ProjectedInteraction[];
    attention?: OrgPlanAttention | null;
    attentionPending?: boolean;
    onattentionresolve?(action: 'resume' | 'disableAutopilot', guidance?: string): void;
    onattentiondebug?(requestId: string, trigger: HTMLButtonElement): void;
    debugPending?: boolean;
    footer?: Snippet;
    answers?: Record<string, string>;
    submittedAnswers?: Record<string, readonly SubmittedQuizAnswer[]>;
    clipboard?: Pick<Clipboard, 'writeText'>;
    onanswer?(requestId: string, id: string, value: string): void;
    onquiz?(interaction: ProjectedInteraction): void;
    onpermission?(interaction: ProjectedInteraction): void;
    ondecision?(id: string, decision: 'accept' | 'decline'): void;
    onretry?(interaction: ProjectedInteraction): void;
    onopenorg?(href: string): void;
    onopenfile?(path: string, line?: number): void;
    oncopyresult?(copied: boolean): void;
  };
  let {
    messages,
    activities,
    activeTurnId = null,
    autopilotAuditTruncated = false,
    interactions = [],
    attention = null,
    attentionPending = false,
    onattentionresolve = () => {},
    onattentiondebug,
    debugPending = false,
    footer,
    answers = {},
    submittedAnswers = {},
    clipboard = globalThis.navigator?.clipboard,
    onanswer = () => {},
    onquiz = () => {},
    onpermission = () => {},
    ondecision = () => {},
    onretry = () => {},
    onopenorg,
    onopenfile,
    oncopyresult = () => {},
  }: Props = $props();
  let groups = $derived.by(() => {
    const grouped = groupMessages(messages);
    if (
      !attention ||
      grouped.some(
        (group) => group.kind === 'audit' && group.attention?.requestId === attention.requestId,
      )
    )
      return grouped;
    const payload = parseOrgPlanAttention(attention.attention);
    if (!payload) return grouped;
    const occurredAt = attention.requestedAt ? Date.parse(attention.requestedAt) : undefined;
    const at = occurredAt !== undefined && Number.isFinite(occurredAt) ? occurredAt : undefined;
    const index =
      at === undefined
        ? -1
        : grouped.findIndex((group) => group.occurredAt !== undefined && group.occurredAt > at);
    grouped.splice(index < 0 ? grouped.length : index, 0, {
      id: `attention:${attention.requestId}`,
      kind: 'audit',
      text: 'Needs attention',
      attention: { ...attention, attention: payload },
      occurredAt: at,
      count: 1,
      timestamps: at === undefined ? [] : [at],
    });
    return grouped;
  });
  let attentionReports = $derived(
    groups.flatMap((group) =>
      group.kind === 'audit' && group.attention ? [attentionReport(group.attention)] : [],
    ),
  );
  let pendingInteractions = $derived(
    interactions.filter((item) => visibleInteraction(item) && item.state !== 'resolved'),
  );
  let previousPending = new Set<string>();
  $effect.pre(() => {
    const ids = new Set([
      ...pendingInteractions.map((item) => `chat-request-${item.requestId}`),
      ...(attention ? [`chat-attention-${attention.requestId}`] : []),
    ]);
    for (const id of previousPending) {
      if (!ids.has(id) && document.getElementById(id)?.contains(document.activeElement)) {
        void tick().then(() => document.getElementById(id)?.focus({ preventScroll: true }));
      }
    }
    previousPending = ids;
  });
  let displayGroups = $derived.by(() => {
    const filtered = groupMessages(
      withoutDialogueEchoes(messages, interactions, attentionReports, submittedAnswers),
    );
    const history = filtered
      .filter(
        (group) =>
          !attention ||
          group.kind !== 'audit' ||
          group.attention?.requestId !== attention.requestId,
      )
      .map((group) => {
        if (group.kind !== 'audit' || !group.attention) return group;
        const resolution = interactions.find(
          (item) => item.requestId === group.attention?.requestId,
        )?.resolvedAt;
        return resolution === undefined ? group : { ...group, occurredAt: resolution };
      });
    const entries: Array<
      | (typeof history)[number]
      | { id: string; kind: 'interaction'; interaction: ProjectedInteraction; occurredAt?: number }
    > = history;
    for (const item of interactions.filter(
      (item) => visibleInteraction(item) && item.state === 'resolved',
    )) {
      const entry = {
        id: item.key,
        kind: 'interaction' as const,
        interaction: item,
        occurredAt: item.resolvedAt ?? item.occurredAt,
      };
      const index =
        entry.occurredAt === undefined
          ? -1
          : entries.findIndex(
              (group) => group.occurredAt !== undefined && group.occurredAt > entry.occurredAt!,
            );
      entries.splice(index < 0 ? entries.length : index, 0, entry);
    }
    // Audit entries may have moved from request time to resolution time.
    // Preserve the original order when legacy records have no timestamps.
    return entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) =>
        a.entry.occurredAt !== undefined && b.entry.occurredAt !== undefined
          ? a.entry.occurredAt - b.entry.occurredAt || a.index - b.index
          : a.index - b.index,
      )
      .map(({ entry }) => entry)
      .toReversed();
  });

  function attentionReport(record: OrgPlanAttention): OrgPlanAttention {
    const requestedAt = record.requestedAt ? Date.parse(record.requestedAt) : NaN;
    const reports = messages.filter(
      (message) => message.role === 'assistant' && message.turnId === record.turnId,
    );
    const final = reports.findLast(
      (message) =>
        message.phase === 'final_answer' &&
        message.occurredAt !== undefined &&
        message.occurredAt >= requestedAt,
    );
    const commentary = reports.findLast(
      (message) =>
        message.phase === 'commentary' &&
        message.occurredAt !== undefined &&
        message.occurredAt <= requestedAt,
    );
    const supervisorReport =
      attention?.requestId === record.requestId && attention.supervisorReport
        ? attention.supervisorReport
        : boundedAttentionReport(final?.text ?? commentary?.text);
    return { ...record, ...(supervisorReport ? { supervisorReport } : {}) };
  }
  let expandedCommentary = $state<Record<string, boolean>>({});
  let now = $state(Date.now());
  onMount(() => {
    const timer = globalThis.setInterval(() => (now = Date.now()), 1_000);
    return () => globalThis.clearInterval(timer);
  });
  let promptGroups = $derived(groups.filter((group) => group.kind === 'user'));
  let assistantGroups = $derived(
    displayGroups.filter((group) => group.kind === 'assistant').toReversed(),
  );
  let latestAssistantId = $derived(assistantGroups.at(-1)?.id);
  function activityAnswerOwnerId(activity: HistoryActivity): string | null {
    if (activity.turnId) {
      const exact = assistantGroups.findLast((group) => group.turnId === activity.turnId);
      if (exact) return exact.id;
    }
    if (activity.occurredAt === undefined) return latestAssistantId ?? null;
    return (
      assistantGroups.find(
        (group) =>
          group.answer !== null &&
          group.occurredAt !== undefined &&
          group.occurredAt >= activity.occurredAt!,
      )?.id ?? null
    );
  }
  function turnActivities(group: (typeof groups)[number]): HistoryActivity[] {
    if (group.kind !== 'assistant') return [];
    return activities.filter((activity) => activityAnswerOwnerId(activity) === group.id);
  }
  function activityPromptOwnerId(activity: HistoryActivity): string | null {
    if (activityAnswerOwnerId(activity)) return null;
    if (activity.turnId) {
      const exact = promptGroups.findLast((group) => group.turnId === activity.turnId);
      if (exact) return exact.id;
    }
    if (activity.occurredAt === undefined) return null;
    return (
      promptGroups.findLast(
        (group) => group.occurredAt !== undefined && group.occurredAt <= activity.occurredAt!,
      )?.id ?? null
    );
  }
  function promptActivities(group: (typeof groups)[number]): HistoryActivity[] {
    if (group.kind !== 'user') return [];
    return activities.filter((activity) => activityPromptOwnerId(activity) === group.id);
  }
  function detachedActivities(): HistoryActivity[] {
    return activities.filter(
      (activity) => !activityAnswerOwnerId(activity) && !activityPromptOwnerId(activity),
    );
  }
  let detached = $derived(detachedActivities());
  function regularActivities(items: HistoryActivity[]): HistoryActivity[] {
    return items.filter(
      (activity) => !activity.label.toLowerCase().replaceAll(' ', '').startsWith('filechange'),
    );
  }
  function isLive(group: (typeof groups)[number]): boolean {
    return Boolean(
      group.kind === 'assistant' &&
      activeTurnId &&
      (group.turnId === activeTurnId || (!group.turnId && group.id === latestAssistantId)),
    );
  }
  function isPromptLive(group: (typeof groups)[number]): boolean {
    return Boolean(
      group.kind === 'user' && activeTurnId && (group.turnId === activeTurnId || !group.turnId),
    );
  }
  function timeLabel(index: number, occurredAt: number | undefined): string | null {
    return formatElapsedAfter(displayGroups[index + 1]?.occurredAt, occurredAt);
  }
</script>

{#snippet changedFiles(items: HistoryActivity[])}
  {@const changes = summarizeChangedFiles(items)}
  {@const totals = summarizeFileChangeTotals(changes)}
  {#if changes.length}
    <details class="file-changes">
      <summary>
        {totals.files}
        {totals.files === 1 ? 'file' : 'files'} changed ·
        <span class="additions">+{totals.additions ?? '?'}</span>
        <span class="deletions">−{totals.deletions ?? '?'}</span>
      </summary>
      <section aria-label="Files changed">
        <ul>
          {#each changes as change (change.path)}
            <li>
              <code class="file-path">{change.path}</code>
              <span class="file-counts" aria-label="Line changes">
                <span class="additions">+{change.additions ?? '?'}</span>
                <span class="deletions">−{change.deletions ?? '?'}</span>
              </span>
              {#if change.touchedAt !== undefined}
                <time datetime={new Date(change.touchedAt).toISOString()}>
                  {formatRelativeAge(change.touchedAt, now)}
                </time>
              {:else}
                <span class="touch-unknown">time unknown</span>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    </details>
  {/if}
{/snippet}

{#snippet content(text: string)}
  <MessageContent {text} {onopenorg} {onopenfile} {oncopyresult} {clipboard} />
{/snippet}

{#if attention || pendingInteractions.length}
  <PendingChatRequests>
    {#if attention}
      <AutopilotAttention
        attention={attentionReport(attention)}
        pending={attentionPending}
        controlId={`chat-attention-${attention.requestId}`}
        onresolve={onattentionresolve}
        ondebug={onattentiondebug}
        {debugPending}
        {onopenorg}
        {onopenfile}
        {oncopyresult}
      />
    {/if}
    <InteractionList
      interactions={pendingInteractions}
      {answers}
      {submittedAnswers}
      {onanswer}
      {onquiz}
      {onpermission}
      {ondecision}
      {onretry}
      {onopenorg}
      {onopenfile}
      {oncopyresult}
    />
  </PendingChatRequests>
{/if}
<ol aria-label="Chat messages">
  {#if detached.length}
    <li class="progress-item">
      <section class={activeTurnId ? 'progress-turn' : 'orphan-activity-turn'}>
        {#if activeTurnId}
          <div class="entry-heading"><strong>working</strong></div>
          <ActivityList activities={regularActivities(detached)} variant="live" />
          {@render changedFiles(detached)}
        {:else}
          <WorkDetails activities={detached} {now} />
        {/if}
      </section>
    </li>
  {/if}
  {#each displayGroups as group, index (group.id)}
    <li
      class={group.kind === 'user'
        ? 'prompt-turn'
        : group.kind === 'audit'
          ? 'audit-item'
          : 'answer-item'}
    >
      {#if group.kind === 'interaction'}
        <InteractionList
          interactions={[group.interaction]}
          {answers}
          {submittedAnswers}
          {onanswer}
          {onquiz}
          {onpermission}
          {ondecision}
          {onretry}
          {onopenorg}
          {onopenfile}
          {oncopyresult}
        />
      {:else if group.kind === 'audit'}
        {#if group.attention}
          <AutopilotAttention
            attention={attentionReport(group.attention)}
            historical={attention?.requestId !== group.attention.requestId}
            resolvedAt={interactions.find((item) => item.requestId === group.attention?.requestId)
              ?.resolvedAt}
            pending={attentionPending}
            controlId={`chat-attention-${group.attention.requestId}`}
            onresolve={onattentionresolve}
            ondebug={onattentiondebug}
            {debugPending}
            {onopenorg}
            {onopenfile}
            {oncopyresult}
          />
        {:else}
          <aside class="autopilot-audit" aria-label="Autopilot audit entry">
            <strong>Autopilot</strong>
            {group.text}{group.count > 1 ? ` · ${group.count} times` : ''}
            {#if group.occurredAt}
              <time datetime={new Date(group.occurredAt).toISOString()}
                >{formatMessageTime(group.occurredAt)}</time
              >
            {/if}
            {#if group.count > 1}
              <details>
                <summary>Show {group.count} timestamps</summary>
                <ul>
                  {#each group.timestamps as timestamp (`${group.id}:${timestamp}`)}
                    <li>
                      <time datetime={new Date(timestamp).toISOString()}
                        >{formatMessageTime(timestamp)}</time
                      >
                    </li>
                  {/each}
                </ul>
              </details>
            {/if}
          </aside>
        {/if}
      {:else if group.kind === 'user'}
        {@const ownedActivities = promptActivities(group)}
        <div class="entry-heading">
          <strong>prompt</strong>
          {#if group.occurredAt}
            <time datetime={new Date(group.occurredAt).toISOString()}>
              {formatMessageTime(group.occurredAt)}
              {#if timeLabel(index, group.occurredAt)}
                · {timeLabel(index, group.occurredAt)}
              {/if}
            </time>
          {/if}
        </div>
        <div class="entry-content">{@render content(group.text)}</div>
        {#if ownedActivities.length}
          <section class={isPromptLive(group) ? 'progress-turn' : 'orphan-activity-turn'}>
            {#if isPromptLive(group)}
              <div class="entry-heading"><strong>working</strong></div>
              <ActivityList activities={regularActivities(ownedActivities)} variant="live" />
              {@render changedFiles(ownedActivities)}
            {:else}
              <WorkDetails activities={ownedActivities} {now} />
            {/if}
          </section>
        {/if}
      {:else if group.answer !== null}
        {@const ownedActivities = turnActivities(group)}
        <section class="answer-turn">
          <div class="entry-heading">
            <strong>{isLive(group) ? 'working' : 'answer'}</strong>
            {#if group.occurredAt}
              <time datetime={new Date(group.occurredAt).toISOString()}>
                {formatMessageTime(group.occurredAt)}
                {#if timeLabel(index, group.occurredAt)}
                  · {timeLabel(index, group.occurredAt)}
                {/if}
              </time>
            {/if}
          </div>
          {#if isLive(group)}
            {#if group.commentary}
              <div class="commentary-content live-commentary">
                {@render content(group.commentary)}
              </div>
            {/if}
            <ActivityList activities={regularActivities(ownedActivities)} variant="live" />
          {:else if group.commentary || regularActivities(ownedActivities).length}
            <div class="answer-history">
              {#if group.commentary}
                <button
                  class="commentary-toggle"
                  type="button"
                  aria-expanded={Boolean(expandedCommentary[group.id])}
                  aria-controls={`commentary-${group.id}`}
                  onclick={() => (expandedCommentary[group.id] = !expandedCommentary[group.id])}
                >
                  <span aria-hidden="true">{expandedCommentary[group.id] ? '⌄' : '›'}</span>
                  commentary
                </button>
              {/if}
            </div>
          {/if}
          {#if !isLive(group) && group.commentary && expandedCommentary[group.id]}
            <div class="commentary-content" id={`commentary-${group.id}`}>
              {@render content(group.commentary)}
            </div>
          {/if}
          <div class="entry-content">{@render content(group.answer)}</div>
          <WorkDetails activities={ownedActivities} {now} />
        </section>
      {:else if group.commentary !== null}
        {@const ownedActivities = turnActivities(group)}
        <section class={isLive(group) ? 'progress-turn' : 'commentary-turn'}>
          <div class="entry-heading">
            <strong>{isLive(group) ? 'working' : 'commentary'}</strong>
            {#if group.occurredAt}
              <time datetime={new Date(group.occurredAt).toISOString()}>
                {formatMessageTime(group.occurredAt)}
                {#if timeLabel(index, group.occurredAt)}
                  · {timeLabel(index, group.occurredAt)}
                {/if}
              </time>
            {/if}
          </div>
          {#if isLive(group)}
            {#if group.commentary}
              <div class="entry-content">{@render content(group.commentary)}</div>
            {/if}
            <ActivityList activities={regularActivities(ownedActivities)} variant="live" />
          {:else}
            <details>
              <summary>commentary</summary>
              {@render content(group.commentary)}
            </details>
            <WorkDetails activities={ownedActivities} {now} />
          {/if}
          {#if isLive(group)}{@render changedFiles(ownedActivities)}{/if}
        </section>
      {/if}
    </li>
  {/each}
  {#if autopilotAuditTruncated}
    <li class="audit-incomplete" role="status">
      Earlier Autopilot audit entries are not shown; this timeline contains the retained recent
      audit.
    </li>
  {/if}
</ol>
{@render footer?.()}

<style>
  .autopilot-audit {
    border-inline-start: 0.25rem solid var(--theme-border);
    padding-inline-start: 0.5rem;
    overflow-wrap: anywhere;
  }
  .audit-incomplete {
    border-inline-start: 0.35rem solid var(--theme-border);
    color: var(--theme-text-muted);
    margin-block: 0.5rem;
    padding-inline-start: 0.65rem;
  }
  .autopilot-audit time {
    color: var(--theme-text-muted);
    margin-inline-start: 0.5rem;
  }
  .autopilot-audit summary {
    scroll-margin-block: var(--sticky-header-clearance) var(--bottom-navigation-clearance);
  }
  ol {
    inline-size: 100%;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    box-sizing: border-box;
    inline-size: 100%;
    margin-block-end: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  li + li {
    margin-block-start: 1rem;
  }

  .prompt-turn {
    padding: 0.5rem 0.625rem;
    background: var(--theme-surface-subtle);
    border-inline-start: 0.25rem solid var(--theme-accent);
    border-radius: 0.375rem;
  }

  .answer-turn {
    border-inline-start: 0.25rem solid var(--theme-border);
    padding-inline-start: 0.625rem;
  }

  .commentary-turn,
  .orphan-activity-turn,
  .progress-turn,
  .commentary-content {
    padding: 0.5rem 0.625rem;
    background: var(--theme-surface-subtle);
    border-inline-start: 0.25rem solid var(--theme-info);
    border-radius: 0.375rem;
  }

  .live-commentary {
    background: transparent;
  }

  .progress-turn {
    background: transparent;
  }

  .entry-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.75rem;
  }

  time {
    margin-inline-start: auto;
    color: var(--theme-text-muted);
    font-size: 0.875em;
    white-space: normal;
  }

  .commentary-toggle {
    min-block-size: 1.5rem;
    padding: 0 0.125rem;
    color: var(--theme-text-muted);
    background: transparent;
    border: 0;
    font-size: 0.875em;
  }

  .answer-history {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.75rem;
    margin-block: 0.2rem 0.35rem;
  }

  .file-changes {
    margin-block: 0.5rem;
    padding: 0.5rem 0.625rem;
    background: var(--theme-surface-subtle);
    border-inline-start: 0.25rem solid var(--theme-success);
    border-radius: 0.375rem;
  }

  .file-changes > summary {
    color: var(--theme-text-muted);
    font-size: 0.875em;
    cursor: pointer;
  }

  .file-changes > summary:focus-visible {
    outline: 2px solid var(--theme-focus);
    outline-offset: 2px;
  }

  .file-changes ul {
    display: grid;
    gap: 0.15rem;
    margin: 0.25rem 0 0;
    padding-inline-start: 1.25rem;
  }

  .file-changes li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: baseline;
    gap: 0.4rem 0.75rem;
  }

  .file-path {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .file-counts {
    display: inline-flex;
    gap: 0.35rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .additions {
    color: var(--theme-success);
  }

  .deletions {
    color: var(--theme-error);
  }

  .file-changes time,
  .touch-unknown {
    color: var(--theme-text-muted);
    font-size: 0.8em;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  @media (max-width: 32rem) {
    .file-changes li {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .file-changes time,
    .touch-unknown {
      grid-column: 2;
    }
  }

  .commentary-content {
    margin-block: 0.25rem 0.5rem;
  }

  .entry-content {
    margin-block: 0.125rem 0;
    margin-inline: 0;
  }
</style>
