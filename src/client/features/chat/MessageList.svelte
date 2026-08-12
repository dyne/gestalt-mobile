<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import ActivityList from './ActivityList.svelte';
  import InteractionList from './InteractionList.svelte';
  import type { HistoryActivity } from './activity-summary.js';
  import type { ChatMessage } from './message-store.js';
  import { groupMessages } from './message-groups.js';
  import { formatElapsedAfter, formatMessageTime } from './message-time.js';
  import { renderCommentary, type CommentaryPart } from './rendering.js';
  import type { ProjectedInteraction } from './chat-projection.js';

  type Props = {
    messages: ChatMessage[];
    activities: HistoryActivity[];
    activeTurnId?: string | null;
    interactions?: ProjectedInteraction[];
    answers?: Record<string, string>;
    onanswer?(requestId: string, id: string, value: string): void;
    onquiz?(interaction: ProjectedInteraction): void;
    onpermission?(interaction: ProjectedInteraction): void;
    ondecision?(id: string, decision: 'accept' | 'decline'): void;
    onretry?(interaction: ProjectedInteraction): void;
  };
  let {
    messages,
    activities,
    activeTurnId = null,
    interactions = [],
    answers = {},
    onanswer = () => {},
    onquiz = () => {},
    onpermission = () => {},
    ondecision = () => {},
    onretry = () => {},
  }: Props = $props();
  let groups = $derived(groupMessages(messages));
  let expandedCommentary = $state<Record<string, boolean>>({});
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
  function fileChanges(items: HistoryActivity[]): Array<{ id: string; paths: string[] }> {
    return items.flatMap((activity) =>
      activity.label.toLowerCase().replaceAll(' ', '').startsWith('filechange')
        ? [{ id: activity.id, paths: activity.detail.split('\n').filter(Boolean) }]
        : [],
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
</script>

{#snippet inline(parts: CommentaryPart[])}
  {#each parts as part, partIndex (partIndex)}
    {#if part.kind === 'link'}
      <a href={part.href} target="_blank" rel="noreferrer">{part.text}</a>
    {:else if part.kind === 'code'}
      <code>{part.text}</code>
    {:else}
      {part.text}
    {/if}
  {/each}
{/snippet}

{#snippet changedFiles(items: HistoryActivity[])}
  {@const changes = fileChanges(items)}
  {#if changes.length}
    <section class="file-changes" aria-label="Files changed">
      <strong>files changed</strong>
      <ul>
        {#each changes as change (change.id)}
          {#each change.paths as path (`${change.id}:${path}`)}
            <li><code>{path}</code></li>
          {/each}
        {/each}
      </ul>
    </section>
  {/if}
{/snippet}

{#snippet content(text: string)}
  {#each renderCommentary(text) as block, blockIndex (blockIndex)}
    {#if block.kind === 'code'}
      <pre><code>{block.text}</code></pre>
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
    {:else}
      <div>{@render inline(block.parts)}</div>
    {/if}
  {/each}
{/snippet}

<ol aria-label="Chat messages">
  {#each groups as group, index (group.id)}
    <li class={group.kind === 'user' ? 'prompt-turn' : 'answer-item'}>
      {#if group.kind === 'user'}
        {@const ownedActivities = promptActivities(group)}
        <div class="entry-heading">
          <strong>prompt</strong>
          {#if group.occurredAt}
            <time datetime={new Date(group.occurredAt).toISOString()}>
              {formatMessageTime(group.occurredAt)}
              {#if formatElapsedAfter(groups[index - 1]?.occurredAt, group.occurredAt)}
                · {formatElapsedAfter(groups[index - 1]?.occurredAt, group.occurredAt)}
              {/if}
            </time>
          {/if}
        </div>
        <div class="entry-content">{@render content(group.text)}</div>
        <InteractionList
          interactions={turnInteractions(group)}
          {answers}
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
                {#if formatElapsedAfter(groups[index - 1]?.occurredAt, group.occurredAt)}
                  · {formatElapsedAfter(groups[index - 1]?.occurredAt, group.occurredAt)}
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
              <ActivityList activities={regularActivities(ownedActivities)} />
            </div>
          {/if}
          {#if !isLive(group) && group.commentary && expandedCommentary[group.id]}
            <div class="commentary-content" id={`commentary-${group.id}`}>
              {@render content(group.commentary)}
            </div>
          {/if}
          {@render changedFiles(ownedActivities)}
          <div class="entry-content">{@render content(group.answer)}</div>
        </section>
      {:else if group.commentary !== null}
        {@const ownedActivities = turnActivities(group)}
        <section class={isLive(group) ? 'progress-turn' : 'commentary-turn'}>
          <div class="entry-heading">
            <strong>{isLive(group) ? 'working' : 'commentary'}</strong>
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

  .commentary-content {
    margin-block: 0.25rem 0.5rem;
  }

  .entry-content {
    margin-block: 0.125rem 0;
    margin-inline: 0;
  }

  pre,
  code {
    font-family: var(--theme-font-code);
  }

  pre {
    padding: 0.625rem;
    white-space: pre;
    overflow-x: auto;
    background: var(--theme-code);
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
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
</style>
