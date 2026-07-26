<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { tick } from 'svelte';

  import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
  import type { SkillsState } from './skills-state.js';

  type Props = {
    workspaceTree: WorkspaceOption[];
    codexProfiles: Array<{ name: string; state: string; status: string }>;
    skillsState: SkillsState;
    onworkspacechange: (workspaceId: string) => void;
    oncodexprofilechange: (profile: string) => void;
  };

  let { workspaceTree, codexProfiles, skillsState, onworkspacechange, oncodexprofilechange }: Props = $props();
  let revision = $state(0);
  let saveError = $state<HTMLElement | null>(null);
  let snapshot = $derived.by(() => {
    revision;
    return skillsState;
  });
  let workspaces = $derived(flattenWorkspaces(workspaceTree));
  let validProfiles = $derived(snapshot.profiles.filter((profile) => !('error' in profile)));

  function changed(): void {
    skillsState = Object.assign(Object.create(Object.getPrototypeOf(skillsState)), skillsState);
    revision += 1;
  }

  function selectWorkspace(event: Event): void {
    onworkspacechange((event.currentTarget as HTMLSelectElement).value);
  }

  function selectCodexProfile(event: Event): void {
    oncodexprofilechange((event.currentTarget as HTMLSelectElement).value);
  }

  function selectSavedProfile(event: Event): void {
    snapshot.selectProfile((event.currentTarget as HTMLSelectElement).value);
    changed();
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await snapshot.save();
    changed();
    if (snapshot.status.kind === 'save-failed') {
      await tick();
      saveError?.focus();
    }
  }

  function safeBrandColor(color: string | undefined): string | undefined {
    return color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined;
  }

  function flattenWorkspaces(roots: WorkspaceOption[]): WorkspaceOption[] {
    const flattened: WorkspaceOption[] = [];
    const visit = (workspace: WorkspaceOption): void => {
      flattened.push(workspace);
      workspace.children.forEach(visit);
    };
    roots.forEach(visit);
    return flattened;
  }
</script>

<section class="skills-view" aria-labelledby="skills-title">
  <h2 id="skills-title">Skills</h2>
  <p class="intro">Choose a workspace and profile, then save a complete skills selection.</p>

  <form onsubmit={save} aria-describedby="skills-status">
    <div class="field-grid">
      <label for="skills-workspace">Workspace</label>
      <select id="skills-workspace" value={snapshot.workspaceId} onchange={selectWorkspace}>
        <option value="" disabled>Select a workspace</option>
        {#each workspaces as workspace (workspace.id)}
          <option value={workspace.id}>{workspace.relativePath || workspace.name}</option>
        {/each}
      </select>

      <label for="skills-codex-profile">Codex profile</label>
      <select id="skills-codex-profile" value={snapshot.codexProfile} onchange={selectCodexProfile}>
        <option value="" disabled>Select a Codex profile</option>
        {#each codexProfiles as profile (profile.name)}
          <option value={profile.name} disabled={profile.state !== 'ok'}>
            {profile.name}{profile.state === 'ok' ? '' : ` (${profile.status})`}
          </option>
        {/each}
      </select>

      <label for="skills-existing-profile">Existing saved profile</label>
      <select
        id="skills-existing-profile"
        value={snapshot.selectedProfileName}
        onchange={selectSavedProfile}
      >
        <option value="">New profile</option>
        {#each validProfiles as profile (profile.name)}
          <option value={profile.name}>{profile.name}</option>
        {/each}
      </select>

      <label for="skills-save-as">Save as</label>
      <input
        id="skills-save-as"
        name="save-as"
        value={snapshot.saveAsName}
        oninput={(event) => {
          snapshot.saveAsName = (event.currentTarget as HTMLInputElement).value;
          changed();
        }}
        autocomplete="off"
      />
    </div>

    <p class="save-intent" aria-live="polite">
      {snapshot.saveIntent === 'replace' ? 'Replacing the selected saved profile.' : 'Creating a new saved profile.'}
    </p>
    <button type="submit" disabled={snapshot.status.kind === 'saving'}>
      {snapshot.status.kind === 'saving' ? 'Saving profile…' : 'Save profile'}
    </button>
  </form>

  {#if snapshot.status.kind === 'loading'}
    <p id="skills-status" aria-live="polite">Loading skills…</p>
  {:else if snapshot.status.kind === 'empty'}
    <p id="skills-status">No skills were discovered for this workspace and Codex profile.</p>
  {:else if snapshot.status.kind === 'warning'}
    <p id="skills-status" class="notice" role="status">Discovery warning: {snapshot.status.message}</p>
  {:else if snapshot.status.kind === 'invalid-profile' || snapshot.status.kind === 'error'}
    <p id="skills-status" class="error" role="alert">{snapshot.status.message}</p>
  {:else if snapshot.status.kind === 'save-failed'}
    <p id="skills-status" class="error" role="alert" tabindex="-1" bind:this={saveError}>{snapshot.status.message}</p>
  {:else if snapshot.status.kind === 'saved'}
    <p id="skills-status" role="status">Profile saved.</p>
  {/if}

  {#if snapshot.skills.length > 0}
    <p class="summary">{snapshot.enabledCount} of {snapshot.skills.length} skills enabled.</p>
    <ul class="skill-list">
      {#each snapshot.skills as skill (skill.path)}
        <li class="skill-card" style:--brand-color={safeBrandColor(skill.brandColor)}>
          <label class="skill-toggle" for={`skill-${skill.path}`}>
            <input
              id={`skill-${skill.path}`}
              type="checkbox"
              checked={skill.enabled}
              onchange={(event) => {
                snapshot.toggle(skill.path, (event.currentTarget as HTMLInputElement).checked);
                changed();
              }}
            />
            <span>{skill.displayName ?? skill.name}</span>
            <span class="state">{skill.enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
          <details>
            <summary>Skill details</summary>
            {#if skill.description}<p>{skill.description}</p>{/if}
            {#if skill.shortDescription}<p>{skill.shortDescription}</p>{/if}
            <dl>
              <dt>Path</dt><dd class="path">{skill.path}</dd>
              <dt>Scope</dt><dd>{skill.scope ?? 'Not provided'}</dd>
              <dt>Native state</dt><dd>{skill.nativeEnabled ? 'Enabled' : 'Disabled'}</dd>
              {#if skill.interfaceShortDescription}<dt>Display metadata</dt><dd>{skill.interfaceShortDescription}</dd>{/if}
              {#if skill.dependencies?.tools?.length}
                <dt>Tool dependencies</dt>
                <dd><ul>{#each skill.dependencies.tools as tool (`${tool.type}:${tool.value}`)}<li>{tool.type}: {tool.value}{tool.description ? ` — ${tool.description}` : ''}</li>{/each}</ul></dd>
              {/if}
            </dl>
          </details>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .skills-view { min-inline-size: 0; padding: 1rem max(1rem, env(safe-area-inset-right)) calc(5rem + env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left)); }
  .intro, .save-intent, .summary { max-inline-size: 70ch; }
  form, .field-grid { display: grid; gap: .65rem; }
  .field-grid { grid-template-columns: minmax(0, 1fr); }
  label { font-weight: 650; }
  select, input, button { box-sizing: border-box; min-block-size: 3rem; inline-size: 100%; font: inherit; }
  input, select { padding-inline: .7rem; font-size: 1rem; }
  button { padding-inline: 1rem; }
  .notice { border-inline-start: .3rem solid #976600; padding-inline-start: .7rem; }
  .error { border-inline-start: .3rem solid #b42318; padding-inline-start: .7rem; color: #8a1c14; }
  .skill-list { display: grid; gap: .75rem; padding: 0; list-style: none; }
  .skill-card { min-inline-size: 0; border: 1px solid color-mix(in srgb, var(--brand-color, currentColor) 35%, transparent); border-radius: .5rem; padding: .75rem; }
  .skill-toggle { display: flex; flex-wrap: wrap; align-items: center; gap: .65rem; min-block-size: 3rem; }
  .skill-toggle > span { min-inline-size: 0; overflow-wrap: anywhere; }
  .skill-toggle input { flex: 0 0 auto; inline-size: 1.25rem; min-block-size: 1.25rem; }
  .state { margin-inline-start: auto; font-weight: 500; }
  details { overflow-wrap: anywhere; }
  summary { min-block-size: 3rem; align-content: center; cursor: pointer; }
  dl { display: grid; grid-template-columns: minmax(7rem, auto) minmax(0, 1fr); gap: .45rem .75rem; }
  dt { font-weight: 650; }
  dd { min-inline-size: 0; margin: 0; }
  dd ul { margin: 0; padding-inline-start: 1.25rem; }
  .path { overflow-wrap: anywhere; }
  :where(button, input, select, summary):focus-visible { outline: 3px solid #1261a0; outline-offset: 2px; }
  @media (prefers-color-scheme: dark) { .error { color: #ffb4ab; } .notice { color: #ffd8a8; } }
  @media (min-width: 42rem) { .field-grid { grid-template-columns: minmax(10rem, 1fr) minmax(0, 2fr); align-items: center; } }
  @media (max-width: 30rem) { dl { grid-template-columns: 1fr; gap: .2rem; } }
</style>
