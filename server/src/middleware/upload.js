import multer from 'multer';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

/**
 * Memory upload for chat/RAG attachments. Files stay in RAM only long enough to
 * extract text; nothing is written to disk.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.rag.maxUploadBytes,
    files: 1,
  },
});

export function uploadSingleDocument(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(
          AppError.badRequest(
            `File exceeds the ${Math.round(env.rag.maxUploadBytes / 1024)} KB upload limit`,
            { code: 'DOCUMENT_TOO_LARGE' },
          ),
        );
      }
      return next(AppError.badRequest(err.message, { code: 'UPLOAD_FAILED' }));
    }
    return next(err);
  });
}

export default uploadSingleDocument;
