<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { tick } from 'svelte';
  import type { Quiz } from '../../../shared/contracts/quiz.js';

  type Props = {
    requestId: string;
    quiz: Quiz;
    answers: Record<string, string>;
    onanswer(id: string, value: string): void;
    onsubmit(): void;
  };
  let { requestId, quiz, answers, onanswer, onsubmit }: Props = $props();
  let customInputs = $state<Record<string, HTMLInputElement | undefined>>({});
  let customSelected = $state<Record<string, boolean>>({});
  let complete = $derived(quiz.questions.every((question) => Boolean(answers[question.id]?.trim())));

  async function chooseCustom(id: string) {
    customSelected[id] = true;
    onanswer(id, answers[id] ?? '');
    await tick();
    customInputs[id]?.focus();
  }
</script>

<form class="quiz-form" onsubmit={(event) => { event.preventDefault(); if (complete) onsubmit(); }}>
  {#each quiz.questions as question (question.id)}
    {@const inputId = `${requestId}-${question.id}-custom`}
    {@const selectedChoice = question.choices.some((choice) => choice.label === answers[question.id])}
    <fieldset>
      <legend><strong>{question.header}</strong><span>{question.question}</span></legend>
      <div class="choices">
        {#each question.choices as choice (`${question.id}-${choice.label}`)}
          {@const choiceId = `${requestId}-${question.id}-${choice.label}`}
          <div class="choice">
            <input id={choiceId} name={`${requestId}-${question.id}`} type="radio" checked={answers[question.id] === choice.label} onchange={() => { customSelected[question.id] = false; onanswer(question.id, choice.label); }} />
            <label for={choiceId}><strong>{choice.label}</strong><span>{choice.description}</span></label>
          </div>
        {/each}
        {#if question.allowCustom}
          <div class="choice">
            <input id={inputId} name={`${requestId}-${question.id}`} type="radio" checked={customSelected[question.id] || (Boolean(answers[question.id]) && !selectedChoice)} onchange={() => chooseCustom(question.id)} onclick={() => { if (customSelected[question.id]) void chooseCustom(question.id); }} />
            <label for={inputId}><strong>Custom answer</strong><span>Provide your own response.</span></label>
          </div>
          {#if customSelected[question.id] || (Boolean(answers[question.id]) && !selectedChoice)}
            <label class="custom" for={`${inputId}-text`}>Your custom answer
              <input bind:this={customInputs[question.id]} id={`${inputId}-text`} type={question.isSecret ? 'password' : 'text'} value={answers[question.id]} required oninput={(event) => onanswer(question.id, event.currentTarget.value)} />
            </label>
          {/if}
        {/if}
      </div>
    </fieldset>
  {/each}
  <button type="submit" disabled={!complete}>Send answers</button>
</form>

<style>
  .quiz-form { display: grid; gap: 1rem; }
  fieldset { min-inline-size: 0; margin: 0; padding: 0; border: 0; }
  legend { display: grid; gap: 0.25rem; max-inline-size: 100%; }
  .choices { display: grid; gap: 0.5rem; margin-block-start: 0.5rem; }
  .choice { position: relative; }
  .choice > input { position: absolute; inset: 0; inline-size: 100%; block-size: 100%; margin: 0; opacity: 0; cursor: pointer; }
  .choice > label { display: grid; gap: 0.125rem; min-block-size: 44px; padding: 0.75rem; background: var(--theme-surface); border: 2px solid var(--theme-border); border-radius: 0.5rem; }
  .choice > input:checked + label { border-width: 3px; border-color: var(--theme-accent); background: var(--theme-surface-subtle); }
  .choice > input:focus-visible + label { outline: 3px solid var(--theme-focus); outline-offset: 2px; }
  label span, legend span { color: var(--theme-text-muted); }
  .custom { margin-block-start: 0.25rem; }
  .custom input { inline-size: 100%; min-block-size: 44px; margin-block-start: 0.375rem; box-sizing: border-box; font: inherit; }
</style>
