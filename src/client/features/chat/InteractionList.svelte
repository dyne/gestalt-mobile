<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { tick } from 'svelte';
  import { readCommandApproval } from './command-approval.js';
  import { readFileChangeApproval } from './file-change-approval.js';
  import QuizForm from './QuizForm.svelte';
  import type { SubmittedQuizAnswer } from './quiz-submission.js';
  import { mapNativeUserInputToQuiz, parseQuiz } from '../../../shared/contracts/quiz.js';
  type Interaction = {
    requestId: string;
    key?: string;
    kind: string;
    payload: unknown;
    state?: 'pending' | 'submitting' | 'resolved' | 'failed';
    attemptedOutcome?: unknown;
  };
  type Props = {
    interactions: Interaction[];
    answers: Record<string, string>;
    submittedAnswers?: Record<string, readonly SubmittedQuizAnswer[]>;
    onanswer(requestId: string, id: string, value: string): void;
    onquiz(interaction: Interaction): void;
    onpermission(interaction: Interaction): void;
    ondecision(id: string, decision: 'accept' | 'decline'): void;
    onretry?(interaction: Interaction): void;
  };
  let {
    interactions,
    answers,
    submittedAnswers = {},
    onanswer,
    onquiz,
    onpermission,
    ondecision,
    onretry = () => {},
  }: Props = $props();
  let focusRequestId = $state<string | null>(null);
  let resultElements = $state<Record<string, HTMLElement | undefined>>({});
  const scopedAnswers = (requestId: string) =>
    Object.fromEntries(
      Object.entries(answers)
        .filter(([key]) => key.startsWith(`${requestId}:`))
        .map(([key, value]) => [key.slice(requestId.length + 1), value]),
    );
  function submit(interaction: Interaction, action: () => void): void {
    focusRequestId = interaction.requestId;
    action();
  }
  $effect(() => {
    const interaction = interactions.find((item) => item.requestId === focusRequestId);
    if (interaction?.state === 'resolved') {
      void tick().then(() => resultElements[interaction.requestId]?.focus());
      focusRequestId = null;
    }
  });
</script>

{#each interactions as interaction (interaction.key ?? interaction.requestId)}
  {@const submitting = interaction.state === 'submitting'}
  <article class:resolved={interaction.state === 'resolved'}>
    <p class="interaction-kind">{interaction.kind}</p>
    {#if interaction.state === 'resolved'}
      <p
        class="interaction-result"
        data-interaction-state="resolved"
        tabindex="-1"
        bind:this={resultElements[interaction.requestId]}
      >
        {interaction.attemptedOutcome === 'denied'
          ? 'Denied'
          : interaction.attemptedOutcome === 'dismissed'
            ? 'No longer awaiting a response'
            : interaction.attemptedOutcome === 'answered'
              ? 'Answers sent'
              : 'Approved'}
      </p>
    {:else}
      {#if submitting}<p class="interaction-submitting" data-interaction-state="submitting">
          Submitting…
        </p>{/if}
      {#if interaction.kind === 'userInput' || interaction.kind === 'quiz'}
        {@const quiz =
          interaction.kind === 'quiz'
            ? parseQuiz(interaction.payload)
            : mapNativeUserInputToQuiz(interaction.payload)}
        {#if quiz}
          <QuizForm
            requestId={interaction.requestId}
            {quiz}
            answers={scopedAnswers(interaction.requestId)}
            disabled={submitting}
            onanswer={(id, value) => onanswer(interaction.requestId, id, value)}
            onsubmit={() => submit(interaction, () => onquiz(interaction))}
          />
        {:else}<p>Codex sent an invalid quiz request.</p>{/if}
      {:else if interaction.kind === 'permissionsApproval'}
        <p>Grant the requested permissions for this turn only.</p>
        <button
          type="button"
          disabled={submitting}
          onclick={() => submit(interaction, () => onpermission(interaction))}>Approve</button
        >
      {:else if interaction.kind === 'commandApproval'}
        {@const command = readCommandApproval(interaction.payload)}
        <p>Approve this command?</p>
        {#if command}
          <pre class="command-approval-command"><code>{command}</code></pre>
        {:else}
          <p class="command-approval-missing">Command details were not provided.</p>
        {/if}
        <div class="approval-actions">
          <button
            type="button"
            disabled={submitting}
            onclick={() => submit(interaction, () => ondecision(interaction.requestId, 'accept'))}
            >Approve</button
          >
          <button
            type="button"
            disabled={submitting}
            onclick={() => submit(interaction, () => ondecision(interaction.requestId, 'decline'))}
            >Deny</button
          >
        </div>
      {:else if interaction.kind === 'fileChangeApproval'}
        {@const paths = readFileChangeApproval(interaction.payload)}
        <p>Approve changes to these files?</p>
        {#if paths}
          <ul class="file-change-approval-targets" aria-label="Files to change">
            {#each paths as path (path)}
              <li><code>{path}</code></li>
            {/each}
          </ul>
        {:else}
          <p class="file-change-approval-missing">File details were not provided.</p>
        {/if}
        <div class="approval-actions">
          <button
            type="button"
            disabled={submitting}
            onclick={() => submit(interaction, () => ondecision(interaction.requestId, 'accept'))}
            >Approve</button
          >
          <button
            type="button"
            disabled={submitting}
            onclick={() => submit(interaction, () => ondecision(interaction.requestId, 'decline'))}
            >Deny</button
          >
        </div>
      {:else}
        <button
          type="button"
          disabled={submitting}
          onclick={() => submit(interaction, () => ondecision(interaction.requestId, 'accept'))}
          >Approve</button
        ><button
          type="button"
          disabled={submitting}
          onclick={() => submit(interaction, () => ondecision(interaction.requestId, 'decline'))}
          >Deny</button
        >
      {/if}
      {#if interaction.state === 'failed'}
        <p class="interaction-failed" data-interaction-state="failed">Could not send. Try again.</p>
        <button type="button" onclick={() => onretry(interaction)}>Retry</button>
      {/if}
    {/if}
    {#if submittedAnswers[interaction.requestId]?.length}
      <section class="submitted-answers" aria-label="Submitted answers" aria-live="polite">
        <p><strong>Submitted answers</strong></p>
        <ol>
          {#each submittedAnswers[interaction.requestId] as answer (answer.id)}
            <li>
              <span class="submitted-question"
                ><strong>{answer.header}</strong> — {answer.question}</span
              >
              <span class="submitted-answer">{answer.answer}</span>
            </li>
          {/each}
        </ol>
        <p class="submitted-note">Recorded in this chat view before delivery.</p>
      </section>
    {/if}
  </article>
{/each}

<style>
  article {
    margin-block: 0.75rem;
    padding: 0.75rem;
    background: var(--theme-surface-subtle);
    border-inline-start: 0.25rem solid var(--theme-info);
    border-radius: 0.375rem;
  }
  .submitted-answers {
    display: grid;
    gap: 0.5rem;
    margin-block-start: 0.75rem;
    padding-block-start: 0.75rem;
    border-block-start: 1px solid var(--theme-border);
  }
  .submitted-answers p,
  .submitted-answers ol {
    margin: 0;
  }
  .submitted-answers ol {
    display: grid;
    gap: 0.625rem;
    padding-inline-start: 1.25rem;
  }
  .submitted-answers li,
  .submitted-question,
  .submitted-answer {
    overflow-wrap: anywhere;
  }
  .submitted-question,
  .submitted-answer {
    display: block;
  }
  .submitted-answer {
    margin-block-start: 0.125rem;
    white-space: pre-wrap;
  }
  .submitted-note {
    color: var(--theme-text-muted);
    font-size: 0.85rem;
  }
  .interaction-kind,
  .interaction-submitting,
  .interaction-result,
  .interaction-failed {
    margin-block: 0 0.5rem;
  }
  .interaction-result {
    font-weight: 600;
  }
  .command-approval-command {
    max-inline-size: 100%;
    margin-block: 0.5rem 0.75rem;
    padding: 0.625rem;
    overflow-x: auto;
    white-space: pre-wrap;
    font-family: var(--theme-font-code);
    background: var(--theme-code);
    border: 1px solid var(--theme-border);
    border-radius: 0.375rem;
  }
  .command-approval-missing {
    margin-block: 0.5rem 0.75rem;
  }
  .file-change-approval-targets {
    margin-block: 0.5rem 0.75rem;
    padding-inline-start: 1.5rem;
    overflow-wrap: anywhere;
  }
  .file-change-approval-missing {
    margin-block: 0.5rem 0.75rem;
  }
  .approval-actions {
    display: flex;
    flex-wrap: wrap;
    gap: clamp(0.5rem, 2vw, 1rem);
  }
</style>
