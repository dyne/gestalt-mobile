/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mountClient } from './bootstrap.js';
import { registerInstallabilityWorker } from './features/installability/register-service-worker.js';
import './styles.css';

const target = document.getElementById('app');
if (!target) throw new Error('Missing application mount target');

mountClient(target, window.location, window.history);
registerInstallabilityWorker();
