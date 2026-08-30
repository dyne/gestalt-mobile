<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import ActivityList from './ActivityList.svelte';
  import WorkDetails from './WorkDetails.svelte';
  import InteractionList from './InteractionList.svelte';
  import type { HistoryActivity } from './activity-summary.js';
  import type { ChatMessage } from './message-store.js';
  import { groupMessages } from './message-groups.js';
  import { formatElapsedAfter, formatMessageTime, formatRelativeAge } from './message-time.js';
  import { summarizeChangedFiles } from './file-change-summary.js';
  import { renderCommentary, type CommentaryPart } from './rendering.js';
  import type { ProjectedInteraction } from './chat-projection.js';
  import type { SubmittedQuizAnswer } from './quiz-submission.js';
  import { isLocalOrgHref } from '../plans/org-plan-link.js';
  import { copyText } from '../sessions/clipboard.js';

  type Props = {
    messages: ChatMessage[];
    activities: HistoryActivity[];
    activeTurnId?: string | null;
    autopilotAuditTruncated?: boolean;
    interactions?: ProjectedInteraction[];
    answers?: Record<string, string>;
    submittedAnswers?: Record<string, readonly SubmittedQuizAnswer[]>;
    clipboard?: Pick<Clipboard, 'writeText'>;
    onanswer?(requestId: string, id: string, value: string): void;
    onquiz?(interaction: ProjectedInteraction): void;
    onpermission?(interaction: ProjectedInteraction): void;
    ondecision?(id: string, decision: 'accept' | 'decline'): void;
    onretry?(interaction: ProjectedInteraction): void;
    onopenorg?(href: string): void;
    oncopyresult?(copied: boolean): void;
  };
  let {
    messages,
    activities,
    activeTurnId = null,
    autopilotAuditTruncated = false,
    interactions = [],
    answers = {},
    submittedAnswers = {},
    clipboard = globalThis.navigator?.clipboard,
    onanswer = () => {},
    onquiz = () => {},
    onpermission = () => {},
    ondecision = () => {},
    onretry = () => {},
    onopenorg,
    oncopyresult = () => {},
  }: Props = $props();
  let groups = $derived(groupMessages(messages));
  let expandedCommentary = $state<Record<string, boolean>>({});
  let now = $state(Date.now());
  onMount(() => {
    const timer = globalThis.setInterval(() => (now = Date.now()), 1_000);
    return () => globalThis.clearInterval(timer);
  });
  let promptGroups = $derived(groups.filter((group) => group.kind === 'user'));
  let assistantGroups = $derived(groups.filter((group) => group.kind === 'assistant'));
  let latestAssistantId = $derived(assistantGroups.at(-1)?.id);
  let unassignedInteractions = $derived(
    interactions.filter(
      (interaction) =>
        !interaction.turnId || !promptGroups.some((group) => group.turnId === interaction.turnId),
    ),
  );
  function ownerGroupId(interaction: ProjectedInteraction): string | null {
    return (
      promptGroups.findLast((group) => group.turnId && group.turnId === interaction.turnId)?.id ??
      promptGroups.at(-1)?.id ??
      null
    );
  }
  function turnInteractions(group: (typeof groups)[number]): ProjectedInteraction[] {
    if (group.kind !== 'user') return [];
    return interactions.filter((interaction) => ownerGroupId(interaction) === group.id);
  }
  function turnActivities(group: (typeof groups)[number]): HistoryActivity[] {
    if (group.kind !== 'assistant') return [];
    return activities.filter((activity) =>
      activity.turnId ? activity.turnId === group.turnId : group.id === latestAssistantId,
    );
  }
  function assistantOwnsActivity(activity: HistoryActivity): boolean {
    return activity.turnId
      ? assistantGroups.some((group) => group.turnId === activity.turnId)
      : Boolean(latestAssistantId);
  }
  function activityPromptOwnerId(activity: HistoryActivity): string | null {
    if (!activity.turnId || assistantOwnsActivity(activity)) return null;
    return promptGroups.findLast((group) => group.turnId === activity.turnId)?.id ?? null;
  }
  function promptActivities(group: (typeof groups)[number]): HistoryActivity[] {
    if (group.kind !== 'user') return [];
    return activities.filter((activity) => activityPromptOwnerId(activity) === group.id);
  }
  function detachedActivities(): HistoryActivity[] {
    return activities.filter(
      (activity) => !assistantOwnsActivity(activity) && !activityPromptOwnerId(activity),
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
    return formatElapsedAfter(groups[index - 1]?.occurredAt, occurredAt);
  }
  function openOrg(event: MouseEvent, href: string): void {
    if (!onopenorg || !isLocalOrgHref(href)) return;
    event.preventDefault();
    onopenorg(href);
  }
  function codeCopyLabel(text: string): string {
    const preview = text.trim().split('\n')[0]?.trim() || 'empty block';
    return `Copy code block: ${preview.slice(0, 48)}`;
  }
  async function copyCode(text: string): Promise<void> {
    oncopyresult(await copyText(text, clipboard));
  }
</script>

{#snippet inline(parts: CommentaryPart[])}
  {#each parts as part, partIndex (partIndex)}
    {#if part.kind === 'link'}
      {#if onopenorg && isLocalOrgHref(part.href)}
        <a href={part.href} onclick={(event) => openOrg(event, part.href)}>{part.text}</a>
      {:else}
        <a href={part.href} target="_blank" rel="noreferrer">{part.text}</a>
      {/if}
    {:else if part.kind === 'code'}
      <code>{part.text}</code>
    {:else if part.kind === 'strong'}
      <strong>{@render inline(part.parts)}</strong>
    {:else}
      {part.text}
    {/if}
  {/each}
{/snippet}

{#snippet changedFiles(items: HistoryActivity[])}
  {@const changes = summarizeChangedFiles(items)}
  {#if changes.length}
    <section class="file-changes" aria-label="Files changed">
      <strong>files changed</strong>
      <ul>
        {#each changes as change (change.path)}
          <li>
            <code class="file-path">{change.path}</code>
            <span class="file-counts" aria-label="Line changes">
              <span class="additions">+{change.additions ?? '?'}</span>
              <span class="deletions">-{change.deletions ?? '?'}</span>
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
  {/if}
{/snippet}

{#snippet content(text: string)}
  {#each renderCommentary(text) as block, blockIndex (blockIndex)}
    {#if block.kind === 'code'}
      <div class="code-block">
        <button
          class="code-copy"
          type="button"
          aria-label={codeCopyLabel(block.text)}
          title="Copy code"
          onclick={() => void copyCode(block.text)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <rect x="9" y="9" width="10" height="10" rx="2" />
            <path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
          </svg>
        </button>
        <pre><code>{block.text}</code></pre>
      </div>
    {:else if block.kind === 'table'}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              {#each block.headers as header, headerIndex (headerIndex)}
                <th scope="col">{@render inline(header)}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each block.rows as row, rowIndex (rowIndex)}
              <tr>
                {#each row as cell, cellIndex (cellIndex)}
                  <td>{@render inline(cell)}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if block.kind === 'heading'}
      {#if block.level === 1}
        <h1>{@render inline(block.parts)}</h1>
      {:else if block.level === 2}
        <h2>{@render inline(block.parts)}</h2>
      {:else if block.level === 3}
        <h3>{@render inline(block.parts)}</h3>
      {:else if block.level === 4}
        <h4>{@render inline(block.parts)}</h4>
      {:else if block.level === 5}
        <h5>{@render inline(block.parts)}</h5>
      {:else}
        <h6>{@render inline(block.parts)}</h6>
      {/if}
    {:else}
      <div>{@render inline(block.parts)}</div>
    {/if}
  {/each}
{/snippet}

<ol aria-label="Chat messages">
  {#if autopilotAuditTruncated}
    <li class="audit-incomplete" role="status">
      Earlier Autopilot audit entries are not shown; this timeline contains the retained recent
      audit.
    </li>
  {/if}
  {#each groups as group, index (group.id)}
    <li
      class={group.kind === 'user'
        ? 'prompt-turn'
        : group.kind === 'audit'
          ? 'audit-item'
          : 'answer-item'}
    >
      {#if group.kind === 'audit'}
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
        <InteractionList
          interactions={turnInteractions(group)}
          {answers}
          {submittedAnswers}
          {onanswer}
          {onquiz}
          {onpermission}
          {ondecision}
          {onretry}
        />
        {#if ownedActivities.length}
          <section class={isPromptLive(group) ? 'progress-turn' : 'orphan-activity-turn'}>
            {#if isPromptLive(group)}
              <div class="entry-heading"><strong>working</strong></div>
              <ActivityList activities={regularActivities(ownedActivities)} variant="live" />
            {:else}
              <ActivityList activities={regularActivities(ownedActivities)} />
            {/if}
            {@render changedFiles(ownedActivities)}
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
          <WorkDetails activities={ownedActivities} {now} />
          <div class="entry-content">{@render content(group.answer)}</div>
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
            <ActivityList activities={regularActivities(ownedActivities)} />
          {/if}
          {@render changedFiles(ownedActivities)}
        </section>
      {/if}
    </li>
  {/each}
  {#if promptGroups.length === 0 && unassignedInteractions.length}
    <li class="interaction-only">
      <InteractionList
        interactions={unassignedInteractions}
        {answers}
        {submittedAnswers}
        {onanswer}
        {onquiz}
        {onpermission}
        {ondecision}
        {onretry}
      />
    </li>
  {/if}
  {#if detached.length}
    <li class="progress-item">
      <section class={activeTurnId ? 'progress-turn' : 'orphan-activity-turn'}>
        {#if activeTurnId}
          <div class="entry-heading"><strong>working</strong></div>
          <ActivityList activities={regularActivities(detached)} variant="live" />
        {:else}
          <ActivityList activities={regularActivities(detached)} />
        {/if}
        {@render changedFiles(detached)}
      </section>
    </li>
  {/if}
</ol>

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
    align-items: baseline;
    gap: 0.75rem;
  }

  time {
    margin-inline-start: auto;
    color: var(--theme-text-muted);
    font-size: 0.875em;
    white-space: nowrap;
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

  .file-changes > strong {
    font-size: 0.875em;
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

  :is(h1, h2, h3, h4, h5, h6) {
    margin-block: 0.85em 0.3em;
    line-height: 1.25;
    text-wrap: balance;
  }

  :is(h1, h2, h3):first-child {
    margin-block-start: 0.25em;
  }

  h1 {
    font-size: 1.5em;
  }

  h2 {
    font-size: 1.3em;
  }

  h3 {
    font-size: 1.15em;
  }

  :is(h4, h5, h6) {
    font-size: 1em;
  }

  pre,
  code {
    font-family: var(--theme-font-code);
  }

  pre {
    margin: 0;
    padding: 0.625rem;
    padding-inline-end: 3rem;
    white-space: pre;
    overflow-x: auto;
    background: var(--theme-code);
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
  }

  .code-block {
    position: relative;
    margin-block: 0.75rem;
  }

  .code-copy {
    position: absolute;
    inset-block-start: 0.375rem;
    inset-inline-end: 0.375rem;
    z-index: 1;
    display: grid;
    place-items: center;
    inline-size: 2rem;
    min-block-size: 2rem;
    padding: 0;
    color: var(--theme-text-muted);
    background: var(--theme-surface-subtle);
    border: 1px solid var(--theme-border);
    border-radius: 0.375rem;
  }

  .code-copy:hover {
    color: var(--theme-text);
    background: var(--theme-control-hover);
  }

  .code-copy:focus-visible {
    color: var(--theme-text);
    outline: 2px solid var(--theme-focus);
    outline-offset: 2px;
  }

  .code-copy svg {
    inline-size: 1rem;
    block-size: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  :not(pre) > code {
    padding-inline: 0.2em;
    background: var(--theme-code);
    border-radius: 0.2rem;
  }

  a {
    color: var(--theme-info);
  }

  .table-scroll {
    overflow-x: auto;
    margin-block: 0.75rem;
  }

  table {
    width: max-content;
    min-width: 100%;
    border-collapse: collapse;
    white-space: normal;
  }

  th,
  td {
    padding: 0.25rem 0.5rem;
    text-align: left;
    vertical-align: top;
    border: 1px solid var(--theme-border);
  }

  th {
    font-weight: 600;
    background: var(--theme-surface-subtle);
  }

  @media (pointer: coarse) {
    pre {
      padding-inline-end: 3.75rem;
    }

    .code-copy {
      inline-size: 2.75rem;
      min-block-size: 2.75rem;
    }
  }
</style>
