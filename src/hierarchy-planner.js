const NAME_PATTERN = /^[A-Za-z0-9_]+$/;
const CUSTOM_ATTRIBUTE_KEY_PATTERN = /^[A-Za-z0-9_]+$/;
const RESERVED_FIELD_NAMES = new Set([
  'id',
  'name',
  'parent',
  'parent_id',
  'project',
  'project_id',
  'custom_attributes',
]);

export const HIERARCHY_ENTITY_TYPES = new Set(['AssetBuild', 'Shot', 'Task']);

export function validateHierarchyName(name, label = 'name') {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid ${label}: must match ${NAME_PATTERN}`);
  }
  return name;
}

export function validateCustomAttributeKeys(keys = []) {
  const unique = [];
  for (const key of keys) {
    if (!CUSTOM_ATTRIBUTE_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid custom attribute key "${key}": must match ${CUSTOM_ATTRIBUTE_KEY_PATTERN}`);
    }
    if (!unique.includes(key)) unique.push(key);
  }
  return unique;
}

export function buildClearCustomAttributesData(keys = []) {
  if (!keys || keys.length === 0) {
    throw new Error('At least one custom attribute key is required');
  }
  return {
    custom_attributes: Object.fromEntries(validateCustomAttributeKeys(keys).map((key) => [key, ''])),
  };
}

export function sanitizeEntityFields(fields = {}) {
  const sanitized = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (RESERVED_FIELD_NAMES.has(key)) {
      throw new Error(`Field "${key}" is managed by the hierarchy tool and cannot be overridden`);
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function addError(result, message, item = null) {
  result.errors.push({ message, item });
}

function addSkipped(result, reason, item) {
  result.skipped.push({ reason, item });
}

function makeOperation(action, entityType, entityData, entityId = null) {
  const operation = {
    action,
    entity_type: entityType,
    entity_data: entityData,
  };
  if (entityId) operation.entity_key = [entityId];
  return operation;
}

function indexedChildren(existingChildren = []) {
  const byName = new Map();
  const byId = new Map();
  for (const child of existingChildren || []) {
    if (child?.name) byName.set(child.name, child);
    if (child?.id) byId.set(child.id, child);
  }
  return { byName, byId };
}

export function emptyHierarchyPlan() {
  return {
    creates: [],
    reused: [],
    updated: [],
    renamed: [],
    custom_attributes_cleared: [],
    skipped: [],
    errors: [],
    operations: [],
    resolved: [],
  };
}

export function mergeHierarchyPlans(...plans) {
  const merged = emptyHierarchyPlan();
  for (const plan of plans) {
    for (const key of Object.keys(merged)) {
      merged[key].push(...(plan[key] || []));
    }
  }
  return merged;
}

export function planHierarchyLevel({
  projectId,
  parentId,
  parentRef = parentId,
  parentKind,
  entityType,
  nodes = [],
  existingChildren = [],
  allowCreates = true,
}) {
  if (!HIERARCHY_ENTITY_TYPES.has(entityType)) {
    throw new Error(`Unsupported entity type "${entityType}"`);
  }
  const result = emptyHierarchyPlan();
  const { byName, byId } = indexedChildren(existingChildren);
  const plannedNames = new Set();

  for (const node of nodes || []) {
    const item = {
      entity_type: entityType,
      name: node.name,
      desired_name: node.rename_to || node.name,
      parent_id: parentId || null,
      parent_ref: parentRef,
      parent_kind: parentKind,
      existing_id: node.existing_id || null,
    };

    try {
      validateHierarchyName(node.name, `${entityType} name`);
      if (node.rename_to) validateHierarchyName(node.rename_to, `${entityType} rename_to`);
      if (node.rename_to && !node.existing_id) {
        addError(result, 'rename_to requires existing_id; refusing implicit rename by name', item);
        continue;
      }

      const desiredName = node.rename_to || node.name;
      if (plannedNames.has(desiredName)) {
        addError(result, 'duplicate desired name in payload for the same parent; refusing duplicate writes', item);
        continue;
      }
      plannedNames.add(desiredName);

      const fields = sanitizeEntityFields(node.fields || {});
      const hasFieldUpdates = Object.keys(fields).length > 0;
      const clearKeys = node.clear_custom_attributes ? validateCustomAttributeKeys(node.custom_attribute_keys || []) : [];
      if (node.clear_custom_attributes && clearKeys.length === 0) {
        addError(result, 'clear_custom_attributes requires at least one custom_attribute_keys entry', item);
        continue;
      }

      if (node.existing_id) {
        const existing = byId.get(node.existing_id);
        if (!existing) {
          addError(result, 'existing_id was not found under the expected parent; refusing out-of-scope write', item);
          continue;
        }

        const nameCollision = byName.get(desiredName);
        if (nameCollision && nameCollision.id !== existing.id) {
          addError(result, 'desired name already exists under the same parent on a different entity', {
            ...item,
            collision_id: nameCollision.id,
          });
          continue;
        }

        const baseRecord = { ...item, id: existing.id, name: desiredName, previous_name: existing.name };
        result.reused.push(baseRecord);
        result.resolved.push({ ...baseRecord, existed: true });

        if (clearKeys.length > 0) {
          const operation = makeOperation(
            'update',
            entityType,
            buildClearCustomAttributesData(clearKeys),
            existing.id
          );
          result.operations.push(operation);
          result.custom_attributes_cleared.push({ ...baseRecord, keys: clearKeys });
        }

        if (existing.name !== desiredName) {
          const operation = makeOperation('update', entityType, { name: desiredName }, existing.id);
          result.operations.push(operation);
          result.renamed.push(baseRecord);
        }

        if (hasFieldUpdates) {
          const operation = makeOperation('update', entityType, fields, existing.id);
          result.operations.push(operation);
          result.updated.push({ ...baseRecord, fields: Object.keys(fields) });
        }
        continue;
      }

      if (node.rename_to) {
        addError(result, 'rename_to requires existing_id; refusing implicit rename by name', item);
        continue;
      }

      const existing = byName.get(node.name);
      if (existing) {
        const baseRecord = { ...item, id: existing.id, name: existing.name };
        result.reused.push(baseRecord);
        result.resolved.push({ ...baseRecord, existed: true });

        if (clearKeys.length > 0) {
          const operation = makeOperation(
            'update',
            entityType,
            buildClearCustomAttributesData(clearKeys),
            existing.id
          );
          result.operations.push(operation);
          result.custom_attributes_cleared.push({ ...baseRecord, keys: clearKeys });
        }

        if (hasFieldUpdates) {
          const operation = makeOperation('update', entityType, fields, existing.id);
          result.operations.push(operation);
          result.updated.push({ ...baseRecord, fields: Object.keys(fields) });
        }
        continue;
      }

      if (!allowCreates || !parentId) {
        result.creates.push({ ...item, fields: Object.keys(fields) });
        result.resolved.push({ ...item, id: null, existed: false });
        continue;
      }

      const entityData = {
        name: node.name,
        parent_id: parentId,
        project_id: projectId,
        ...fields,
      };
      const operation = makeOperation('create', entityType, entityData);
      result.operations.push(operation);
      result.creates.push({ ...item, fields: Object.keys(fields) });
      result.resolved.push({ ...item, id: null, existed: false });
    } catch (error) {
      addError(result, error.message, item);
    }
  }

  return result;
}
