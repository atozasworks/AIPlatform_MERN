/**
 * Chat attachment helpers.
 *
 * The chat model is text-only, so an attached file's extracted text (or OCR
 * text for an image) is appended to the message `content` as
 * `--- Attached file: <name> ---` blocks. That text is for the model only: the
 * UI hides it and shows the attachment itself (an image thumbnail or a file
 * chip) from `message.attachments`.
 */

/** Prompt sent when the user attaches files without typing anything. */
export const DEFAULT_ATTACHMENT_PROMPT = 'Please use the attached document(s) to answer.';

const BLOCK_MARKER = '--- Attached file: ';
const BLOCK_TITLE_RE = /^--- Attached file: (.+?) ---$/gm;
const IMAGE_NAME_RE = /\.(png|jpe?g|webp|bmp|gif|svg)$/i;

export function isImageName(name = '') {
  return IMAGE_NAME_RE.test(String(name));
}

/** Builds the `--- Attached file ---` block appended to the model-facing content. */
export function attachmentBlock(title, body) {
  return `${BLOCK_MARKER}${title} ---\n${body}`;
}

/**
 * Splits stored message content into the text the user typed and the hidden
 * attachment blocks.
 *
 * @returns {{ text: string, blocks: string, files: string[] }}
 *   `text`   — what to show in the bubble
 *   `blocks` — the raw hidden tail (kept so an edit can re-send it)
 *   `files`  — attachment names parsed from the blocks (for older messages
 *              saved before `attachments` metadata existed)
 */
export function splitMessageContent(content = '') {
  const value = String(content || '');
  let idx = -1;
  if (value.startsWith(BLOCK_MARKER)) idx = 0;
  else {
    const at = value.indexOf(`\n\n${BLOCK_MARKER}`);
    if (at >= 0) idx = at;
  }
  if (idx < 0) return { text: value, blocks: '', files: [] };

  const blocks = value.slice(idx).replace(/^\n\n/, '');
  const files = [...blocks.matchAll(BLOCK_TITLE_RE)].map((m) => m[1]);
  return { text: value.slice(0, idx).trimEnd(), blocks, files };
}

/**
 * Resolves what a user bubble should show: the visible prompt (empty when it
 * was only the auto-filled default) and the attachment list.
 */
export function getMessageDisplay(message) {
  const { text, blocks, files } = splitMessageContent(message?.content);
  const stored = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachments = stored.length
    ? stored
    : files.map((name) => ({ name, kind: isImageName(name) ? 'image' : 'file' }));
  const hasAttachments = attachments.length > 0 || Boolean(blocks);
  const visibleText = hasAttachments && text.trim() === DEFAULT_ATTACHMENT_PROMPT ? '' : text;
  return { text: visibleText, blocks, attachments };
}

/** Max encoded size of one stored thumbnail (data URL chars). */
export const MAX_THUMBNAIL_CHARS = 280_000;

/**
 * Downscales an image file to a JPEG data URL small enough to store with the
 * message, so the preview survives a reload. Returns null when the browser
 * cannot decode the image (the attachment then shows as a file chip).
 */
export async function createImageThumbnail(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const attempts = [
      [1024, 0.82],
      [768, 0.75],
      [512, 0.7],
      [320, 0.65],
    ];
    for (const [maxSide, quality] of attempts) {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const width = Math.max(1, Math.round((img.naturalWidth || maxSide) * scale));
      const height = Math.max(1, Math.round((img.naturalHeight || maxSide) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      // JPEG has no alpha: paint white behind transparent PNG/SVG pixels.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (dataUrl.startsWith('data:image/jpeg') && dataUrl.length <= MAX_THUMBNAIL_CHARS) {
        return dataUrl;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image could not be decoded'));
    img.src = src;
  });
}
