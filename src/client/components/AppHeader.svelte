<script lang="ts">
  type ThemePreference = 'system' | 'light' | 'dark';

  let {
    status,
    theme,
    onthemechange,
  }: {
    status: string;
    theme: ThemePreference;
    onthemechange: (theme: ThemePreference) => void;
  } = $props();
</script>

<header class="app-header">
  <a class="brand" href="/" aria-label="Gestalt Mobile">
    <img class="brand-icon light-asset" src="/branding/p_glogo_grey.svg" alt="" />
    <img class="brand-icon dark-asset" src="/branding/p_glogo_white.svg" alt="" />
    <img class="brand-logotype light-asset" src="/branding/t_glogo_grey.svg" alt="" />
    <img class="brand-logotype dark-asset" src="/branding/t_glogo_white.svg" alt="" />
  </a>
  <button
    class="menu-trigger"
    type="button"
    popovertarget="configuration-panel"
    aria-label="Open configuration"
  >
    <span class="menu-lines" aria-hidden="true"><span></span><span></span><span></span></span>
  </button>
  <p role="status">{status}</p>
</header>

<div id="configuration-panel" class="configuration-panel" popover="auto">
  <h2>Configuration</h2>
  <label for="appearance">Appearance</label>
  <select
    id="appearance"
    value={theme}
    onchange={(event) => onthemechange(event.currentTarget.value as ThemePreference)}
  >
    <option value="system">System</option>
    <option value="light">Light</option>
    <option value="dark">Dark</option>
  </select>
</div>
