<script lang="ts">
  type ThemePreference = 'system' | 'light' | 'dark';

  let {
    theme,
    onthemechange,
  }: {
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
</header>

<div id="configuration-panel" class="configuration-panel" popover="auto">
  <div class="configuration-brand" aria-label="Dyne">
    <img class="configuration-logo light-asset" src="/branding/dyne-logotype-black.svg" alt="" />
    <img class="configuration-logo dark-asset" src="/branding/dyne-logotype-white.svg" alt="" />
  </div>
  <label class="appearance-control" for="appearance">
    <span aria-hidden="true">aA</span>
    <select
      id="appearance"
      aria-label="Appearance"
      value={theme}
      onchange={(event) => onthemechange(event.currentTarget.value as ThemePreference)}
    >
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>
</div>
