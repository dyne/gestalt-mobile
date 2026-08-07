/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import QuizForm from './QuizForm.svelte';

afterEach(cleanup);

const quiz = {
  questions: [
    {
      id: 'mode',
      header: 'Mode',
      question: 'Which mode?',
      choices: [
        { label: 'Fast', description: 'Optimize speed.' },
        { label: 'Careful', description: 'Optimize verification.' },
      ],
      allowCustom: true,
      isSecret: false,
    },
  ],
};

describe('QuizForm', () => {
  it('uses radio choices with visible descriptions and blocks incomplete submission', async () => {
    const onanswer = vi.fn();
    const onsubmit = vi.fn();
    render(QuizForm, { requestId: 'request-1', quiz, answers: {}, onanswer, onsubmit });
    expect(screen.getByText('Optimize speed.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Send answers' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await fireEvent.click(screen.getByRole('radio', { name: /Fast/ }));
    expect(onanswer).toHaveBeenCalledWith('mode', 'Fast');
  });

  it('reveals and focuses custom input', async () => {
    render(QuizForm, {
      requestId: 'request-1',
      quiz,
      answers: {},
      onanswer: () => {},
      onsubmit: () => {},
    });
    await fireEvent.click(screen.getByRole('radio', { name: /Custom answer/ }));
    expect(document.activeElement).toBe(screen.getByLabelText('Your custom answer'));
  });

  it('refocuses the custom input for the question that was selected', async () => {
    const twoQuestionQuiz = {
      questions: [quiz.questions[0]!, { ...quiz.questions[0]!, id: 'style', header: 'Style' }],
    };
    render(QuizForm, {
      requestId: 'request-1',
      quiz: twoQuestionQuiz,
      answers: {},
      onanswer: () => {},
      onsubmit: () => {},
    });
    const customRadios = screen.getAllByRole('radio', { name: /Custom answer/ });
    await fireEvent.click(customRadios[0]!);
    await fireEvent.click(customRadios[1]!);
    await fireEvent.click(customRadios[0]!);
    expect(document.activeElement).toBe(document.getElementById('request-1-mode-custom-text'));
  });
});
