<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { debugIdentifierRows, type DebugContext } from '../../../shared/contracts/self-debug.js';
  let { context }: { context: DebugContext } = $props();
</script>

<div class="debug-identifiers">
  <h3>Debug identifiers</h3>
  <dl>
    {#each debugIdentifierRows(context) as [label, value] (label)}
      <div>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    {/each}
  </dl>
  <h3>Versions</h3>
  <dl>
    {#each context.versions as component (component.id)}
      <div>
        <dt>{component.label}</dt>
        <dd>{component.version ?? 'Unavailable'}</dd>
      </div>
    {/each}
  </dl>
</div>

<style>
  .debug-identifiers {
    min-inline-size: 0;
  }
  h3 {
    margin: 1rem 0 0.5rem;
    font-size: 1rem;
  }
  dl {
    display: grid;
    gap: 0.5rem;
    margin: 0;
  }
  dl > div {
    display: grid;
    grid-template-columns: minmax(7rem, 0.4fr) minmax(0, 1fr);
    gap: 0.75rem;
  }
  dt {
    color: var(--theme-text-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
    font-family: var(--theme-font-code);
    font-size: 0.85rem;
  }
  @media (max-width: 34rem) {
    dl > div {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.15rem;
    }
  }
</style>
