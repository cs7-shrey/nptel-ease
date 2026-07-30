const copyButton = document.querySelector('#copy-images');
const copyTextButton = document.querySelector('#copy-text');
const askChatGPTButton = document.querySelector('#ask-chatgpt');
const fillButton = document.querySelector('#fill-answers');
const clearButton = document.querySelector('#clear-answers');
const answerInput = document.querySelector('#answers');
const answerCount = document.querySelector('#answer-count');
const message = document.querySelector('#message');

answerInput.addEventListener('input', () => {
  const answers = parseAnswers(answerInput.value);
  answerCount.textContent = String(answers.length);
  answerCount.style.color = answers.some((answer) => !/^[A-J]+$/.test(answer)) ? '#f07178' : '';
});

answerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') fillButton.click();
});

askChatGPTButton.addEventListener('click', async () => {
  const prompt = `I will paste content containing multiple-choice questions. Answer every question. First, list each answer with its correct option letter and the full option text. Then provide a fenced Markdown code block containing only the option letters (A/B/C/D), in question order, separated by commas. Do not include any other text inside the code block.`;
  const url = new URL('https://chatgpt.com/');
  url.searchParams.set('q', prompt);
  await chrome.tabs.create({ url: url.toString() });
});

copyTextButton.addEventListener('click', async () => {
  setBusy(copyTextButton, true, 'Copying…');
  askChatGPTButton.hidden = true;
  clearMessage();

  try {
    const tab = await getActiveNptelTab();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectTextQuestions,
    });

    if (!result?.ok) throw new Error(result?.error || 'Could not read the questions.');

    await navigator.clipboard.writeText(result.text);
    showMessage(
      `${result.count} text question${result.count === 1 ? '' : 's'} copied · paste into ChatGPT`,
    );
    askChatGPTButton.hidden = false;
  } catch (error) {
    showMessage(error.message || 'Could not copy the question text.', true);
  } finally {
    setBusy(copyTextButton, false);
  }
});

copyButton.addEventListener('click', async () => {
  setBusy(copyButton, true, 'Stacking images…');
  askChatGPTButton.hidden = true;
  clearMessage();

  try {
    const tab = await getActiveNptelTab();
    const result = await chrome.runtime.sendMessage({
      type: 'STACK_QUESTION_IMAGES',
      tabId: tab.id,
    });

    if (!result?.ok) throw new Error(result?.error || 'Could not prepare the image.');

    const bytes = Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);

    const skipped = result.total - result.copied;
    showMessage(
      `${result.copied} image${result.copied === 1 ? '' : 's'} copied as ${result.width}×${result.height}px`
      + (skipped ? ` · ${skipped} skipped` : '')
      + ' · paste it into ChatGPT',
    );
    askChatGPTButton.hidden = false;
  } catch (error) {
    showMessage(error.message || 'Clipboard access was refused.', true);
  } finally {
    setBusy(copyButton, false);
  }
});

clearButton.addEventListener('click', async () => {
  clearMessage();
  setBusy(clearButton, true, 'Clearing…');

  try {
    const tab = await getActiveNptelTab();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: clearQuestionAnswers,
    });

    if (!result?.ok) throw new Error(result?.error || 'Answers could not be cleared.');

    answerInput.value = '';
    answerInput.dispatchEvent(new Event('input'));
    showMessage(result.cleared
      ? `${result.cleared} selected answer${result.cleared === 1 ? '' : 's'} cleared`
      : 'No selected answers to clear');
  } catch (error) {
    showMessage(error.message || 'Could not access this page.', true);
  } finally {
    setBusy(clearButton, false);
  }
});

fillButton.addEventListener('click', async () => {
  clearMessage();
  const answers = parseAnswers(answerInput.value);

  if (!answers.length) {
    showMessage('Enter at least one answer, such as A, C, B.', true);
    answerInput.focus();
    return;
  }

  if (answers.some((answer) => !/^[A-J]+$/.test(answer))) {
    showMessage('Use choices A–J, with commas between questions. Example: A, ACD, B.', true);
    answerInput.focus();
    return;
  }

  setBusy(fillButton, true, 'Filling…');

  try {
    const tab = await getActiveNptelTab();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillQuestionAnswers,
      args: [answers],
    });

    if (!result?.ok) throw new Error(result?.error || 'Answers could not be filled.');

    const failedText = result.failed.length
      ? ` · check question${result.failed.length === 1 ? '' : 's'} ${result.failed.join(', ')}`
      : '';
    showMessage(`${result.filled} of ${answers.length} answers filled${failedText}`,
      result.filled !== answers.length);
  } catch (error) {
    showMessage(error.message || 'Could not access this page.', true);
  } finally {
    setBusy(fillButton, false);
  }
});

function parseAnswers(value) {
  return value
    .toUpperCase()
    .replace(/[\[\]{}()]/g, '')
    .split(/[\s,]+/)
    .map((answer) => answer.trim())
    .filter(Boolean);
}

async function getActiveNptelTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  if (!tab.url?.startsWith('https://onlinecourses.nptel.ac.in/')) {
    throw new Error('Open an NPTEL course page first.');
  }
  return tab;
}

function setBusy(button, busy, label) {
  if (busy) {
    button.dataset.label = button.querySelector('span').textContent;
    button.querySelector('span').textContent = label;
  } else if (button.dataset.label) {
    button.querySelector('span').textContent = button.dataset.label;
  }
  button.disabled = busy;
}

function showMessage(text, isError = false) {
  message.textContent = text;
  message.className = `message visible${isError ? ' error' : ''}`;
}

function clearMessage() {
  message.textContent = '';
  message.className = 'message';
}

/** This function is serialized and run in the active page. */
function collectTextQuestions() {
  const root = document.querySelector('main[class*="practice-questions"]');
  if (!root) {
    return { ok: false, error: 'Could not find the practice questions on this page.' };
  }

  const sections = [...root.querySelectorAll('section')].filter((section) => {
    const question = section.querySelector('[class*="question-content"]');
    return question && question.closest('section') === section;
  });

  const questions = sections.map((section) => {
    const question = section.querySelector('[class*="question-content"]')?.innerText
      .replace(/\s+/g, ' ')
      .trim();
    const options = [...section.querySelectorAll('label')]
      .map((label) => label.innerText.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    return question && options.length ? { question, options } : null;
  }).filter(Boolean).map(({ question, options }, questionIndex) => {
    const optionLines = options.map((option, optionIndex) => {
      const letter = String.fromCharCode(65 + optionIndex);
      const content = option.replace(/^[A-Z][.)]\s*/i, '');
      return `${letter}. ${content}`;
    });

    return `${questionIndex + 1}. ${question}\n${optionLines.join('\n')}`;
  });

  if (!questions.length) {
    return { ok: false, error: 'No text questions with labeled options were found.' };
  }

  return {
    ok: true,
    count: questions.length,
    text: questions.join('\n\n'),
  };
}

/** This function is serialized and run in the active page. */
function clearQuestionAnswers() {
  const root = document.querySelector('main[class*="practice-questions"]');
  if (!root) {
    return { ok: false, error: 'Could not find the practice questions on this page.' };
  }

  const selected = [...root.querySelectorAll(
    'input[type="radio"]:checked, input[type="checkbox"]:checked, [role="radio"][aria-checked="true"], [role="checkbox"][aria-checked="true"]',
  )];

  // Prefer the site's own clear controls so its application state stays in sync.
  const clearControls = [...root.querySelectorAll('button, [role="button"]')]
    .filter((control) => /^(clear|clear response|clear answer|reset)$/i.test(control.textContent.trim()));
  clearControls.forEach((control) => control.click());

  selected.forEach((choice) => {
    if (choice instanceof HTMLInputElement && choice.checked) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
      descriptor?.set?.call(choice, false);
      choice.dispatchEvent(new Event('input', { bubbles: true }));
      choice.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (choice.getAttribute('aria-checked') === 'true') {
      choice.setAttribute('aria-checked', 'false');
      choice.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  return { ok: true, cleared: selected.length };
}

/** This function is serialized and run in the active page. */
function fillQuestionAnswers(answers) {
  const root = document.querySelector('main[class*="practice-questions"]');
  if (!root) {
    return { ok: false, error: 'Could not find the practice questions on this page.' };
  }

  const nativeChoices = [...root.querySelectorAll(
    'input[type="radio"], input[type="checkbox"]',
  )].filter((choice) => !choice.disabled);
  const choices = nativeChoices.length
    ? nativeChoices
    : [...root.querySelectorAll('[role="radio"], [role="checkbox"]')]
      .filter((choice) => choice.getAttribute('aria-disabled') !== 'true');

  // A section represents one question. Choices are ordered as they appear,
  // making A the first input, B the second, and so on.
  const byQuestion = new Map();
  choices.forEach((choice, index) => {
    const section = choice.closest('section');
    const namedGroup = choice instanceof HTMLInputElement ? choice.name : null;
    const key = section || namedGroup || `unnamed-${index}`;
    if (!byQuestion.has(key)) byQuestion.set(key, []);
    byQuestion.get(key).push(choice);
  });
  const groups = [...byQuestion.values()];

  if (!groups.length) {
    return { ok: false, error: 'No answer choices were found. Expand or load the questions first.' };
  }

  let filled = 0;
  const failed = [];

  answers.forEach((answer, questionIndex) => {
    const group = groups[questionIndex];
    const selectedIndexes = new Set(
      [...answer].map((letter) => letter.charCodeAt(0) - 65),
    );
    const hasMultipleChoiceInputs = group?.some((choice) =>
      (choice instanceof HTMLInputElement && choice.type === 'checkbox')
      || choice.getAttribute('role') === 'checkbox');

    if (
      !group
      || [...selectedIndexes].some((choiceIndex) => !group[choiceIndex])
      || (selectedIndexes.size > 1 && !hasMultipleChoiceInputs)
    ) {
      failed.push(questionIndex + 1);
      return;
    }

    group[0].scrollIntoView({ block: 'center', behavior: 'auto' });

    group.forEach((choice, choiceIndex) => {
      const shouldSelect = selectedIndexes.has(choiceIndex);
      const isCheckbox = (choice instanceof HTMLInputElement && choice.type === 'checkbox')
        || choice.getAttribute('role') === 'checkbox';

      if (choice instanceof HTMLInputElement) {
        if (isCheckbox && choice.checked !== shouldSelect) choice.click();
        if (!isCheckbox && shouldSelect && !choice.checked) choice.click();

        if (choice.checked !== shouldSelect && isCheckbox) {
          const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
          descriptor?.set?.call(choice, shouldSelect);
          choice.dispatchEvent(new Event('input', { bubbles: true }));
          choice.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else {
        const isSelected = choice.getAttribute('aria-checked') === 'true';
        if ((isCheckbox && isSelected !== shouldSelect) || (!isCheckbox && shouldSelect && !isSelected)) {
          choice.click();
        }
      }
    });

    filled += 1;
  });

  return { ok: true, filled, failed, available: groups.length };
}
