<script lang="ts">
  let { status }: { status: string } = $props();
</script>

<header>
  <h1>Codex Relay</h1>
  <p role="status">{status}</p>
</header>
