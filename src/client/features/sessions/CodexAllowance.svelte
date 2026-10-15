<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import type { CodexAllowance } from '../../../shared/contracts/codex-allowance.js';

  let { fetcher, onerror }: { fetcher: typeof fetch; onerror: () => void } = $props();
  let allowance = $state<CodexAllowance | null>(null);
  let loading = $state(true);
  let now = $state(Date.now());
  let days = $derived(
    allowance?.weeklyResetsAt == null
      ? null
      : Math.ceil((allowance.weeklyResetsAt * 1000 - now) / 86_400_000),
  );
  let resetLabel = $derived(
    days == null
      ? 'Reset date unavailable'
      : days <= 0
        ? 'Reset due'
        : days === 1
          ? 'Resets within 1 day'
          : `Resets in ${days} days`,
  );

  onMount(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reported = false;
    const refresh = async () => {
      try {
        const response = await fetcher('/api/codex/allowance', { signal: controller.signal });
        if (!response.ok) throw new Error('Allowance unavailable');
        const value = (await response.json()) as CodexAllowance;
        if (!controller.signal.aborted) {
          allowance = value;
          now = Date.now();
          reported = false;
        }
      } catch {
        if (!controller.signal.aborted) {
          allowance = null;
          if (!reported) onerror();
          reported = true;
        }
      } finally {
        if (!controller.signal.aborted) {
          loading = false;
          timer = setTimeout(() => void refresh(), 60_000);
        }
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  });
</script>

<section class="allowance" aria-label="Codex allowance" aria-busy={loading}>
  <div class="weekly">
    <div class="summary">
      <span>Codex weekly allowance</span>
      <strong
        >{loading
          ? 'Loading…'
          : allowance?.weeklyRemainingPercent == null
            ? 'Unavailable'
            : `${allowance.weeklyRemainingPercent}% left`}</strong
      >
    </div>
    {#if allowance?.weeklyRemainingPercent != null}
      <progress
        aria-label="Weekly allowance remaining"
        value={allowance.weeklyRemainingPercent}
        max="100"
      ></progress>
    {:else}
      <div class="empty-track" aria-hidden="true"></div>
    {/if}
    <span
      class="detail"
      title={allowance?.weeklyResetsAt == null
        ? undefined
        : new Date(allowance.weeklyResetsAt * 1000).toLocaleString()}
      >{loading ? 'Checking reset date…' : resetLabel}</span
    >
  </div>
  <div class="resets">
    <span class="detail">Reset credits</span>
    <strong
      >{loading
        ? 'Loading…'
        : allowance?.resetsAvailable == null
          ? 'Unavailable'
          : `${allowance.resetsAvailable} available`}</strong
    >
  </div>
</section>

<style>
  .allowance {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1rem 1.5rem;
    padding-block: 0.25rem 1.25rem;
    margin-block-end: 1.25rem;
    border-block-end: 1px solid var(--theme-border);
  }
  .weekly {
    flex: 1 1 15rem;
    min-inline-size: 0;
  }
  .summary {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.25rem 1rem;
    font-size: 0.875rem;
  }
  strong {
    font-variant-numeric: tabular-nums;
  }
  progress,
  .empty-track {
    display: block;
    inline-size: 100%;
    block-size: 0.5rem;
    margin-block: 0.625rem;
    border: 0;
    border-radius: 0.25rem;
    overflow: hidden;
    background: var(--theme-control-hover);
  }
  progress {
    appearance: none;
    accent-color: var(--theme-accent);
  }
  progress::-webkit-progress-bar {
    background: var(--theme-control-hover);
  }
  progress::-webkit-progress-value {
    background: var(--theme-accent);
  }
  progress::-moz-progress-bar {
    background: var(--theme-accent);
  }
  .detail {
    color: var(--theme-text-muted);
    font-size: 0.8125rem;
  }
  .resets {
    display: grid;
    gap: 0.375rem;
    font-size: 0.875rem;
  }
</style>
