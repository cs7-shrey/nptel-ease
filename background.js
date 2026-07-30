const SELECTOR = 'main[class*="practice-questions"]';
const GAP = 24;
const BACKGROUND = '#ffffff';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'STACK_QUESTION_IMAGES') return;

  stackQuestionImages(message.tabId)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error(error);
      sendResponse({ ok: false, error: error.message || 'Could not copy the images.' });
    });

  return true;
});

async function stackQuestionImages(tabId) {
  if (!tabId) throw new Error('No active tab found.');

  const [{ result: urls }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector) => {
      const root = document.querySelector(selector);
      if (!root) return [];

      return [...root.querySelectorAll('img')]
        .map((image) => image.currentSrc || image.src || image.dataset.src || image.dataset.original)
        .filter(Boolean);
    },
    args: [SELECTOR],
  });

  if (!urls?.length) {
    throw new Error('No question images were found on this page.');
  }

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

  if (!bitmaps.length) {
    throw new Error('The question images could not be loaded.');
  }

  const width = Math.max(...bitmaps.map((bitmap) => bitmap.width));
  const height = bitmaps.reduce((sum, bitmap) => sum + bitmap.height, 0)
    + GAP * (bitmaps.length - 1);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');

  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, width, height);

  let y = 0;
  for (const bitmap of bitmaps) {
    const x = Math.round((width - bitmap.width) / 2);
    context.drawImage(bitmap, x, y);
    y += bitmap.height + GAP;
    bitmap.close();
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return {
    base64: toBase64(await blob.arrayBuffer()),
    copied: bitmaps.length,
    total: urls.length,
    width,
    height,
  };
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
