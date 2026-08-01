<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { readCommandApproval } from './command-approval.js';
  import { readUserInputQuestions } from './user-input-request.js';
  type Interaction = { requestId: string; kind: string; payload: unknown };
  type Props = { interactions: Interaction[]; answers: Record<string, string>; onanswer(id: string, value: string): void; onuserinput(interaction: Interaction): void; onpermission(interaction: Interaction): void; ondecision(id: string, decision: 'accept' | 'decline'): void };
  let { interactions, answers, onanswer, onuserinput, onpermission, ondecision }: Props = $props();
</script>
{#if interactions.length}
  <section aria-labelledby="interactions-title"><h3 id="interactions-title">Codex needs your decision</h3>
    {#each interactions as interaction (interaction.requestId)}
      <article><p>{interaction.kind}</p>
        {#if interaction.kind === 'userInput'}
          {@const questions = readUserInputQuestions(interaction.payload)}
          <form onsubmit={(event) => { event.preventDefault(); onuserinput(interaction); }}>
            {#each questions as question (question.id)}
              <label for={`${interaction.requestId}-${question.id}`}>{question.header}: {question.question}</label>
              <input id={`${interaction.requestId}-${question.id}`} type={question.isSecret ? 'password' : 'text'} value={answers[question.id] ?? ''} oninput={(event) => onanswer(question.id, event.currentTarget.value)} />
              {#each question.options as option (option.label)}<button type="button" onclick={() => onanswer(question.id, option.label)}>{option.label}</button>{/each}
            {/each}
            <button type="submit" disabled={!questions.length}>Send answers</button>
          </form>
        {:else if interaction.kind === 'permissionsApproval'}
          <p>Grant the requested permissions for this turn only.</p><button type="button" onclick={() => onpermission(interaction)}>Approve</button>
        {:else if interaction.kind === 'commandApproval'}
          {@const command = readCommandApproval(interaction.payload)}
          <p>Approve this command?</p>
          {#if command}
            <pre class="command-approval-command"><code>{command}</code></pre>
          {:else}
            <p class="command-approval-missing">Command details were not provided.</p>
          {/if}
          <div class="approval-actions">
            <button type="button" onclick={() => ondecision(interaction.requestId, 'accept')}>Approve</button>
            <button type="button" onclick={() => ondecision(interaction.requestId, 'decline')}>Deny</button>
          </div>
        {:else}
          <button type="button" onclick={() => ondecision(interaction.requestId, 'accept')}>Approve</button><button type="button" onclick={() => ondecision(interaction.requestId, 'decline')}>Deny</button>
        {/if}
      </article>
    {/each}
  </section>
{/if}

<style>
  .command-approval-command {
    max-inline-size: 100%;
    margin-block: 0.5rem 0.75rem;
    padding: 0.625rem;
    overflow-x: auto;
    white-space: pre-wrap;
    background: color-mix(in srgb, CanvasText 8%, Canvas);
    border-radius: 0.375rem;
  }
  .command-approval-missing { margin-block: 0.5rem 0.75rem; }
  .approval-actions { display: flex; flex-wrap: wrap; gap: clamp(0.5rem, 2vw, 1rem); }
</style>
