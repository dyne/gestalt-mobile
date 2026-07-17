<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { HistoryActivity } from './activity-summary.js';
  let { activities }: { activities: HistoryActivity[] } = $props();
</script>

{#if activities.length}
  <section aria-labelledby="activities-title">
    <h3 id="activities-title">Activity</h3>
    {#each activities as activity (activity.id)}
      <details><summary>{activity.label}</summary><pre>{activity.detail}</pre></details>
    {/each}
  </section>
{/if}
