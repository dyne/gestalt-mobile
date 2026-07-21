<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
  import FilesystemTree from './FilesystemTree.svelte';
  import { treeNodePolicies } from './tree-state.js';

  let { context }: { context: 'sessions' | 'git' } = $props();

  const repository = (id: string, name: string): WorkspaceOption => ({
    id,
    name,
    relativePath: id,
    isGitRepository: true,
    children: [],
  });

  const roots: WorkspaceOption[] = [
    {
      id: '.',
      name: 'development-workspace-with-a-long-name',
      relativePath: '.',
      isGitRepository: false,
      children: [
        {
          id: 'dyne',
          name: 'dyne',
          relativePath: 'dyne',
          isGitRepository: false,
          children: [
            {
              id: 'dyne/mobile-applications',
              name: 'mobile-applications-and-experiments',
              relativePath: 'dyne/mobile-applications',
              isGitRepository: false,
              children: [
                repository(
                  'dyne/mobile-applications/gestalt-mobile',
                  'gestalt-mobile-with-an-extraordinarily-long-repository-name',
                ),
              ],
            },
            repository('dyne/zenroom', 'zenroom'),
            repository('dyne/zenflows', 'zenflows'),
            repository('dyne/did', 'did-toolkit'),
            repository('dyne/api', 'api-gateway'),
            repository('dyne/docs', 'documentation-portal'),
          ],
        },
        {
          id: 'personal',
          name: 'personal-projects',
          relativePath: 'personal',
          isGitRepository: false,
          children: [],
        },
      ],
    },
  ];

  let expandedIds = $state(new Set(['.', 'dyne', 'dyne/mobile-applications']));
  let selectedId = $state<string | null>(null);
  let defaultSelectedId = $derived(
    context === 'sessions' ? 'dyne/mobile-applications' : 'dyne/mobile-applications/gestalt-mobile',
  );
  let currentSelectedId = $derived(selectedId ?? defaultSelectedId);
</script>

<section class="evidence-shell" aria-labelledby="evidence-title">
  <p class="eyebrow">{context === 'sessions' ? 'Sessions' : 'Git'}</p>
  <h1 id="evidence-title">
    {context === 'sessions' ? 'Session base' : 'Git repository'}
  </h1>
  <p class="instructions">
    {context === 'sessions'
      ? 'Select the folder Codex should use as its working directory.'
      : 'Select a repository for Git actions.'}
  </p>
  <div class="tree-panel">
    <FilesystemTree
      {roots}
      {expandedIds}
      selectedId={currentSelectedId}
      label={context === 'sessions' ? 'Session base' : 'Git repository'}
      isSelectable={context === 'sessions'
        ? treeNodePolicies.sessionBase
        : treeNodePolicies.gitRepositoryTarget}
      onexpandedchange={(value) => (expandedIds = value)}
      onselect={(node) => (selectedId = node.id)}
    />
  </div>
</section>

<style>
  .evidence-shell {
    box-sizing: border-box;
    inline-size: min(100%, 48rem);
    min-inline-size: 0;
    margin-inline: auto;
    padding: 1rem;
  }

  .eyebrow {
    margin: 0;
    font-size: 0.8rem;
    font-weight: 750;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1 {
    margin-block: 0.25rem 0.5rem;
    font-size: clamp(1.35rem, 6vw, 2rem);
    line-height: 1.15;
  }

  .instructions {
    max-inline-size: 42rem;
    margin-block: 0 1rem;
  }

  .tree-panel {
    min-inline-size: 0;
    padding: 0.5rem;
    border: 1px solid color-mix(in srgb, CanvasText 35%, transparent);
    border-radius: 0.6rem;
  }

  @media (max-width: 24rem) {
    .evidence-shell {
      padding: 0.5rem;
    }

    .tree-panel {
      padding: 0.25rem;
    }
  }
</style>
