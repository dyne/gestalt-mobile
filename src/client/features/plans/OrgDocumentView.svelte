<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import OrgNotes from './OrgNotes.svelte';
  import PlanFilePath from './PlanFilePath.svelte';
  import type { WorkspaceOrgPreview } from '../sessions/relay-client.js';
  import { parseOrgDocument } from './org-document.js';

  type Props = {
    preview: WorkspaceOrgPreview;
    onclose: () => void;
    verifiedReferences?: ReadonlySet<string>;
    onreference?: (path: string) => void;
    sourcePath?: string;
    oncopyresult?: (copied: boolean) => void;
    executeAction?: Snippet;
  };

  let {
    preview,
    onclose,
    onreference,
    verifiedReferences = new Set<string>(),
    sourcePath,
    oncopyresult,
    executeAction,
  }: Props = $props();
  let document = $derived(parseOrgDocument(preview.source));
  let metadata = $derived(document.metadata.filter(([key]) => key !== 'TITLE'));
</script>

<article class="org-document" aria-labelledby="org-document-title">
  <header>
    <div class="document-heading">
      <h2 id="org-document-title">{preview.title}</h2>
      <PlanFilePath path={preview.sourcePath || sourcePath || preview.planName} {oncopyresult} />
    </div>
    {#if executeAction}<div class="execute-slot">{@render executeAction()}</div>{/if}
    <button class="close" type="button" aria-label="Close plan and return to list" onclick={onclose}
      >×</button
    >
  </header>

  {#if metadata.length}
    <dl class="metadata">
      {#each metadata as [label, value] (`${label}:${value}`)}
        <div>
          <dt>{label}</dt>
          <dd><OrgNotes text={value || '—'} {onreference} {verifiedReferences} /></dd>
        </div>
      {/each}
    </dl>
  {/if}

  {#each document.preamble as line, index (`preamble:${index}:${line}`)}
    {#if line.trim()}<p><OrgNotes text={line} {onreference} {verifiedReferences} /></p>{/if}
  {/each}

  {#if document.sections.length === 0}
    <p>This Org document has no headings.</p>
  {:else}
    <div class="sections">
      {#each document.sections as section, index (`${index}:${section.level}:${section.title}`)}
        <section class="org-section" style:--org-depth={Math.max(0, section.level - 1)}>
          <div class="section-heading">
            {#if section.level === 1}
              <h3>{section.title}</h3>
            {:else}
              <h4>{section.title}</h4>
            {/if}
            {#if section.state}<span class={`state state-${section.state.toLowerCase()}`}
                >{section.state}</span
              >{/if}
            {#if section.priority}<span class="priority">Priority {section.priority}</span>{/if}
          </div>
          {#if section.descriptions.length}
            <dl class="descriptions">
              {#each section.descriptions as [label, value] (`${label}:${value}`)}
                <div>
                  <dt>{label}</dt>
                  <dd><OrgNotes text={value || '—'} {onreference} {verifiedReferences} /></dd>
                </div>
              {/each}
            </dl>
          {/if}
          {#each section.body as line, lineIndex (`${lineIndex}:${line}`)}
            {#if line.trim()}<p class:list-item={line.trimStart().startsWith('- ')}>
                <OrgNotes text={line} {onreference} {verifiedReferences} />
              </p>{/if}
          {/each}
          {#if section.properties.length}
            <details class="properties">
              <summary>Properties</summary>
              <dl>
                {#each section.properties as [label, value] (`${label}:${value}`)}
                  <div>
                    <dt>{label}</dt>
                    <dd><OrgNotes text={value || '—'} {onreference} {verifiedReferences} /></dd>
                  </div>
                {/each}
              </dl>
            </details>
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</article>

<style>
  .org-document {
    display: grid;
    min-inline-size: 0;
    gap: 0.85rem;
    overflow-wrap: anywhere;
  }
  header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
  }
  .section-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.65rem;
  }
  header {
    align-items: start;
    gap: 0.65rem;
  }
  header h2,
  .section-heading :is(h3, h4),
  p,
  dl,
  dd {
    margin: 0;
  }
  .document-heading {
    flex: 1 1 15rem;
    min-inline-size: 0;
  }
  .close {
    grid-column: 3;
    grid-row: 1;
    flex: 0 0 auto;
    min-inline-size: 44px;
    min-block-size: 44px;
    font-size: 1.35rem;
    line-height: 1;
  }
  .metadata,
  .descriptions,
  .properties dl {
    display: grid;
    gap: 0.4rem;
  }
  .metadata div,
  .descriptions div,
  .properties dl div {
    display: grid;
    grid-template-columns: minmax(6rem, 0.3fr) minmax(0, 1fr);
    gap: 0.65rem;
  }
  dt {
    font-weight: 700;
  }
  .sections {
    display: grid;
    gap: 0.65rem;
  }
  .org-section {
    display: grid;
    gap: 0.55rem;
    margin-inline-start: min(calc(var(--org-depth) * 0.8rem), 2.4rem);
    padding: 0.8rem;
    background: color-mix(in srgb, var(--theme-surface) 82%, transparent);
    border: 1px solid var(--theme-border);
    border-inline-start: 0.3rem solid var(--theme-accent);
    border-radius: 0.65rem;
  }
  .section-heading {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
  .section-heading :is(h3, h4) {
    flex: 1 1 14rem;
  }
  .state,
  .priority {
    padding: 0.15rem 0.45rem;
    font-size: 0.8rem;
    font-weight: 700;
    border: 1px solid currentColor;
    border-radius: 999px;
  }
  .state-done {
    color: var(--theme-success);
  }
  .state-wip {
    color: var(--theme-accent);
  }
  .list-item {
    padding-inline-start: 0.75rem;
  }
  .properties summary {
    cursor: pointer;
    font-weight: 700;
  }
  .properties dl {
    margin-block-start: 0.5rem;
  }
  button:focus-visible,
  summary:focus-visible {
    outline: 3px solid currentColor;
    outline-offset: 2px;
  }
  @media (max-width: 32rem) {
    .metadata div,
    .descriptions div,
    .properties dl div {
      grid-template-columns: 1fr;
      gap: 0.1rem;
    }
    .org-section {
      margin-inline-start: min(calc(var(--org-depth) * 0.35rem), 1rem);
    }
  }
  .execute-slot {
    display: contents;
  }
  @media (max-width: 40rem) {
    header {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .document-heading {
      display: contents;
    }
    .document-heading :global(.plan-file-path) {
      grid-column: 1;
      grid-row: 2;
    }
    .close {
      grid-column: 2;
    }
  }
  @media (max-width: 24rem) {
    .document-heading :global(.plan-file-path) {
      grid-column: 1 / -1;
    }
  }
</style>
