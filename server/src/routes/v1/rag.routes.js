import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { ingestLimiter } from '../../middleware/rateLimit.js';
import { uploadSingleDocument } from '../../middleware/upload.js';
import {
  createDocumentSchema,
  documentIdSchema,
  listDocumentsSchema,
  searchSchema,
} from '../../validators/rag.validator.js';
import * as ragController from '../../controllers/rag.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/documents', validate(listDocumentsSchema), ragController.list);
router.post('/documents', ingestLimiter, validate(createDocumentSchema), ragController.create);
// Multipart upload: PDF / DOCX / Excel / text → extract → same ingest path.
router.post(
  '/documents/upload',
  ingestLimiter,
  uploadSingleDocument,
  ragController.upload,
);
router.delete('/documents/:id', validate(documentIdSchema), ragController.remove);

// Retrieval preview: shows exactly what the model would be given.
router.post('/search', validate(searchSchema), ragController.search);

export default router;
