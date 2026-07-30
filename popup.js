const copyButton = document.querySelector('#copy-images');
const askChatGPTButton = document.querySelector('#ask-chatgpt');
const fillButton = document.querySelector('#fill-answers');
const clearButton = document.querySelector('#clear-answers');
const answerInput = document.querySelector('#answers');
const answerCount = document.querySelector('#answer-count');
const message = document.querySelector('#message');

answerInput.addEventListener('input', () => {
  const count = parseAnswers(answerInput.value).length;
  answerCount.textContent = `${count}/10`;
  answerCount.style.color = count > 10 ? '#f07178' : '';
});

answerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') fillButton.click();
});

askChatGPTButton.addEventListener('click', async () => {
  const prompt = `I will paste an image containing multiple-choice questions. Answer every question. First, list each answer with its correct option letter and the full option text. Then provide a fenced Markdown code block containing only the option letters (A/B/C/D), in question order, separated by commas. Do not include any other text inside the code block.`;
  const url = new URL('https://chatgpt.com/');
  url.searchParams.set('q', prompt);
  await chrome.tabs.create({ url: url.toString() });
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

  if (answers.length > 10) {
    showMessage('Use no more than ten answers.', true);
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
  return (value.toUpperCase().match(/[A-J]/g) || []);
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
function clearQuestionAnswers() {
  const root = document.querySelector('main[class*="practice-questions"]');
  if (!root) {
    return { ok: false, error: 'Could not find the practice questions on this page.' };
  }

  const selected = [...root.querySelectorAll(
    'input[type="radio"]:checked, input[type="checkbox"]:checked, [role="radio"][aria-checked="true"]',
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

  const groups = [];
  const nativeRadios = [...root.querySelectorAll('input[type="radio"]')]
    .filter((radio) => !radio.disabled);

  if (nativeRadios.length) {
    const byName = new Map();
    nativeRadios.forEach((radio, index) => {
      const container = radio.closest('[role="radiogroup"], fieldset');
      const key = radio.name || container || `unnamed-${index}`;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(radio);
    });
    groups.push(...byName.values());
  } else {
    const roleGroups = [...root.querySelectorAll('[role="radiogroup"]')]
      .map((group) => [...group.querySelectorAll('[role="radio"]')]
        .filter((radio) => radio.getAttribute('aria-disabled') !== 'true'))
      .filter((group) => group.length);
    groups.push(...roleGroups);
  }

  if (!groups.length) {
    return { ok: false, error: 'No answer choices were found. Expand or load the questions first.' };
  }

  let filled = 0;
  const failed = [];

  answers.forEach((answer, questionIndex) => {
    const choiceIndex = answer.charCodeAt(0) - 65;
    const choice = groups[questionIndex]?.[choiceIndex];

    if (!choice) {
      failed.push(questionIndex + 1);
      return;
    }

    choice.scrollIntoView({ block: 'center', behavior: 'auto' });
    choice.click();

    if (choice instanceof HTMLInputElement && !choice.checked) {
      choice.checked = true;
      choice.dispatchEvent(new Event('input', { bubbles: true }));
      choice.dispatchEvent(new Event('change', { bubbles: true }));
    }

    filled += 1;
  });

  return { ok: true, filled, failed, available: groups.length };
}
