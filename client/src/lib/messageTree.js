/** Parent key for sibling grouping (null/undefined → root). */
export function parentKey(parentMessage) {
  return parentMessage ? String(parentMessage) : 'root';
}

/** User-message siblings that share the same parent (edit versions). */
export function getUserSiblings(allMessages, message) {
  const key = parentKey(message.parentMessage);
  return allMessages
    .filter((m) => m.role === 'user' && parentKey(m.parentMessage) === key)
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

/**
 * Linearize the active branch for display.
 * `branchChoices` maps parentKey → selected user message id.
 * Defaults to the latest sibling at each fork.
 */
export function buildDisplayPath(allMessages, branchChoices = {}) {
  const path = [];
  let parentId = null;

  while (true) {
    const key = parentKey(parentId);
    const siblings = allMessages
      .filter((m) => m.role === 'user' && parentKey(m.parentMessage) === key)
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

    if (!siblings.length) break;

    const preferred = branchChoices[key];
    const user =
      (preferred && siblings.find((s) => String(s.id) === String(preferred))) ||
      siblings[siblings.length - 1];

    const versionIndex = siblings.findIndex((s) => String(s.id) === String(user.id));
    path.push({
      ...user,
      versions: siblings,
      versionIndex: versionIndex < 0 ? siblings.length - 1 : versionIndex,
      versionCount: siblings.length,
    });

    const assistants = allMessages
      .filter((m) => m.role === 'assistant' && String(m.parentMessage) === String(user.id))
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

    if (!assistants.length) break;
    path.push(assistants[assistants.length - 1]);
    parentId = assistants[assistants.length - 1].id;
  }

  return path;
}
