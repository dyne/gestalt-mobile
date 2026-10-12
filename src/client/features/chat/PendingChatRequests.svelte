<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { OrgPlanAttention } from '../autopilot/contracts.js';
  import type { ProjectedInteraction } from './chat-projection.js';

  let {
    interactions,
    attention,
    activeTurnId = null,
  }: {
    interactions: readonly ProjectedInteraction[];
    attention: OrgPlanAttention | null;
    activeTurnId?: string | null;
  } = $props();
  let pending = $derived(
    interactions.filter(
      (item) =>
        item.state !== 'resolved' &&
        item.kind !== 'orgPlanAttention' &&
        item.kind !== 'orgPlanCheckpoint' &&
        item.kind !== 'autopilotWaitLease',
    ),
  );
  const labels: Record<string, string> = {
    quiz: 'Quiz answer',
    userInput: 'Answer',
    commandApproval: 'Command approval',
    fileChangeApproval: 'File approval',
    permissionsApproval: 'Permission approval',
  };
  function review(id: string): void {
    const element = document.getElementById(id);
    element?.scrollIntoView({ block: 'start' });
    const banner = document.querySelector('.pending-requests');
    if (element && banner) {
      const top = element.getBoundingClientRect().top;
      const bottom = banner.getBoundingClientRect().bottom;
      if (top < bottom) window.scrollBy({ top: top - bottom - 8 });
    }
    element?.focus({ preventScroll: true });
  }
</script>

{#if attention || pending.length}
  <aside class="pending-requests" aria-label="Pending chat requests" role="status">
    <strong
      >{attention ? 'Autopilot needs your attention' : 'Requests awaiting your response'}</strong
    >
    {#if attention}
      <p>{attention.supervisorReport || attention.attention.summary}</p>
      <button type="button" onclick={() => review(`chat-attention-${attention.requestId}`)}
        >Review Autopilot blocker</button
      >
    {/if}
    {#each pending as interaction (interaction.key)}
      {@const earlierQuiz =
        interaction.kind === 'quiz' && interaction.turnId && interaction.turnId !== activeTurnId}
      <div>
        <span
          >{earlierQuiz
            ? 'Earlier quiz remains unanswered. Autopilot can continue.'
            : `${labels[interaction.kind] ?? 'Response'} needed to continue.`}</span
        >
        <button type="button" onclick={() => review(`chat-request-${interaction.requestId}`)}
          >Review {labels[interaction.kind]?.toLowerCase() ?? 'request'}</button
        >
      </div>
    {/each}
  </aside>
{/if}

<style>
  :global(html:has(.pending-requests)) {
    scroll-padding-block: calc(var(--sticky-header-clearance) + 30vh + 1rem)
      var(--bottom-navigation-clearance);
  }
  .pending-requests {
    position: sticky;
    inset-block-start: var(--sticky-header-clearance);
    z-index: 1;
    background: var(--theme-page);
    max-block-size: 30vh;
    overflow-y: auto;
    padding: 0.75rem;
    border: 1px solid var(--theme-accent);
    border-radius: 0.5rem;
    overflow-wrap: anywhere;
  }
  p {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    margin-block: 0.4rem;
  }
  .pending-requests div {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  button {
    min-height: 2.75rem;
  }
</style>
