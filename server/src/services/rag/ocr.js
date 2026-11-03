import { createRequire } from 'node:module';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { logger } from '../../config/logger.js';

/**
 * OCR for image attachments.
 *
 * The chat model is text-only, so an uploaded image cannot be "seen" directly.
 * Instead we run optical character recognition over the image and return the
 * recognised text, which the caller feeds into the same grounding path as a
 * document. `tesseract.js` is pure WebAssembly (no native build step), so it
 * runs on the CPU-only VPS without a system Tesseract install.
 *
 * The Tesseract instance is created lazily and reused across requests: the
 * WASM engine and traineddata are loaded once, which makes the first call slow
 * (it downloads language data from the CDN) and subsequent calls fast.
 */

const require = createRequire(import.meta.url);

/** @type {Promise<object>|null} */
let workerPromise = null;

/**
 * Creates (or reuses) the shared Tesseract worker.
 *
 * @returns {Promise<object>} A Tesseract worker with `recognize` and `terminate`.
 */
async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      // Imported lazily so a missing optional dependency only fails when OCR is
      // actually used, not at module load.
      const Tesseract = require('tesseract.js');
      const worker = await Tesseract.createWorker(env.ocr.language, 1, {
        logger: (m) => {
          if (m.status === 'loading tesseract core' || m.status === 'initializing tesseract') {
            logger.debug({ status: m.status }, 'OCR worker progress');
          }
        },
      });
      return worker;
    })().catch((err) => {
      // Reset so the next request retries instead of caching a rejected promise.
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/**
 * Runs OCR over an image buffer.
 *
 * @param {object} params
 * @param {Buffer} params.buffer Raw image bytes (PNG/JPEG/WebP/BMP/TIFF/GIF).
 * @returns {Promise<string>} Recognised text, trimmed. May be empty when the
 *   image contains no machine-readable text.
 */
export async function recognizeImage({ buffer }) {
  if (!env.ocr.enabled) {
    throw AppError.badRequest(
      'Image reading (OCR) is disabled on this deployment. Attach a PDF, Word, Excel, or text file instead.',
      { code: 'OCR_DISABLED' },
    );
  }

  if (!buffer?.length) {
    throw AppError.badRequest('Uploaded image is empty', { code: 'FILE_REQUIRED' });
  }

  const worker = await getWorker().catch((err) => {
    logger.error({ err }, 'Failed to initialise OCR worker');
    throw AppError.badRequest(
      'Image reading is unavailable right now. Please try again shortly.',
      { code: 'OCR_UNAVAILABLE' },
    );
  });

  const timeoutMs = env.ocr.timeoutMs;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('OCR timed out')), timeoutMs);
  });

  try {
    const { data } = await Promise.race([worker.recognize(buffer), timeout]);
    return String(data?.text || '').trim();
  } catch (err) {
    if (err?.message === 'OCR timed out') {
      logger.warn({ timeoutMs }, 'OCR timed out');
      throw AppError.badRequest(
        'This image took too long to read. Try a smaller or clearer image.',
        { code: 'OCR_TIMEOUT' },
      );
    }
    logger.error({ err }, 'OCR recognition failed');
    throw AppError.badRequest('Could not read text from this image.', { code: 'OCR_FAILED' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Terminates the shared worker. Called on graceful shutdown so the WASM engine
 * and its language data are released.
 */
export async function disposeOcr() {
  if (workerPromise) {
    const worker = await workerPromise.catch(() => null);
    workerPromise = null;
    await worker?.terminate?.().catch(() => {});
  }
}

export default recognizeImage;
