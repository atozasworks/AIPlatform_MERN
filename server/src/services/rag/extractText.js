import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';
import { AppError } from '../../utils/AppError.js';

/**
 * Extracts plain text from an uploaded buffer so chat attachments can be
 * indexed and grounded. Binary formats without a text layer (images, zip,
 * executables) are rejected with a clear message rather than silently producing
 * empty content.
 */

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

    if (
      mime.startsWith('image/') ||
      ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'svg'].includes(ext)
    ) {
      throw AppError.badRequest(
        'Image files cannot be read as text by ATOZAS AI yet. Attach a PDF, Word (.docx), Excel, or text file instead.',
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
