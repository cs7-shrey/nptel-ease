const SELECTOR = 'main[class*="practice-questions"]';
const GAP = 24;
const TEXT_WIDTH = 900;
const TEXT_PADDING = 48;
const RENDER_SCALE = 2;
const BACKGROUND = '#ffffff';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let task;

  if (message?.type === 'COPY_FULL_ASSIGNMENT') {
    task = createFullAssignment(message.tabId);
  } else if (message?.type === 'STACK_QUESTION_IMAGES') {
    task = stackQuestionImages(message.tabId);
  } else if (message?.type === 'FETCH_LECTURE_TRANSCRIPTS') {
    task = fetchLectureTranscripts(message.videos);
  } else if (message?.type === 'OPEN_CHATGPT_WITH_PROMPT') {
    task = openChatGPTWithPrompt(message.prompt, message.imageDataUrl);
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

async function openChatGPTWithPrompt(prompt, imageDataUrl) {
  const text = typeof prompt === 'string' ? prompt : '';
  const image = typeof imageDataUrl === 'string' ? imageDataUrl : '';
  const chatTab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false });
  let handoff = { inserted: false, imageAttached: false, error: '' };

  try {
    await waitForTabComplete(chatTab.id, 30000);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: chatTab.id },
      world: 'MAIN',
      func: async (content, pngDataUrl) => {
        const findEditor = () => document.querySelector([
          '#prompt-textarea[contenteditable="true"]',
          '[data-lexical-editor="true"][contenteditable="true"]',
          '.ProseMirror[contenteditable="true"]',
          'main [contenteditable="true"]',
        ].join(','));

        let element = null;
        for (let attempt = 0; attempt < 200 && !element; attempt += 1) {
          element = findEditor();
          if (!element) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!(element instanceof HTMLElement) || !element.isContentEditable) {
          return {
            inserted: false,
            imageAttached: false,
            error: 'ChatGPT prompt editor was not found.',
          };
        }

        let imageAttached = false;
        let imageMethod = null;
        let imageError = '';
        if (pngDataUrl?.startsWith('data:image/png;base64,')) {
          try {
            const encoded = pngDataUrl.slice(pngDataUrl.indexOf(',') + 1);
            const binary = atob(encoded);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
              bytes[index] = binary.charCodeAt(index);
            }
            const file = new File([bytes], 'nptel-questions.png', { type: 'image/png' });

            element.focus();
            const pasteData = new DataTransfer();
            pasteData.items.add(file);
            const pasteHandled = !element.dispatchEvent(new ClipboardEvent('paste', {
              bubbles: true,
              cancelable: true,
              composed: true,
              clipboardData: pasteData,
            }));

            if (pasteHandled) {
              imageAttached = true;
              imageMethod = 'paste-event';
              await new Promise((resolve) => setTimeout(resolve, 1200));
            } else {
              let fileInput = [...document.querySelectorAll('input[type="file"]')]
                .find((input) => !input.accept || input.accept.includes('image'));
              if (!fileInput) {
                const attachButton = document.querySelector([
                  'button[aria-label*="attach" i]',
                  'button[aria-label*="upload" i]',
                  '[data-testid*="attach" i]',
                  '[data-testid="composer-plus-btn"]',
                ].join(','));
                attachButton?.click();

                for (let attempt = 0; attempt < 30 && !fileInput; attempt += 1) {
                  await new Promise((resolve) => setTimeout(resolve, 100));
                  fileInput = [...document.querySelectorAll('input[type="file"]')]
                    .find((input) => !input.accept || input.accept.includes('image'));
                }
              }

              if (fileInput instanceof HTMLInputElement) {
                const files = new DataTransfer();
                files.items.add(file);
                fileInput.files = files.files;
                fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                imageAttached = true;
                imageMethod = 'file-input';
                await new Promise((resolve) => setTimeout(resolve, 1200));
              } else {
                imageError = 'ChatGPT file input was not found.';
              }
            }
          } catch (error) {
            imageError = error.message || String(error);
          }
        }

        element.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);

        const before = element.textContent || '';
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', content);
        const notCancelled = element.dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clipboardData,
        }));

        if (notCancelled || (element.textContent || '') === before) {
          const currentSelection = window.getSelection();
          if (!currentSelection.rangeCount) {
            return {
              inserted: false,
              imageAttached,
              imageMethod,
              error: 'No active ChatGPT caret range.',
              imageError,
            };
          }

          const activeRange = currentSelection.getRangeAt(0);
          activeRange.deleteContents();
          const textNode = document.createTextNode(content);
          activeRange.insertNode(textNode);
          activeRange.setStartAfter(textNode);
          activeRange.collapse(true);
          currentSelection.removeAllRanges();
          currentSelection.addRange(activeRange);
          element.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            composed: true,
            inputType: 'insertFromPaste',
            data: content,
          }));
        }

        return {
          inserted: (element.textContent || '').includes(content.slice(0, 80)),
          imageAttached,
          imageMethod,
          imageError,
          error: '',
        };
      },
      args: [text, image],
    });
    handoff = result || handoff;
    console.info('[NPTEL Ease] ChatGPT handoff', {
      ...handoff,
      promptChars: text.length,
      hasImage: Boolean(image),
    });
  } catch (error) {
    handoff.error = error.message || String(error);
    console.error('[NPTEL Ease] ChatGPT insertion failed; opening the tab normally', error);
  } finally {
    await chrome.tabs.update(chatTab.id, { active: true }).catch(() => {});
  }

  return handoff;
}

async function fetchLectureTranscripts(videos) {
  const validVideos = (Array.isArray(videos) ? videos : [])
    .filter((video) => /^[A-Za-z0-9_-]{11}$/.test(video.videoId))
    .slice(0, 50);
  if (!validVideos.length) throw new Error('No valid YouTube videos were provided.');

  console.info('[NPTEL Ease] Starting transcript fetch', validVideos);
  const youtubeTab = await chrome.tabs.create({
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(validVideos[0].videoId)}&hl=en&autoplay=0`,
    active: false,
  });

  try {
    await waitForTabComplete(youtubeTab.id);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: youtubeTab.id },
      world: 'MAIN',
      func: async (requestedVideos) => {
        try {
          for (let attempt = 0; attempt < 50 && !window.ytcfg?.get; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }

          const apiKey = window.ytcfg?.get?.('INNERTUBE_API_KEY');
          if (!apiKey) throw new Error('YouTube page configuration was unavailable.');
          const clientVersion = '20.10.38';

          const fetchOne = async (video) => {
            try {
              const playerUrl = new URL('/youtubei/v1/player', location.origin);
              playerUrl.searchParams.set('key', apiKey);
              playerUrl.searchParams.set('prettyPrint', 'false');
              const playerResponse = await fetch(playerUrl, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                  'content-type': 'application/json',
                  'x-youtube-client-name': '3',
                  'x-youtube-client-version': clientVersion,
                },
                body: JSON.stringify({
                  context: {
                    client: {
                      clientName: 'ANDROID',
                      clientVersion,
                      androidSdkVersion: 30,
                      osName: 'Android',
                      osVersion: '11',
                      hl: 'en',
                      gl: 'US',
                    },
                  },
                  videoId: video.videoId,
                  contentCheckOk: true,
                  racyCheckOk: true,
                }),
              });

              if (!playerResponse.ok) {
                const preview = (await playerResponse.text()).replace(/\s+/g, ' ').slice(0, 160);
                throw new Error(`player HTTP ${playerResponse.status}: ${preview}`);
              }

              const player = await playerResponse.json();
              const tracks = player.captions
                ?.playerCaptionsTracklistRenderer
                ?.captionTracks || [];
              const isEnglish = (track) => {
                const language = track.languageCode?.toLowerCase();
                return language === 'en' || language?.startsWith('en-');
              };
              const track = tracks.find((candidate) =>
                isEnglish(candidate) && candidate.kind !== 'asr')
                || tracks.find((candidate) =>
                  isEnglish(candidate) && candidate.kind === 'asr');

              if (!track?.baseUrl) {
                return { status: 'skipped', video, reason: 'No English caption track' };
              }

              const captionUrl = new URL(track.baseUrl);
              captionUrl.searchParams.set('fmt', 'json3');
              const captionResponse = await fetch(captionUrl, { credentials: 'same-origin' });
              if (!captionResponse.ok) {
                throw new Error(`captions HTTP ${captionResponse.status}`);
              }

              const body = await captionResponse.text();
              if (!body.trim()) throw new Error('Empty caption response');
              const captions = JSON.parse(body);
              const lines = [];
              (captions.events || []).forEach((event) => {
                if (!Array.isArray(event.segs)) return;
                const line = event.segs
                  .map((segment) => segment.utf8 || '')
                  .join('')
                  .replace(/\s+/g, ' ')
                  .trim();
                if (line && lines.at(-1) !== line) lines.push(line);
              });

              if (!lines.length) {
                return { status: 'skipped', video, reason: 'Caption track contained no text' };
              }

              return {
                status: 'success',
                title: video.title || `Lecture ${video.videoId}`,
                videoId: video.videoId,
                captionType: track.kind === 'asr' ? 'auto-generated' : 'uploaded',
                text: lines.join('\n'),
              };
            } catch (error) {
              return {
                status: 'failed',
                video,
                reason: error.message || String(error),
              };
            }
          };

          return { results: await Promise.all(requestedVideos.map(fetchOne)) };
        } catch (error) {
          return { error: error.message || String(error) };
        }
      },
      args: [validVideos],
    });

    if (result?.error) throw new Error(result.error);
    const diagnostics = result?.results || [];
    console.table(diagnostics.map((entry) => ({
      title: entry.title || entry.video?.title,
      videoId: entry.videoId || entry.video?.videoId,
      status: entry.status,
      captionType: entry.captionType || '',
      reason: entry.reason || '',
    })));

    const transcripts = diagnostics.filter((entry) => entry.status === 'success');
    const skipped = diagnostics
      .filter((entry) => entry.status !== 'success')
      .map((entry) => entry.video?.title || entry.video?.videoId);
    if (!transcripts.length) {
      const details = diagnostics
        .slice(0, 3)
        .map((entry) => `${entry.video?.title || 'Lecture'}: ${entry.reason}`)
        .join(' · ');
      throw new Error(`No English captions could be fetched. ${details}`);
    }

    const text = transcripts.map((transcript) => [
      transcript.title,
      '',
      transcript.text,
    ].join('\n')).join('\n\n---\n\n');

    return {
      text,
      copied: transcripts.length,
      total: validVideos.length,
      skipped,
    };
  } finally {
    await chrome.tabs.remove(youtubeTab.id).catch(() => {});
  }
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? reject(error) : resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    const timeout = setTimeout(
      () => finish(new Error('Timed out while loading YouTube.')),
      timeoutMs,
    );

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId)
      .then((tab) => { if (tab.status === 'complete') finish(); })
      .catch((error) => finish(error));
  });
}

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
  const logicalWidth = Math.max(TEXT_WIDTH, widestImage);
  const measureContext = new OffscreenCanvas(1, 1).getContext('2d');
  const layouts = items.map((item) => layoutQuestion(measureContext, item, logicalWidth));
  const logicalHeight = layouts.reduce((sum, layout) => sum + layout.height, 0)
    + GAP * (layouts.length - 1);
  const width = logicalWidth * RENDER_SCALE;
  const height = logicalHeight * RENDER_SCALE;

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.scale(RENDER_SCALE, RENDER_SCALE);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, logicalWidth, logicalHeight);

  let y = 0;
  layouts.forEach((layout, index) => {
    drawQuestion(context, layout, y, logicalWidth);
    y += layout.height;

    if (index < layouts.length - 1) {
      context.fillStyle = '#ececef';
      context.fillRect(0, y, logicalWidth, GAP);
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

  const logicalWidth = Math.max(...bitmaps.map((bitmap) => bitmap.width));
  const logicalHeight = bitmaps.reduce((sum, bitmap) => sum + bitmap.height, 0)
    + GAP * (bitmaps.length - 1);
  const width = logicalWidth * RENDER_SCALE;
  const height = logicalHeight * RENDER_SCALE;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.scale(RENDER_SCALE, RENDER_SCALE);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, logicalWidth, logicalHeight);

  let y = 0;
  bitmaps.forEach((bitmap, index) => {
    const x = Math.round((logicalWidth - bitmap.width) / 2);
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
