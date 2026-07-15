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
