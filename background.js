/**
 * Click the toolbar button on the assignment page.
 *
 * Why this works where page code cannot: fetch() here runs in the extension
 * service worker, which host_permissions exempts from CORS. The site's CSP
 * never applies because the request does not originate from the document.
 */

const SELECTOR = 'main[class*="practice-questions"]';
const GAP = 24;
const BG = '#ffffff';
const ALIGN = 'center'; // 'left' | 'center' | 'right'

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  await badge('...', '#666');

  try {
    // 1. Harvest URLs from the page. No fetching here — just reading the DOM.
    const [{ result: urls }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (sel) =>
        [...document.querySelectorAll(sel + ' img')]
          .map((i) => i.currentSrc || i.src || i.dataset.src || i.dataset.original)
          .filter(Boolean),
      args: [SELECTOR],
    });

    if (!urls || !urls.length) {
      console.warn('No <img> found under', SELECTOR);
      return badge('0', '#c00');
    }

    // 2. Privileged fetches — sequential to stay polite to the host.
    const bitmaps = [];
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        bitmaps.push(await createImageBitmap(await res.blob()));
      } catch (e) {
        console.warn('Skipped', url, '-', e.message);
      }
    }
    if (!bitmaps.length) return badge('!', '#c00');

    // 3. Composite in the worker via OffscreenCanvas.
    const width = Math.max(...bitmaps.map((b) => b.width));
    const height = bitmaps.reduce((s, b) => s + b.height, 0) + GAP * (bitmaps.length - 1);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);

    let y = 0;
    for (const b of bitmaps) {
      const x =
        ALIGN === 'left' ? 0 :
          ALIGN === 'right' ? width - b.width :
            Math.round((width - b.width) / 2);
      ctx.drawImage(b, x, y);
      y += b.height + GAP;
      b.close();
    }

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const base64 = toBase64(await blob.arrayBuffer());

    // 4. Hand it to the page — clipboard writes need a document and a click.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: showOverlay,
      args: [base64, bitmaps.length, urls.length, width, height],
    });

    badge(String(bitmaps.length), '#0a0');
  } catch (e) {
    console.error(e);
    badge('!', '#c00');
  }
});

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

async function badge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  if (text !== '...') setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
}

/**
 * Injected into the page. Must be self-contained — it is serialized, so it
 * cannot close over anything above.
 */
function showOverlay(base64, ok, total, width, height) {
  document.getElementById('__img_stacker')?.remove();

  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'image/png' });

  const shell = document.createElement('div');
  shell.id = '__img_stacker';
  Object.assign(shell.style, {
    position: 'fixed', inset: '0', zIndex: '2147483647',
    background: 'rgba(0,0,0,.85)', overflow: 'auto', padding: '20px',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px',
    font: '600 14px/1.4 system-ui, sans-serif',
  });

  const btnStyle = {
    padding: '12px 20px', border: '0', borderRadius: '8px', cursor: 'pointer',
    font: 'inherit', background: '#fff', color: '#111',
  };

  const copy = document.createElement('button');
  copy.textContent = ok === total
    ? `Click to copy ${ok} images (${width}x${height})`
    : `Click to copy ${ok} of ${total} images (${width}x${height})`;
  Object.assign(copy.style, btnStyle, { position: 'sticky', top: '0' });

  const save = document.createElement('button');
  save.textContent = 'Download instead';
  Object.assign(save.style, btnStyle, { background: '#333', color: '#fff' });

  const close = document.createElement('button');
  close.textContent = 'Close';
  Object.assign(close.style, btnStyle, { background: '#333', color: '#fff' });

  const url = URL.createObjectURL(blob);
  const preview = document.createElement('img');
  preview.src = url;
  Object.assign(preview.style, { maxWidth: '100%', background: '#fff' });

  copy.onclick = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      copy.textContent = 'Copied.';
    } catch (e) {
      copy.textContent = 'Clipboard refused: ' + e.message;
    }
  };
  save.onclick = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stacked.png';
    a.click();
  };
  close.onclick = () => {
    URL.revokeObjectURL(url);
    shell.remove();
  };

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px' });
  row.append(save, close);

  shell.append(copy, preview, row);
  document.body.appendChild(shell);
}
