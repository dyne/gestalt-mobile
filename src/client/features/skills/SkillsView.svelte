<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { tick } from 'svelte';

  import type { SkillsState } from './skills-state.js';

  type Props = {
    skillsState: SkillsState;
    onrefresh: () => Promise<void>;
    onprofileschange: () => void;
    heading?: string;
  };

  let { skillsState, onrefresh, onprofileschange, heading = 'Manage skill profiles' }: Props = $props();
  let revision = $state(0);
  let saveError = $state<HTMLElement | null>(null);
  let savedProfileSelect = $state<HTMLSelectElement | null>(null);
  let deleteTrigger = $state<HTMLButtonElement | null>(null);
  let deleteDialog = $state<HTMLDialogElement | null>(null);
  let profileChoice = $state('__new__');
  let snapshot = $derived.by(() => {
    revision;
    return skillsState;
  });
  let validProfiles = $derived(snapshot.profiles.filter((profile) => !('error' in profile)));

  function changed(): void {
    skillsState = Object.assign(Object.create(Object.getPrototypeOf(skillsState)), skillsState);
    revision += 1;
  }

  async function refreshSkills(): Promise<void> {
    await onrefresh();
    changed();
  }

  function selectSavedProfile(event: Event): void {
    profileChoice = (event.currentTarget as HTMLSelectElement).value;
    if (profileChoice === '__new__' || profileChoice === '__default__') snapshot.selectDefaultProfile();
    else snapshot.selectProfile(profileChoice);
    changed();
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await snapshot.save();
    changed();
    if (snapshot.status.kind === 'saved') {
      profileChoice = snapshot.selectedProfileName;
      onprofileschange();
    }
    if (snapshot.status.kind === 'save-failed') {
      await tick();
      saveError?.focus();
    }
  }

  function requestDelete(): void {
    deleteDialog?.showModal();
  }

  async function deleteProfile(): Promise<void> {
    deleteDialog?.close();
    await snapshot.deleteSelectedProfile();
    changed();
    if (snapshot.status.kind === 'deleted') {
      profileChoice = '__new__';
      onprofileschange();
    }
    await tick();
    savedProfileSelect?.focus();
  }

  async function cancelDelete(): Promise<void> {
    deleteDialog?.close();
    await tick();
    deleteTrigger?.focus();
  }

  function safeBrandColor(color: string | undefined): string | undefined {
    return color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined;
  }

  function displaySkillPath(path: string): string {
    return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~');
  }
</script>

<section class="skills-view" aria-labelledby="skills-title">
  <h2 id="skills-title">{heading}</h2>
  <p class="intro">Create or edit a complete skills selection.</p>

  <form onsubmit={save} aria-describedby="skills-status">
    <div class="field-grid">
      <label for="skills-existing-profile">Skill profile</label>
      <select
        id="skills-existing-profile"
        bind:this={savedProfileSelect}
        bind:value={profileChoice}
        onchange={selectSavedProfile}
      >
        <option value="__new__">New profile</option>
        <option value="__default__">Default</option>
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
    <div class="profile-actions">
      <button
        type="button"
        bind:this={deleteTrigger}
        disabled={!snapshot.selectedProfileName || snapshot.status.kind === 'deleting'}
        onclick={requestDelete}
      >Delete profile</button>
      <button type="submit" disabled={snapshot.status.kind === 'saving'}>
        {snapshot.status.kind === 'saving' ? 'Saving profile…' : 'Save profile'}
      </button>
    </div>
  </form>

  <dialog bind:this={deleteDialog} aria-labelledby="delete-profile-title">
    <h3 id="delete-profile-title">Delete skill profile?</h3>
    <p>Delete {snapshot.selectedProfileName}? Existing sessions keep their saved skill set.</p>
    <div class="dialog-actions">
      <button type="button" onclick={() => void cancelDelete()}>Cancel</button>
      <button type="button" onclick={() => void deleteProfile()}>Delete profile</button>
    </div>
  </dialog>

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
  {:else if snapshot.status.kind === 'deleted'}
    <p id="skills-status" role="status">Profile deleted.</p>
  {:else if snapshot.status.kind === 'delete-failed'}
    <p id="skills-status" class="error" role="alert">{snapshot.status.message}</p>
  {/if}

  {#if snapshot.skills.length > 0}
    <div class="skills-toolbar">
      <button type="button" class="refresh-skills" onclick={() => void refreshSkills()} aria-label="Refresh skills">
        <span aria-hidden="true">↻</span><span>Refresh</span>
      </button>
      <p class="summary">{snapshot.enabledCount} of {snapshot.skills.length} skills enabled.</p>
    </div>
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
          <div class="skill-details">
            {#if skill.description}<p>{skill.description}</p>{/if}
            {#if skill.shortDescription}<p>{skill.shortDescription}</p>{/if}
            <dl>
              <dt>Path</dt><dd class="path">{displaySkillPath(skill.path)}</dd>
              {#if skill.dependencies?.tools?.length}
                <dt>Tool dependencies</dt>
                <dd><ul>{#each skill.dependencies.tools as tool (`${tool.type}:${tool.value}`)}<li>{tool.type}: {tool.value}{tool.description ? ` — ${tool.description}` : ''}</li>{/each}</ul></dd>
              {/if}
            </dl>
          </div>
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
  dialog { max-inline-size: min(100% - 2rem, 32rem); }
  .dialog-actions { display: grid; gap: .65rem; }
  input, select { padding-inline: .7rem; font-size: 1rem; }
  button { padding-inline: 1rem; }
  .profile-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .65rem; }
  .skills-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .65rem; margin-block: 1rem; }
  .refresh-skills { flex: 0 0 auto; inline-size: auto; min-block-size: 2.25rem; padding-inline: .65rem; }
  .refresh-skills span:first-child { font-size: 1.2em; line-height: 1; }
  .summary { min-inline-size: 0; margin: 0; overflow-wrap: anywhere; }
  .notice { border-inline-start: .3rem solid #976600; padding-inline-start: .7rem; }
  .error { border-inline-start: .3rem solid #b42318; padding-inline-start: .7rem; color: #8a1c14; }
  .skill-list { display: grid; gap: .75rem; padding: 0; list-style: none; }
  .skill-card { min-inline-size: 0; border: 1px solid color-mix(in srgb, var(--brand-color, currentColor) 35%, transparent); border-radius: .5rem; padding: .75rem; }
  .skill-toggle { display: flex; flex-wrap: wrap; align-items: center; gap: .65rem; min-block-size: 3rem; }
  .skill-toggle > span { min-inline-size: 0; overflow-wrap: anywhere; }
  .skill-toggle input { flex: 0 0 auto; inline-size: 1.25rem; min-block-size: 1.25rem; }
  .state { margin-inline-start: auto; font-weight: 500; }
  .skill-details { overflow-wrap: anywhere; padding-inline-start: 1.9rem; }
  .skill-details > :first-child { margin-block-start: .25rem; }
  .skill-details > :last-child { margin-block-end: 0; }
  dl { display: grid; grid-template-columns: minmax(7rem, auto) minmax(0, 1fr); gap: .45rem .75rem; }
  dt { font-weight: 650; }
  dd { min-inline-size: 0; margin: 0; }
  dd ul { margin: 0; padding-inline-start: 1.25rem; }
  .path { overflow-wrap: anywhere; }
  :where(button, input, select):focus-visible { outline: 3px solid #1261a0; outline-offset: 2px; }
  @media (prefers-color-scheme: dark) { .error { color: #ffb4ab; } .notice { color: #ffd8a8; } }
  @media (min-width: 42rem) { .field-grid { grid-template-columns: minmax(10rem, 1fr) minmax(0, 2fr); align-items: center; } }
  @media (max-width: 30rem) { dl { grid-template-columns: 1fr; gap: .2rem; } }
</style>
