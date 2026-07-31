const SELECTOR = 'main[class*="practice-questions"]';
const GAP = 24;
const TEXT_WIDTH = 900;
const TEXT_PADDING = 48;
const BACKGROUND = '#ffffff';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'COPY_QUESTIONS_AS_IMAGE') return;

  createQuestionSheet(message.tabId)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error(error);
      sendResponse({ ok: false, error: error.message || 'Could not copy the questions.' });
    });

  return true;
});

async function createQuestionSheet(tabId) {
  if (!tabId) throw new Error('No active tab found.');

  const [{ result: questions }] = await chrome.scripting.executeScript({
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
        .filter((question) => question.text || question.urls.length);
    },
    args: [SELECTOR],
  });

  if (!questions?.length) {
    throw new Error('No questions were found on this page.');
  }

  const items = [];
  for (const [index, question] of questions.entries()) {
    const bitmaps = [];

    for (const url of question.urls) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        bitmaps.push(await createImageBitmap(await response.blob()));
      } catch (error) {
        console.warn('Skipped image', url, error);
      }
    }

    if (bitmaps.length) {
      items.push({ type: 'image', bitmaps, questionNumber: index + 1 });
    } else if (question.text) {
      items.push({
        type: 'text',
        text: question.text,
        options: question.options,
        questionNumber: index + 1,
      });
    }
  }

  if (!items.length) {
    throw new Error('The questions could not be prepared.');
  }

  const widestImage = Math.max(0, ...items
    .filter((item) => item.type === 'image')
    .flatMap((item) => item.bitmaps.map((bitmap) => bitmap.width)));
  const width = Math.max(TEXT_WIDTH, widestImage);
  const measureContext = new OffscreenCanvas(1, 1).getContext('2d');
  const layouts = items.map((item) => layoutItem(measureContext, item, width));
  const height = layouts.reduce((sum, layout) => sum + layout.height, 0)
    + GAP * (layouts.length - 1);

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, width, height);

  let y = 0;
  layouts.forEach((layout) => {
    if (layout.type === 'image') {
      layout.bitmaps.forEach((bitmap, bitmapIndex) => {
        const x = Math.round((width - bitmap.width) / 2);
        context.drawImage(bitmap, x, y);
        y += bitmap.height;
        if (bitmapIndex < layout.bitmaps.length - 1) y += 12;
        bitmap.close();
      });
    } else {
      drawTextQuestion(context, layout, y, width);
      y += layout.height;
    }

    if (layout !== layouts.at(-1)) {
      context.fillStyle = '#ececef';
      context.fillRect(0, y, width, GAP);
      y += GAP;
    }
  });

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return {
    base64: toBase64(await blob.arrayBuffer()),
    copied: items.length,
    total: questions.length,
    width,
    height,
  };
}

function layoutItem(context, item, width) {
  if (item.type === 'image') {
    return {
      ...item,
      height: item.bitmaps.reduce((sum, bitmap) => sum + bitmap.height, 0)
        + 12 * (item.bitmaps.length - 1),
    };
  }

  const contentWidth = width - TEXT_PADDING * 2;
  context.font = '600 25px sans-serif';
  const questionLines = wrapText(
    context,
    `${item.questionNumber}. ${item.text}`,
    contentWidth,
  );

  context.font = '22px sans-serif';
  const optionLines = item.options.flatMap((option, optionIndex) => {
    const letter = String.fromCharCode(65 + optionIndex);
    const content = option.replace(/^[A-Z][.)]\s*/i, '');
    return wrapText(context, `${letter}. ${content}`, contentWidth - 24);
  });

  return {
    ...item,
    questionLines,
    optionLines,
    height: TEXT_PADDING * 2 + questionLines.length * 35
      + (optionLines.length ? 18 + optionLines.length * 31 : 0),
  };
}

function drawTextQuestion(context, layout, y, width) {
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
