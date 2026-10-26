<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    readinessLabel,
    repositoryLabel,
    semanticState,
    type SessionRetrievalReadiness,
  } from '../../../shared/contracts/retrieval-readiness.js';

  let {
    status = null,
    loading = false,
    onrefresh = () => {},
  }: {
    status?: SessionRetrievalReadiness | null;
    loading?: boolean;
    onrefresh?: () => void;
  } = $props();
  const repositories = $derived(Array.isArray(status?.repositories) ? status.repositories : []);
  const connections = $derived(Array.isArray(status?.connections) ? status.connections : []);
  const states = $derived(repositories.map((entry) => semanticState(entry.readiness)));
  const state = $derived(
    states.includes('unavailable')
      ? 'unavailable'
      : states.includes('stale')
        ? 'stale'
        : states.length && states.every((value) => value === 'ready')
          ? 'ready'
          : 'unknown',
  );
  const summary = $derived(state === 'ready' ? 'Ready on observed source' : readinessLabel(state));
</script>

<section aria-labelledby="retrieval-readiness-title" aria-busy={loading} class="tool-readiness">
  <h2 id="retrieval-readiness-title">Repository tools</h2>
  <details>
    <summary aria-label={`Repository tool readiness: ${summary}`}>{summary}</summary>
    <div class="readiness-details">
      {#if connections.length}
        <dl>
          {#each connections as connection (connection.serverName)}
            <div>
              <dt>
                {connection.serverName === 'gestalt-serena'
                  ? 'Serena connection'
                  : 'XERJ connection'}
              </dt>
              <dd>{readinessLabel(connection.readiness?.connection?.state)}</dd>
            </div>
          {/each}
        </dl>
      {/if}
      {#if repositories.length}
        <ul>
          {#each repositories as entry (`${entry.threadId}:${entry.readiness.repository?.id}`)}
            {@const observedAt = [
              entry.readiness.symbols?.observedAt,
              entry.readiness.references?.observedAt,
            ]
              .filter((value): value is string => Boolean(value))
              .sort()
              .at(-1)}
            <li>
              <strong>{repositoryLabel(entry.readiness.repository?.label ?? 'Repository')}</strong>
              <small class="identity"
                >{entry.readiness.repository?.id.slice(0, 8)} · runtime {entry.threadId.slice(
                  0,
                  8,
                )}</small
              >
              <dl
                aria-label={`${repositoryLabel(entry.readiness.repository?.label ?? 'Repository')} capability observations`}
              >
                <div>
                  <dt>Symbols</dt>
                  <dd>{readinessLabel(entry.readiness.symbols?.state)}</dd>
                </div>
                <div>
                  <dt>References</dt>
                  <dd>{readinessLabel(entry.readiness.references?.state)}</dd>
                </div>
                <div>
                  <dt>Repository index</dt>
                  <dd>{readinessLabel(entry.readiness.coverage?.state)}</dd>
                </div>
              </dl>
              {#if observedAt}<small class="identity"
                  >Observed <time datetime={observedAt}
                    >{new Date(observedAt).toLocaleString()}</time
                  ></small
                >{/if}
            </li>
          {/each}
        </ul>
        <p>
          Symbol and reference results apply to the observed source only. Compiler selection is
          unverified.
        </p>
      {:else}
        <p>
          No repository evidence yet. Read permissions may be unavailable in restricted profiles.
          Compiler selection and repository index coverage are unverified.
        </p>
      {/if}
      <p>
        Connection alone does not verify semantic tools. Continue with current source when a check
        is unverified.
      </p>
      <button type="button" disabled={loading} onclick={onrefresh}
        >{loading ? 'Checking readiness…' : 'Refresh tool readiness'}</button
      >
    </div>
  </details>
</section>

<style>
  .tool-readiness {
    margin-block-start: 0.75rem;
    padding-block-start: 0.75rem;
    border-block-start: 1px solid var(--theme-border);
    font-size: 0.75rem;
  }
  h2 {
    margin: 0 0 0.4rem;
    color: var(--theme-text-muted);
    font-size: inherit;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  summary {
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  .readiness-details {
    display: grid;
    gap: 0.6rem;
    margin-block-start: 0.6rem;
    min-inline-size: 0;
  }
  dl {
    display: grid;
    gap: 0.25rem;
    margin: 0;
  }
  dl > div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.6rem;
  }
  dt {
    color: var(--theme-text-muted);
  }
  dd {
    margin: 0;
    text-align: end;
  }
  ul {
    display: grid;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    min-inline-size: 0;
  }
  strong,
  .identity {
    display: block;
    overflow-wrap: anywhere;
  }
  .identity {
    color: var(--theme-text-muted);
    margin-block: 0.2rem 0.4rem;
    font-variant-numeric: tabular-nums;
  }
  p {
    margin: 0;
    max-inline-size: 72ch;
    overflow-wrap: anywhere;
    color: var(--theme-text-muted);
  }
  button {
    inline-size: 100%;
    min-block-size: 2.75rem;
    white-space: normal;
    font-size: inherit;
  }
</style>
