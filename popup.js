const copyFullButton = document.querySelector('#copy-full');
const copyImagesButton = document.querySelector('#copy-images');
const chatGPTActions = document.querySelector('#chatgpt-actions');
const includeTranscriptsToggle = document.querySelector('#include-transcripts');
const askChatGPTButton = document.querySelector('#ask-chatgpt');
const fillButton = document.querySelector('#fill-answers');
const clearButton = document.querySelector('#clear-answers');
const answerInput = document.querySelector('#answers');
const answerCount = document.querySelector('#answer-count');
const message = document.querySelector('#message');
const INCLUDE_TRANSCRIPTS_KEY = 'includeLectureTranscripts';
let copiedQuestions = null;

includeTranscriptsToggle.checked = localStorage.getItem(INCLUDE_TRANSCRIPTS_KEY) === 'true';
includeTranscriptsToggle.addEventListener('change', () => {
  localStorage.setItem(INCLUDE_TRANSCRIPTS_KEY, String(includeTranscriptsToggle.checked));
});

answerInput.addEventListener('input', () => {
  const answers = parseAnswers(answerInput.value);
  answerCount.textContent = String(answers.length);
  answerCount.style.color = answers.some((answer) => !/^[A-J]+$/.test(answer)) ? '#f07178' : '';
});

answerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') fillButton.click();
});

askChatGPTButton.addEventListener('click', async () => {
  const includeTranscripts = includeTranscriptsToggle.checked;
  const requestedOrigins = ['https://chatgpt.com/*'];
  if (includeTranscripts) requestedOrigins.push('https://www.youtube.com/*');

  setBusy(
    askChatGPTButton,
    true,
    includeTranscripts ? 'Fetching transcripts…' : 'Opening ChatGPT…',
  );
  clearMessage();

  try {
    const granted = await chrome.permissions.request({ origins: requestedOrigins });
    if (!granted) {
      await chrome.tabs.create({ url: 'https://chatgpt.com/' });
      return;
    }

    let transcripts = '';
    if (includeTranscripts) {
      try {
        const result = await fetchCurrentWeekTranscripts();
        transcripts = result.text;
      } catch (error) {
        console.warn('[NPTEL Ease] Continuing without lecture transcripts', error);
      }
    }

    const questionText = copiedQuestions?.type === 'text' ? copiedQuestions.text : '';
    const imageDataUrl = copiedQuestions?.type === 'image' ? copiedQuestions.dataUrl : '';
    const prompt = buildChatGPTPrompt(transcripts, questionText);
    const result = await chrome.runtime.sendMessage({
      type: 'OPEN_CHATGPT_WITH_PROMPT',
      prompt,
      imageDataUrl,
    });
    if (!result?.ok) throw new Error(result?.error || 'Could not open ChatGPT.');
  } catch (error) {
    console.error('[NPTEL Ease] ChatGPT handoff failed', error);
    showMessage(error.message || 'Could not open ChatGPT.', true);
  } finally {
    setBusy(askChatGPTButton, false);
  }
});

copyFullButton.addEventListener('click', async () => {
  setBusy(copyFullButton, true, 'Preparing…');
  copiedQuestions = null;
  chatGPTActions.hidden = true;
  clearMessage();

  try {
    const tab = await getActiveNptelTab();
    const result = await chrome.runtime.sendMessage({
      type: 'COPY_FULL_ASSIGNMENT',
      tabId: tab.id,
    });

    if (!result?.ok) throw new Error(result?.error || 'Could not prepare the questions.');

    if (result.format === 'text') {
      copiedQuestions = { type: 'text', text: result.text };
      await navigator.clipboard.writeText(result.text);
      showMessage(
        `${result.copied} text question${result.copied === 1 ? '' : 's'} copied · paste into ChatGPT`,
      );
    } else {
      copiedQuestions = {
        type: 'image',
        dataUrl: `data:image/png;base64,${result.base64}`,
      };
      await copyPngResult(result);
      const skipped = result.total - result.copied;
      showMessage(
        `${result.copied} question${result.copied === 1 ? '' : 's'} copied as ${result.width}×${result.height}px`
        + (skipped ? ` · ${skipped} skipped` : '')
        + ' · paste into ChatGPT',
      );
    }

    chatGPTActions.hidden = false;
  } catch (error) {
    showMessage(error.message || 'Clipboard access was refused.', true);
  } finally {
    setBusy(copyFullButton, false);
  }
});

copyImagesButton.addEventListener('click', async () => {
  setBusy(copyImagesButton, true, 'Stacking…');
  copiedQuestions = null;
  chatGPTActions.hidden = true;
  clearMessage();

  try {
    const tab = await getActiveNptelTab();
    const result = await chrome.runtime.sendMessage({
      type: 'STACK_QUESTION_IMAGES',
      tabId: tab.id,
    });

    if (!result?.ok) throw new Error(result?.error || 'Could not prepare the images.');

    copiedQuestions = {
      type: 'image',
      dataUrl: `data:image/png;base64,${result.base64}`,
    };
    await copyPngResult(result);
    const skipped = result.total - result.copied;
    showMessage(
      `${result.copied} image${result.copied === 1 ? '' : 's'} copied as ${result.width}×${result.height}px`
      + (skipped ? ` · ${skipped} skipped` : '')
      + ' · paste into ChatGPT',
    );
    chatGPTActions.hidden = false;
  } catch (error) {
    showMessage(error.message || 'Clipboard access was refused.', true);
  } finally {
    setBusy(copyImagesButton, false);
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

function buildChatGPTPrompt(transcripts = '', questionText = '') {
  const sections = [
    `Answer every multiple-choice question provided below or in the attached image.

Use the lecture transcripts when they are available, together with your own subject knowledge and reasoning. Do not rely exclusively on the transcripts.

For each question:
1. Identify the correct option or options.
2. Output the option letters and the full option text.
3. Briefly explain the reasoning when useful.

After answering all questions, provide a fenced Markdown code block containing only the answer tokens in question order, separated by commas.

For single-choice questions, use a token such as A. For multiple-choice questions, combine the letters without spaces, such as ACD.

Do not include any other text inside the final code block.`,
  ];

  if (transcripts) {
    sections.push(`<lecture_transcripts>\n${transcripts}\n</lecture_transcripts>`);
  }
  if (questionText) {
    sections.push(`<question_content>\n${questionText}\n</question_content>`);
  }
  return sections.join('\n\n');
}

async function fetchCurrentWeekTranscripts() {
  const tab = await getActiveNptelTab();
  const pageUrl = new URL(tab.url);
  const courseId = pageUrl.pathname.match(/\/course\/(noc[^/?]+)/i)?.[1];
  const unitId = Number(pageUrl.searchParams.get('unitId'));
  if (!courseId || !unitId) {
    throw new Error('Open an NPTEL assignment page with a course and unit ID first.');
  }

  const videos = await discoverWeekVideos(tab.id, courseId, unitId);
  console.info('[NPTEL Ease] Discovered weekly videos', videos);
  const result = await chrome.runtime.sendMessage({
    type: 'FETCH_LECTURE_TRANSCRIPTS',
    videos,
  });
  if (!result?.ok) throw new Error(result?.error || 'Could not retrieve the transcripts.');
  return result;
}

async function discoverWeekVideos(tabId, courseId, unitId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (selectedCourseId, selectedUnitId) => {
      try {
        const fetchJson = async (url) => {
          const response = await fetch(url, { credentials: 'include' });
          if (!response.ok) throw new Error(`NPTEL returned HTTP ${response.status}.`);
          let data = await response.json();

          for (let depth = 0; depth < 5; depth += 1) {
            if (typeof data === 'string') {
              data = JSON.parse(data);
            } else if (
              data
              && typeof data === 'object'
              && Object.hasOwn(data, 'payload')
              && data.payload != null
            ) {
              data = data.payload;
            } else {
              break;
            }
          }

          if (data?.content === 'not visible') {
            throw new Error('Authenticated NPTEL content is not visible.');
          }
          if (data?.status === false && data.message) throw new Error(data.message);
          return data;
        };

        const outlineUrl = new URL('/e-learning/api/courseoutline', location.origin);
        outlineUrl.searchParams.set('course_id', selectedCourseId);
        const responseData = await fetchJson(outlineUrl);
        const findOutline = (value, depth = 0) => {
          if (!value || depth > 5) return null;
          if (typeof value === 'string') {
            try {
              return findOutline(JSON.parse(value), depth + 1);
            } catch {
              return null;
            }
          }
          if (typeof value !== 'object') return null;
          if (value.lessons && value.order) return value;
          for (const child of Object.values(value)) {
            const match = findOutline(child, depth + 1);
            if (match) return match;
          }
          return null;
        };
        const outline = findOutline(responseData);
        if (!outline) throw new Error('Course outline fields were not found.');

        const lessons = Object.values(outline.lessons || {});
        const unitOrder = Array.isArray(outline.order)
          ? outline.order.find((entry) => Number(entry.id) === selectedUnitId)
          : null;
        let lessonIds = (unitOrder?.children || [])
          .filter((child) => child.section === 'lesson')
          .map((child) => Number(child.id))
          .filter((lessonId) => lessons.some((lesson) =>
            Number(lesson.lesson_id) === lessonId
            && Number(lesson.unit_id) === selectedUnitId));

        if (!lessonIds.length) {
          lessonIds = lessons
            .filter((lesson) => Number(lesson.unit_id) === selectedUnitId)
            .map((lesson) => Number(lesson.lesson_id));
        }
        lessonIds = [...new Set(lessonIds)];
        if (!lessonIds.length) throw new Error(`No lessons found for unit ${selectedUnitId}.`);

        const lessonResults = await Promise.allSettled(lessonIds.map(async (lessonId) => {
          const lessonUrl = new URL('/e-learning/api/lesson', location.origin);
          lessonUrl.searchParams.set('course_id', selectedCourseId);
          lessonUrl.searchParams.set('unit_id', String(selectedUnitId));
          lessonUrl.searchParams.set('lesson_id', String(lessonId));
          const payload = await fetchJson(lessonUrl);
          const lesson = payload.lesson;
          const videoId = lesson?.video?.trim();
          return lesson && videoId
            ? { title: lesson.title || `Lesson ${lessonId}`, videoId }
            : null;
        }));

        return {
          videos: lessonResults
            .filter((lesson) => lesson.status === 'fulfilled' && lesson.value)
            .map((lesson) => lesson.value),
        };
      } catch (error) {
        return { error: error.message || String(error) };
      }
    },
    args: [courseId, unitId],
  });

  if (result?.error) throw new Error(result.error);
  if (!result?.videos?.length) throw new Error('No video lectures were found for this week.');
  return result.videos;
}

async function copyPngResult(result) {
  const bytes = Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'image/png' });
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
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
