/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mount } from 'svelte';

import App from './App.svelte';
import './styles.css';

const target = document.getElementById('app');
if (!target) throw new Error('Missing application mount target');

mount(App, { target });
