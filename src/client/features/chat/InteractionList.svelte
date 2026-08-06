<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { readCommandApproval } from './command-approval.js';
  import { readFileChangeApproval } from './file-change-approval.js';
  import QuizForm from './QuizForm.svelte';
  import { mapNativeUserInputToQuiz, parseQuiz } from '../../../shared/contracts/quiz.js';
  type Interaction = { requestId: string; kind: string; payload: unknown };
  type Props = { interactions: Interaction[]; answers: Record<string, string>; onanswer(requestId: string, id: string, value: string): void; onquiz(interaction: Interaction): void; onpermission(interaction: Interaction): void; ondecision(id: string, decision: 'accept' | 'decline'): void };
  let { interactions, answers, onanswer, onquiz, onpermission, ondecision }: Props = $props();
  const scopedAnswers = (requestId: string) => Object.fromEntries(Object.entries(answers).filter(([key]) => key.startsWith(`${requestId}:`)).map(([key, value]) => [key.slice(requestId.length + 1), value]));
</script>
{#if interactions.length}
  <section aria-labelledby="interactions-title"><h3 id="interactions-title">Codex needs your decision</h3>
    {#each interactions as interaction (interaction.requestId)}
      <article><p>{interaction.kind}</p>
        {#if interaction.kind === 'userInput' || interaction.kind === 'quiz'}
          {@const quiz = interaction.kind === 'quiz' ? parseQuiz(interaction.payload) : mapNativeUserInputToQuiz(interaction.payload)}
          {#if quiz}
            <QuizForm requestId={interaction.requestId} {quiz} answers={scopedAnswers(interaction.requestId)} onanswer={(id, value) => onanswer(interaction.requestId, id, value)} onsubmit={() => onquiz(interaction)} />
          {:else}<p>Codex sent an invalid quiz request.</p>{/if}
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
    font-family: var(--theme-font-code);
    background: var(--theme-code);
    border: 1px solid var(--theme-border);
    border-radius: 0.375rem;
  }
  .command-approval-missing { margin-block: 0.5rem 0.75rem; }
  .file-change-approval-targets { margin-block: 0.5rem 0.75rem; padding-inline-start: 1.5rem; overflow-wrap: anywhere; }
  .file-change-approval-missing { margin-block: 0.5rem 0.75rem; }
  .approval-actions { display: flex; flex-wrap: wrap; gap: clamp(0.5rem, 2vw, 1rem); }
</style>
