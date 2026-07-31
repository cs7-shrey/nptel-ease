const SELECTOR = 'main[class*="practice-questions"]';
const GAP = 24;
const TEXT_WIDTH = 900;
const TEXT_PADDING = 48;
const BACKGROUND = '#ffffff';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let task;

  if (message?.type === 'COPY_FULL_ASSIGNMENT') {
    task = createFullAssignment(message.tabId);
  } else if (message?.type === 'STACK_QUESTION_IMAGES') {
    task = stackQuestionImages(message.tabId);
  } else {
    return;
  }

  task
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error(error);
      sendResponse({ ok: false, error: error.message || 'Could not copy the questions.' });
    });

  return true;
});

async function createFullAssignment(tabId) {
  if (!tabId) throw new Error('No active tab found.');
  const questions = await collectQuestions(tabId);

  if (!questions.length) {
    throw new Error('No questions were found on this page.');
  }

  const hasImages = questions.some((question) => question.urls.length);
  if (!hasImages) {
    const text = formatQuestionsAsText(questions);
    if (!text) throw new Error('No question text was found on this page.');
    return { format: 'text', text, copied: questions.length, total: questions.length };
  }

  const items = [];
  let loadedImageCount = 0;

  for (const [index, question] of questions.entries()) {
    const bitmaps = await fetchBitmaps(question.urls);
    loadedImageCount += bitmaps.length;

    const options = cleanOptions(question.options);
    if (question.text || options.length || bitmaps.length) {
      items.push({
        text: question.text,
        options,
        bitmaps,
        questionNumber: index + 1,
      });
    }
  }

  if (!loadedImageCount) {
    items.forEach((item) => item.bitmaps.forEach((bitmap) => bitmap.close()));
    throw new Error('The question images could not be loaded.');
  }

  const widestImage = Math.max(0, ...items
    .flatMap((item) => item.bitmaps.map((bitmap) => bitmap.width)));
  const width = Math.max(TEXT_WIDTH, widestImage);
  const measureContext = new OffscreenCanvas(1, 1).getContext('2d');
  const layouts = items.map((item) => layoutQuestion(measureContext, item, width));
  const height = layouts.reduce((sum, layout) => sum + layout.height, 0)
    + GAP * (layouts.length - 1);

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, width, height);

  let y = 0;
  layouts.forEach((layout, index) => {
    drawQuestion(context, layout, y, width);
    y += layout.height;

    if (index < layouts.length - 1) {
      context.fillStyle = '#ececef';
      context.fillRect(0, y, width, GAP);
      y += GAP;
    }
  });

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return {
    format: 'image',
    base64: toBase64(await blob.arrayBuffer()),
    copied: items.length,
    total: questions.length,
    images: loadedImageCount,
    width,
    height,
  };
}

async function stackQuestionImages(tabId) {
  if (!tabId) throw new Error('No active tab found.');

  const [{ result: urls }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector) => {
      const root = document.querySelector(selector);
      if (!root) return [];

      return [...root.querySelectorAll('img')]
        .map((image) => image.currentSrc || image.src || image.dataset.src
          || image.dataset.original)
        .filter(Boolean);
    },
    args: [SELECTOR],
  });

  if (!urls?.length) throw new Error('No question images were found on this page.');
  const bitmaps = await fetchBitmaps(urls);
  if (!bitmaps.length) throw new Error('The question images could not be loaded.');

  const width = Math.max(...bitmaps.map((bitmap) => bitmap.width));
  const height = bitmaps.reduce((sum, bitmap) => sum + bitmap.height, 0)
    + GAP * (bitmaps.length - 1);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, width, height);

  let y = 0;
  bitmaps.forEach((bitmap, index) => {
    const x = Math.round((width - bitmap.width) / 2);
    context.drawImage(bitmap, x, y);
    y += bitmap.height;
    bitmap.close();

    if (index < bitmaps.length - 1) y += GAP;
  });

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return {
    format: 'image',
    base64: toBase64(await blob.arrayBuffer()),
    copied: bitmaps.length,
    total: urls.length,
    width,
    height,
  };
}

async function collectQuestions(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector) => {
      const root = document.querySelector(selector);
      if (!root) return [];

      return [...root.querySelectorAll('section')]
        .filter((section) => {
          const content = section.querySelector('[class*="question-content"]');
          return content && content.closest('section') === section;
        })
        .map((section) => {
          const content = section.querySelector('[class*="question-content"]');
          const text = content?.innerText?.replace(/\s+/g, ' ').trim() || '';
          const options = [...section.querySelectorAll('label')]
            .map((label) => label.innerText.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
          const urls = [...content.querySelectorAll('img')]
            .map((image) => image.currentSrc || image.src || image.dataset.src
              || image.dataset.original)
            .filter(Boolean);

          return { text, options, urls };
        })
        .filter((question) => question.text || question.options.length || question.urls.length);
    },
    args: [SELECTOR],
  });

  return result || [];
}

async function fetchBitmaps(urls) {
  const bitmaps = [];

  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bitmaps.push(await createImageBitmap(await response.blob()));
    } catch (error) {
      console.warn('Skipped image', url, error);
    }
  }

  return bitmaps;
}

function cleanOptions(options) {
  return options.map((option) => option.replace(/^[A-Z][.)]\s*/i, '').trim()).filter(Boolean);
}

function formatQuestionsAsText(questions) {
  return questions.map((question, questionIndex) => {
    const options = cleanOptions(question.options);
    if (!question.text && !options.length) return null;

    const lines = [`${questionIndex + 1}. ${question.text}`.trim()];
    options.forEach((option, optionIndex) => {
      lines.push(`${String.fromCharCode(65 + optionIndex)}. ${option}`);
    });
    return lines.join('\n');
  }).filter(Boolean).join('\n\n');
}

function layoutQuestion(context, item, width) {
  const contentWidth = width - TEXT_PADDING * 2;
  context.font = '600 25px sans-serif';
  const questionLines = wrapText(
    context,
    `${item.questionNumber}. ${item.text}`.trim(),
    contentWidth,
  );

  context.font = '22px sans-serif';
  const optionLines = item.options.flatMap((option, optionIndex) =>
    wrapText(
      context,
      `${String.fromCharCode(65 + optionIndex)}. ${option}`,
      contentWidth - 24,
    ));
  const imagesHeight = item.bitmaps.reduce((sum, bitmap) => sum + bitmap.height, 0)
    + Math.max(0, item.bitmaps.length - 1) * 12;

  return {
    ...item,
    questionLines,
    optionLines,
    height: TEXT_PADDING * 2
      + questionLines.length * 35
      + (item.bitmaps.length ? 18 + imagesHeight : 0)
      + (optionLines.length ? 18 + optionLines.length * 31 : 0),
  };
}

function drawQuestion(context, layout, y, width) {
  context.fillStyle = '#ffffff';
  context.fillRect(0, y, width, layout.height);

  let lineY = y + TEXT_PADDING;
  context.fillStyle = '#17171a';
  context.font = '600 25px sans-serif';
  context.textBaseline = 'top';
  layout.questionLines.forEach((line) => {
    context.fillText(line, TEXT_PADDING, lineY);
    lineY += 35;
  });

  if (layout.bitmaps.length) {
    lineY += 18;
    layout.bitmaps.forEach((bitmap, index) => {
      context.drawImage(bitmap, Math.round((width - bitmap.width) / 2), lineY);
      lineY += bitmap.height;
      if (index < layout.bitmaps.length - 1) lineY += 12;
      bitmap.close();
    });
  }

  if (layout.optionLines.length) lineY += 18;
  context.fillStyle = '#34343a';
  context.font = '22px sans-serif';
  layout.optionLines.forEach((line) => {
    context.fillText(line, TEXT_PADDING + 24, lineY);
    lineY += 31;
  });
}

function wrapText(context, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  words.forEach((word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  });

  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let output = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    output += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
  }

  return btoa(output);
}
