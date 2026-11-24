<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import { onMount, tick, type Snippet } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import AutopilotAttention from '../autopilot/AutopilotAttention.svelte';
  import type { OrgPlanAttention } from '../autopilot/contracts.js';
  import { boundedAttentionReport } from '../../../shared/contracts/attention-report.js';
  import { parseOrgPlanAttention } from '../../../shared/contracts/org-plan-attention.js';
  import ActivityList from './ActivityList.svelte';
  import WorkDetails from './WorkDetails.svelte';
  import InteractionList from './InteractionList.svelte';
  import PendingChatRequests from './PendingChatRequests.svelte';
  import { isServiceStatusActivity, type HistoryActivity } from './activity-summary.js';
  import type { ChatMessage } from './message-store.js';
  import { visibleInteraction, withoutDialogueEchoes } from './interaction-timeline.js';
  import { groupMessages } from './message-groups.js';
  import { formatElapsedAfter, formatMessageTime, formatRelativeAge } from './message-time.js';
  import { summarizeChangedFiles, summarizeFileChangeTotals } from './file-change-summary.js';
  import MessageContent from './MessageContent.svelte';
  import WorkingContent from './WorkingContent.svelte';
  import { copyText } from '../sessions/clipboard.js';
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
    oncopyresult?(copied: boolean, subject?: 'code' | 'answer'): void;
  };
  let {
    messages,
    activities: allActivities,
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
  let activities = $derived(allActivities.filter((activity) => !isServiceStatusActivity(activity)));
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
  const rawAnswers = new SvelteSet<string>();
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
  let assistantByTurn = $derived(
    new Map(
      assistantGroups.filter((group) => group.turnId).map((group) => [group.turnId, group.id]),
    ),
  );
  let promptByTurn = $derived(
    new Map(promptGroups.filter((group) => group.turnId).map((group) => [group.turnId, group.id])),
  );
  function activityAnswerOwnerId(activity: HistoryActivity): string | null {
    if (activity.turnId) {
      const exact = assistantByTurn.get(activity.turnId);
      if (exact) return exact;
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
  function activityPromptOwnerId(activity: HistoryActivity): string | null {
    if (activity.turnId) {
      const exact = promptByTurn.get(activity.turnId);
      if (exact) return exact;
    }
    if (activity.occurredAt === undefined) return null;
    return (
      promptGroups.findLast(
        (group) => group.occurredAt !== undefined && group.occurredAt <= activity.occurredAt!,
      )?.id ?? null
    );
  }
  // Resolve each activity once per history change. Rendering every answer must
  // not repeat an all-activities/all-answers search on a long conversation.
  let activitiesByOwner = $derived.by(() => {
    const owners = new Map<string | null, HistoryActivity[]>();
    for (const activity of activities) {
      const owner = activityAnswerOwnerId(activity) ?? activityPromptOwnerId(activity);
      const items = owners.get(owner);
      if (items) items.push(activity);
      else owners.set(owner, [activity]);
    }
    return owners;
  });
  let detached = $derived(activitiesByOwner.get(null) ?? []);
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

{#snippet workingContent(text: string)}
  <WorkingContent {text} {onopenorg} {onopenfile} {oncopyresult} {clipboard} />
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
        {@const ownedActivities = activitiesByOwner.get(group.id) ?? []}
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
        {@const ownedActivities = activitiesByOwner.get(group.id) ?? []}
        {@const live = isLive(group)}
        {@const answer = group.answer}
        {@const raw = rawAnswers.has(group.id)}
        <section
          class="answer-turn"
          data-reading-order={live ? 'newest-first' : 'top-down'}
          aria-label={live ? 'Working, newest paragraphs first' : 'Answer, read from top to bottom'}
        >
          <div class="entry-heading" class:finished-heading={!live}>
            <strong>{live ? 'working' : 'answer'}</strong>
            {#if !live}
              <div class="answer-tools">
                <button
                  type="button"
                  class="mode-switch"
                  role="switch"
                  aria-label="Raw answer text"
                  aria-checked={raw}
                  onclick={() => {
                    if (raw) rawAnswers.delete(group.id);
                    else rawAnswers.add(group.id);
                  }}
                >
                  <span class="mode-track" aria-hidden="true"
                    ><span class:selected={!raw}>View</span><span class:selected={raw}>Raw</span
                    ></span
                  >
                </button>
                <button
                  type="button"
                  class="copy-answer"
                  aria-label="Copy answer"
                  title="Copy answer"
                  onclick={async () => oncopyresult(await copyText(answer, clipboard), 'answer')}
                >
                  <Icon name="copy" size="1rem" />
                </button>
              </div>
            {/if}
            {#if group.occurredAt}
              <time datetime={new Date(group.occurredAt).toISOString()}>
                {formatMessageTime(group.occurredAt)}
                {#if timeLabel(index, group.occurredAt)}
                  · {timeLabel(index, group.occurredAt)}
                {/if}
              </time>
            {/if}
          </div>
          {#if live}
            <div class="entry-content">{@render workingContent(group.answer)}</div>
            {#if group.commentary}
              <div class="commentary-content live-commentary" data-reading-order="newest-first">
                {@render workingContent(group.commentary)}
              </div>
            {/if}
            <ActivityList activities={regularActivities(ownedActivities)} variant="live" />
            {@render changedFiles(ownedActivities)}
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
          {#if !live && group.commentary && expandedCommentary[group.id]}
            <div
              class="commentary-content"
              data-reading-order="top-down"
              id={`commentary-${group.id}`}
            >
              {@render content(group.commentary)}
            </div>
          {/if}
          {#if !live}
            <div class="entry-content">
              {#if raw}<pre class="raw-answer"><code>{answer}</code></pre>
              {:else}{@render content(answer)}{/if}
            </div>
            <WorkDetails activities={ownedActivities} {now} />
          {/if}
        </section>
      {:else if group.commentary !== null}
        {@const ownedActivities = activitiesByOwner.get(group.id) ?? []}
        <section
          class="progress-turn"
          data-reading-order="newest-first"
          aria-label="Working, newest paragraphs first"
        >
          <div class="entry-heading">
            <strong>working</strong>
            {#if group.occurredAt}
              <time datetime={new Date(group.occurredAt).toISOString()}>
                {formatMessageTime(group.occurredAt)}
                {#if timeLabel(index, group.occurredAt)}
                  · {timeLabel(index, group.occurredAt)}
                {/if}
              </time>
            {/if}
          </div>
          {#if group.commentary}
            <div class="entry-content">{@render workingContent(group.commentary)}</div>
          {/if}
          {#if isLive(group)}
            <ActivityList activities={regularActivities(ownedActivities)} variant="live" />
          {:else}
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
    padding: 0.75rem 1rem;
    background: var(--theme-surface-subtle);
    border-radius: 0.875rem;
  }

  .answer-turn {
    padding-inline: 0.75rem;
  }

  .orphan-activity-turn,
  .progress-turn,
  .commentary-content {
    padding: 0.5rem 0.625rem;
    background: var(--theme-surface-subtle);
    border-inline-start: 1px solid var(--theme-info);
    border-radius: 0.25rem;
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
    color: var(--theme-text-muted);
    font-size: 0.875rem;
  }

  [data-reading-order] {
    position: relative;
    padding-inline-start: 1rem;
    border-inline-start: 0;
    --reading-line: var(--theme-border);
  }

  [data-reading-order='newest-first'] {
    --reading-line: var(--theme-info);
  }

  [data-reading-order]::before,
  [data-reading-order]::after {
    content: '';
    position: absolute;
    pointer-events: none;
    overflow-anchor: none;
  }

  [data-reading-order]::before {
    inset-block: 3px;
    inset-inline-start: 4px;
    border-inline-start: 2px solid var(--reading-line);
  }

  [data-reading-order]::after {
    inset-inline-start: 1px;
    inline-size: 6px;
    block-size: 6px;
    border: solid var(--reading-line);
    border-width: 0 2px 2px 0;
  }

  [data-reading-order='top-down']::after {
    inset-block-end: 3px;
    transform: rotate(45deg);
  }
  [data-reading-order='newest-first']::after {
    inset-block-start: 3px;
    transform: rotate(225deg);
  }

  .finished-heading {
    flex-wrap: nowrap;
    align-items: center;
    gap: 0.375rem;
  }
  .finished-heading time {
    min-inline-size: 0;
    text-align: end;
  }
  .answer-tools {
    display: inline-flex;
    align-items: center;
    flex: none;
  }
  .answer-tools button {
    display: grid;
    place-items: center;
    min-block-size: 32px;
    padding: 0;
    background: transparent;
    color: var(--theme-text-muted);
    border: 0;
  }
  .mode-track {
    display: flex;
    padding: 2px;
    border-radius: var(--theme-radius);
    background: var(--theme-surface-subtle);
    font-size: 0.8125rem;
    line-height: 1.4;
  }
  .mode-track span {
    padding: 0.05rem 0.375rem;
    border-radius: calc(var(--theme-radius) - 2px);
  }
  .mode-track .selected {
    background: var(--theme-text);
    color: var(--theme-surface);
    font-weight: 600;
  }
  .copy-answer {
    inline-size: 32px;
  }
  .copy-answer:hover {
    color: var(--theme-text);
  }
  @media (pointer: coarse) {
    .answer-tools button {
      min-block-size: 44px;
    }
    .copy-answer {
      inline-size: 44px;
    }
  }
  .raw-answer {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: 0.875rem / 1.5 var(--theme-font-code);
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
