import mongoose from 'mongoose';

// Import every model so it is registered on mongoose before the admin panel
// enumerates collections. Controllers only import the models they use, so
// without this an unused model would be invisible to the data browser.
import '../../models/User.js';
import '../../models/Conversation.js';
import '../../models/Message.js';
import '../../models/Document.js';
import '../../models/DocumentChunk.js';
import '../../models/EmailOtp.js';
import '../../models/OidcFlow.js';
import '../../models/PublicMessage.js';
import '../../models/PublicRoom.js';
import '../../models/UsageEvent.js';

import { AppError } from '../../utils/AppError.js';

/**
 * Read-only browser over every registered Mongoose model, powering the admin
 * panel's "see all data" view. Deliberately generic: any model registered on
 * the shared mongoose connection shows up automatically.
 *
 * Credential material is redacted before it leaves the process (see
 * SENSITIVE_KEY and redact()), so an admin can inspect records without the
 * response ever carrying password hashes, OTP hashes or SSO secrets.
 */

// Field names whose values must never be returned, matched case-insensitively
// as a substring of the key. Covers passwordHash, otpHash, codeHash, tokens,
// PKCE verifiers, client secrets, etc.
const SENSITIVE_KEY = /pass|secret|token|otphash|codehash|verifier|hash|apikey|api_key/i;

const REDACTED = '[redacted]';
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/**
 * True only for plain objects ({} literals / lean sub-documents). ObjectId,
 * Date and Buffer are class instances we must NOT recurse into — doing so
 * shreds an ObjectId into its internal byte buffer and breaks its hex-string
 * JSON serialization.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Recursively replaces the values of sensitive-looking keys with a marker. */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(val);
    }
    return out;
  }
  // ObjectId, Date, Buffer and primitives pass through so they serialize
  // correctly (e.g. ObjectId -> hex string).
  return value;
}

/** Returns the registered model by its name, or throws a 404. */
function resolveModel(name) {
  const model = mongoose.models[name];
  if (!model) {
    throw AppError.notFound(`Unknown collection: ${name}`);
  }
  return model;
}

/**
 * Lists every registered model with its collection name and a live document
 * count. Counts run in parallel; a failing count (e.g. a dropped collection)
 * degrades to null rather than failing the whole call.
 */
export async function listCollections() {
  const names = Object.keys(mongoose.models).sort();
  const collections = await Promise.all(
    names.map(async (name) => {
      const model = mongoose.models[name];
      let count = null;
      try {
        count = await model.estimatedDocumentCount();
      } catch {
        count = null;
      }
      return {
        model: name,
        collection: model.collection?.name || null,
        count,
        fields: Object.keys(model.schema?.paths || {}),
      };
    }),
  );
  return collections;
}

/**
 * Paginated documents for one model. Supports:
 *   - page / limit (limit capped at MAX_LIMIT)
 *   - sort (any field; default newest-first by createdAt then _id)
 *   - search: a case-insensitive regex applied across the model's String paths
 */
export async function getDocuments(name, { page = 1, limit = DEFAULT_LIMIT, search = '', sort } = {}) {
  const model = resolveModel(name);

  const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const safePage = Math.max(Number(page) || 1, 1);
  const skip = (safePage - 1) * safeLimit;

  const filter = buildSearchFilter(model, search);

  let sortSpec = { createdAt: -1, _id: -1 };
  if (sort) {
    const desc = sort.startsWith('-');
    sortSpec = { [desc ? sort.slice(1) : sort]: desc ? -1 : 1 };
  }

  const [rawDocs, total] = await Promise.all([
    model.find(filter).sort(sortSpec).skip(skip).limit(safeLimit).lean().exec(),
    model.countDocuments(filter),
  ]);

  return {
    model: name,
    collection: model.collection?.name || null,
    page: safePage,
    limit: safeLimit,
    total,
    totalPages: Math.ceil(total / safeLimit) || 1,
    documents: rawDocs.map(redact),
  };
}

/** A single document by id, redacted. */
export async function getDocument(name, id) {
  const model = resolveModel(name);
  if (!mongoose.isValidObjectId(id)) {
    throw AppError.badRequest('Invalid document id');
  }
  const doc = await model.findById(id).lean().exec();
  if (!doc) throw AppError.notFound('Document not found');
  return redact(doc);
}

/**
 * Builds a case-insensitive OR-regex filter across the model's String paths.
 * Returns an empty filter when there is no search term, so the caller lists
 * everything.
 */
function buildSearchFilter(model, search) {
  const term = String(search || '').trim();
  if (!term) return {};

  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(escaped, 'i');

  const stringPaths = Object.entries(model.schema.paths)
    .filter(([key, path]) => path.instance === 'String' && !SENSITIVE_KEY.test(key))
    .map(([key]) => key);

  if (!stringPaths.length) return {};
  return { $or: stringPaths.map((key) => ({ [key]: rx })) };
}

/** High-level counts for the dashboard overview card. */
export async function getOverview() {
  const collections = await listCollections();
  const totalDocuments = collections.reduce((sum, c) => sum + (c.count || 0), 0);
  return { collections, totalCollections: collections.length, totalDocuments };
}

export default { listCollections, getDocuments, getDocument, getOverview };
