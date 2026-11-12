<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onDestroy } from 'svelte';
  import AppControl from '../../components/AppControl.svelte';
  import type { OrgPlanReference } from '../../../shared/contracts/org-plan-execution.js';
  import type { createRelayClient } from '../sessions/relay-client.js';

  type Props = {
    reference?: OrgPlanReference;
    transport?: Pick<ReturnType<typeof createRelayClient>, 'downloadOrgPlan'>;
    onerror?: (message: string) => void;
  };
  let { reference, transport, onerror }: Props = $props();
  let downloading = $state(false);
  let request: AbortController | undefined;
  onDestroy(() => request?.abort());

  async function download(): Promise<void> {
    if (downloading || !reference || !transport) return;
    const controller = new AbortController();
    request = controller;
    downloading = true;
    try {
      const result = await transport.downloadOrgPlan(reference, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      try {
        link.href = url;
        link.download = result.filename;
        document.body.append(link);
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch {
      if (!controller.signal.aborted) onerror?.('Could not download the Org file. Try again.');
    } finally {
      downloading = false;
      request = undefined;
    }
  }
</script>

<AppControl
  label="Download Org file"
  disabled={downloading || !reference || !transport}
  onclick={download}
>
  {downloading ? 'Downloading…' : 'Download'}
</AppControl>
