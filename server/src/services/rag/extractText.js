import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';
import { AppError } from '../../utils/AppError.js';
import { recognizeImage } from './ocr.js';

/**
 * Extracts plain text from an uploaded buffer so chat attachments can be
 * indexed and grounded. Images are read with OCR (see `ocr.js`); other binary
 * formats without a text layer (zip, executables) are rejected with a clear
 * message rather than silently producing empty content.
 */

// Raster formats tesseract.js can decode in Node (see its image-format docs).
// gif/tif/tiff/heic are NOT decodable by the engine, so they are rejected with a
// clear "convert to PNG/JPG" message below rather than a cryptic decode error.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp']);
const UNSUPPORTED_IMAGE_EXTENSIONS = new Set(['gif', 'tif', 'tiff', 'heic']);

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'html',
  'htm',
  'log',
  'xml',
  'yaml',
  'yml',
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'java',
  'c',
  'cpp',
  'h',
  'css',
  'sql',
  'rtf',
  'ini',
  'conf',
  'cfg',
  'env',
  'sh',
  'bat',
  'ps1',
  'go',
  'rs',
  'php',
  'rb',
  'swift',
  'kt',
  'scala',
  'r',
  'tex',
]);

export function extensionOf(filename = '') {
  const base = String(filename).split(/[/\\]/).pop() || '';
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i + 1).toLowerCase() : '';
}

function looksLikeText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (!sample.length) return false;
  let weird = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 14 && byte < 32)) weird += 1;
  }
  return weird / sample.length < 0.3;
}

async function extractPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return String(result?.text || '').trim();
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return String(result?.value || '').trim();
}

function extractSpreadsheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const parts = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet);
    if (csv?.trim()) parts.push(`--- Sheet: ${name} ---\n${csv.trim()}`);
  }
  return parts.join('\n\n').trim();
}

/**
 * @param {object} params
 * @param {Buffer} params.buffer
 * @param {string} params.filename
 * @param {string} [params.mimeType]
 * @returns {Promise<{ text: string, kind: string }>}
 */
export async function extractTextFromUpload({ buffer, filename, mimeType = '' }) {
  if (!buffer?.length) {
    throw AppError.badRequest('Uploaded file is empty');
  }

  const ext = extensionOf(filename);
  const mime = String(mimeType || '').toLowerCase();

  try {
    if (ext === 'pdf' || mime === 'application/pdf') {
      const text = await extractPdf(buffer);
      if (!text) {
        throw AppError.badRequest(
          'Could not extract text from this PDF (it may be scanned/image-only).',
          { code: 'NO_EXTRACTABLE_TEXT' },
        );
      }
      return { text, kind: 'pdf' };
    }

    if (
      ext === 'docx' ||
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      const text = await extractDocx(buffer);
      if (!text) {
        throw AppError.badRequest('Could not extract text from this Word document.', {
          code: 'NO_EXTRACTABLE_TEXT',
        });
      }
      return { text, kind: 'docx' };
    }

    if (ext === 'doc') {
      throw AppError.badRequest(
        'Legacy .doc Word files are not supported. Please save as .docx or PDF and try again.',
        { code: 'UNSUPPORTED_FILE_TYPE' },
      );
    }

    if (
      ['xlsx', 'xls', 'xlsm', 'ods'].includes(ext) ||
      mime.includes('spreadsheet') ||
      mime.includes('excel')
    ) {
      const text = extractSpreadsheet(buffer);
      if (!text) {
        throw AppError.badRequest('Could not extract text from this spreadsheet.', {
          code: 'NO_EXTRACTABLE_TEXT',
        });
      }
      return { text, kind: 'spreadsheet' };
    }

    if (ext === 'svg' || mime === 'image/svg+xml') {
      // SVG is XML, not a raster: pull its <text> content directly instead of
      // running OCR (which cannot decode SVG).
      const raw = buffer.toString('utf8');
      const texts = [...raw.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi)]
        .map((m) => m[1].replace(/<[^>]+>/g, ''))
        .join(' ')
        .trim();
      if (!texts) {
        throw AppError.badRequest(
          'No readable text was found in this SVG image.',
          { code: 'NO_EXTRACTABLE_TEXT' },
        );
      }
      return { text: texts, kind: 'image' };
    }

    if (UNSUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
      throw AppError.badRequest(
        `This image format (.${ext}) cannot be read. Please save it as PNG or JPG and attach it again.`,
        { code: 'UNSUPPORTED_FILE_TYPE' },
      );
    }

    // Raster images: run OCR. The MIME check is limited to the formats the
    // engine can actually decode; anything else (heic, gif, …) is rejected above
    // with a "convert to PNG/JPG" message.
    if (
      ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'].includes(mime) ||
      IMAGE_EXTENSIONS.has(ext)
    ) {
      const text = await recognizeImage({ buffer });
      if (!text) {
        throw AppError.badRequest(
          'No readable text was found in this image. Make sure it contains clear, legible text and try again.',
          { code: 'NO_EXTRACTABLE_TEXT' },
        );
      }
      return { text, kind: 'image' };
    }

    // An image MIME type with an unrecognised extension: treat as an image the
    // engine may not decode, with a clear message instead of a decode crash.
    if (mime.startsWith('image/')) {
      throw AppError.badRequest(
        'This image format cannot be read. Please save it as PNG or JPG and attach it again.',
        { code: 'UNSUPPORTED_FILE_TYPE' },
      );
    }

    if (TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/') || mime === 'application/json') {
      const text = buffer.toString('utf8').trim();
      if (!text) throw AppError.badRequest('File is empty');
      return { text, kind: 'text' };
    }

    // Unknown extension: accept only if the bytes look like plain text.
    if (looksLikeText(buffer)) {
      const text = buffer.toString('utf8').trim();
      if (!text) throw AppError.badRequest('File is empty');
      return { text, kind: 'text' };
    }

    throw AppError.badRequest(
      `Unsupported file type${ext ? ` (.${ext})` : ''}. Supported: PDF, Word (.docx), Excel (.xlsx/.xls), and common text/code files.`,
      { code: 'UNSUPPORTED_FILE_TYPE' },
    );
  } catch (err) {
    if (err?.statusCode) throw err;
    throw AppError.badRequest(err?.message || 'Could not read this file', {
      code: 'FILE_EXTRACT_FAILED',
    });
  }
}

export default extractTextFromUpload;
