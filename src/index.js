#!/usr/bin/env node

/**
 * ftrack MCP Server
 * Comprehensive Model Context Protocol server for ftrack API
 * Implements all 39+ ftrack API operations as MCP tools
 */

import dotenv from 'dotenv';
dotenv.config();

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { FtrackClient, escapeQL, validateIdentifier } from './ftrack-client.js';
import {
  buildClearCustomAttributesData,
  mergeHierarchyPlans,
  planHierarchyLevel,
  validateCustomAttributeKeys,
} from './hierarchy-planner.js';

/**
 * Flatten ftrack datetime objects ({ __type__: 'datetime', value: '...' }) into ISO strings.
 * @param {*} obj
 * @returns {*}
 */
function flattenDatetimes(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(flattenDatetimes);
  if (typeof obj === 'object') {
    if (obj.__type__ === 'datetime' && obj.value) return obj.value;
    const result = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = flattenDatetimes(val);
    }
    return result;
  }
  return obj;
}

/**
 * Format an API result for MCP tool response, flattening datetime objects.
 * @param {*} data
 * @returns {string}
 */
function formatResult(data) {
  return JSON.stringify(flattenDatetimes(data), null, 2);
}

function queryRows(result) {
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result)) return result;
  return [];
}

async function queryHierarchyChildren(entityType, projectId, parentId) {
  const safeType = validateIdentifier(entityType, 'entity_type');
  const expression = `select id, name, parent_id, project_id, custom_attributes from ${safeType} where project_id is "${escapeQL(projectId)}" and parent_id is "${escapeQL(parentId)}" limit 1000`;
  return queryRows(await client.query(expression));
}

async function queryTasksForParents(projectId, parentIds) {
  const tasksByParentId = new Map();
  for (const parentId of parentIds) {
    tasksByParentId.set(parentId, await queryHierarchyChildren('Task', projectId, parentId));
  }
  return tasksByParentId;
}

async function runOperationsInChunks(operations, chunkSize = 50) {
  const results = [];
  for (let i = 0; i < operations.length; i += chunkSize) {
    const chunk = operations.slice(i, i + chunkSize);
    if (chunk.length > 0) {
      results.push(...(await client.batch(chunk)));
    }
  }
  return results;
}

function findRecordByName(records, name) {
  return records.find((record) => record.name === name) || null;
}

function hydrateCreatedRecords(records, recordsByParentId, entityType) {
  return records.map((record) => {
    if (record.entity_type !== entityType || record.id) return record;
    const created = findRecordByName(recordsByParentId.get(record.parent_id) || [], record.name);
    return created ? { ...record, id: created.id } : record;
  });
}

function rootNodeKey(entityType, name) {
  return `${entityType}:${name}`;
}

function summarizeOperationRecord(record) {
  return {
    id: record.id || null,
    name: record.name,
    entity_type: record.entity_type,
    parent_id: record.parent_id || null,
    parent_ref: record.parent_ref || null,
  };
}

function summarizePlan(plan) {
  return {
    creates: plan.creates.map(summarizeOperationRecord),
    reused: plan.reused.map(summarizeOperationRecord),
    updated: plan.updated,
    renamed: plan.renamed,
    custom_attributes_cleared: plan.custom_attributes_cleared,
    skipped: plan.skipped,
    errors: plan.errors,
  };
}

// Initialize ftrack client
let client;
try {
  client = new FtrackClient(
    process.env.FTRACK_SERVER,
    process.env.FTRACK_API_USER,
    process.env.FTRACK_API_KEY
  );
} catch (error) {
  console.error('Failed to initialize ftrack client:', error.message);
  console.error('Please set FTRACK_SERVER, FTRACK_API_USER, and FTRACK_API_KEY environment variables.');
  process.exit(1);
}

// Create MCP server
const server = new McpServer({
  name: 'ftrack-mcp',
  version: '1.0.0',
  description: 'Comprehensive MCP server for ftrack API - all operations',
});

// ============================================================
// QUERY TOOLS
// ============================================================

server.tool(
  'ftrack_query',
  'Execute a query using ftrack query language. Example: "select id, name from Project where status is active"',
  {
    expression: z.string().describe('ftrack query expression (e.g., "select id, name from Project")'),
  },
  async ({ expression }) => {
    try {
      const result = await client.query(expression);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_parse_query',
  'Parse a query expression without executing it (useful for validation)',
  {
    expression: z.string().describe('Query expression to parse'),
  },
  async ({ expression }) => {
    try {
      const result = await client.parseQuery(expression);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_query_schemas',
  'Query all available entity schemas in ftrack',
  {},
  async () => {
    try {
      const result = await client.querySchemas();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_query_server_information',
  'Get ftrack server information including version and configuration',
  {},
  async () => {
    try {
      const result = await client.queryServerInformation();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_search',
  'Full-text search across ftrack entities',
  {
    expression: z.string().describe('Search query expression'),
    entity_type: z.string().optional().describe('Entity type to search (e.g., "Task", "Project")'),
    terms: z.array(z.string()).optional().describe('Search terms'),
    context_id: z.string().optional().describe('Limit search to a specific context'),
    object_type_ids: z.array(z.string()).optional().describe('Filter by object type IDs'),
  },
  async ({ expression, entity_type, terms, context_id, object_type_ids }) => {
    try {
      const result = await client.search(expression, entity_type, terms, context_id, object_type_ids);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// CRUD TOOLS
// ============================================================

server.tool(
  'ftrack_create',
  'Create a new entity in ftrack',
  {
    entity_type: z.string().describe('Type of entity to create (e.g., "Task", "Project", "AssetVersion")'),
    entity_data: z.record(z.any()).describe('Entity data as key-value pairs'),
  },
  async ({ entity_type, entity_data }) => {
    try {
      const result = await client.create(entity_type, entity_data);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_update',
  'Update an existing entity in ftrack',
  {
    entity_type: z.string().describe('Type of entity to update'),
    entity_id: z.string().describe('ID of the entity to update'),
    entity_data: z.record(z.any()).describe('Data to update as key-value pairs'),
  },
  async ({ entity_type, entity_id, entity_data }) => {
    try {
      const result = await client.update(entity_type, entity_id, entity_data);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_delete',
  'Delete an entity from ftrack',
  {
    entity_type: z.string().describe('Type of entity to delete'),
    entity_id: z.string().describe('ID of the entity to delete'),
  },
  async ({ entity_type, entity_id }) => {
    try {
      const result = await client.delete(entity_type, entity_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// USER SECURITY ROLE TOOLS
// ============================================================

server.tool(
  'ftrack_add_user_security_role',
  'Add a security role to a user',
  {
    user_id: z.string().describe('User ID'),
    security_role_id: z.string().describe('Security role ID to add'),
  },
  async ({ user_id, security_role_id }) => {
    try {
      const result = await client.addUserSecurityRole(user_id, security_role_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_remove_user_security_role',
  'Remove a security role from a user',
  {
    user_id: z.string().describe('User ID'),
    security_role_id: z.string().describe('Security role ID to remove'),
  },
  async ({ user_id, security_role_id }) => {
    try {
      const result = await client.removeUserSecurityRole(user_id, security_role_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_update_user_security_role',
  'Update a user security role (e.g., activate/deactivate)',
  {
    user_id: z.string().describe('User ID'),
    security_role_id: z.string().describe('Security role ID'),
    is_active: z.boolean().optional().default(true).describe('Whether the role should be active'),
  },
  async ({ user_id, security_role_id, is_active }) => {
    try {
      const result = await client.updateUserSecurityRole(user_id, security_role_id, is_active);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_grant_user_security_role_project',
  'Grant a user security role access to a specific project',
  {
    user_id: z.string().describe('User ID'),
    security_role_id: z.string().describe('Security role ID'),
    project_id: z.string().describe('Project ID to grant access to'),
  },
  async ({ user_id, security_role_id, project_id }) => {
    try {
      const result = await client.grantUserSecurityRoleProject(user_id, security_role_id, project_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_revoke_user_security_role_project',
  'Revoke a user security role access from a specific project',
  {
    user_id: z.string().describe('User ID'),
    security_role_id: z.string().describe('Security role ID'),
    project_id: z.string().describe('Project ID to revoke access from'),
  },
  async ({ user_id, security_role_id, project_id }) => {
    try {
      const result = await client.revokeUserSecurityRoleProject(user_id, security_role_id, project_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// USER IDENTITY TOOLS
// ============================================================

server.tool(
  'ftrack_assume_user',
  'Assume another user identity (requires admin privileges)',
  {
    user_id: z.string().describe('User ID to assume'),
  },
  async ({ user_id }) => {
    try {
      const result = await client.assumeUser(user_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_un_assume_user',
  'Stop assuming another user identity and return to original identity',
  {},
  async () => {
    try {
      const result = await client.unAssumeUser();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_send_user_invite',
  'Send an invitation email to a user',
  {
    user_id: z.string().describe('User ID to invite'),
    email: z.string().optional().describe('Email address (optional, uses user email if not provided)'),
  },
  async ({ user_id, email }) => {
    try {
      const result = await client.sendUserInvite(user_id, email);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// API KEY MANAGEMENT TOOLS
// ============================================================

server.tool(
  'ftrack_grant_api_key_project',
  'Grant an API key access to a project',
  {
    api_key_id: z.string().describe('API key ID'),
    project_id: z.string().describe('Project ID to grant access to'),
  },
  async ({ api_key_id, project_id }) => {
    try {
      const result = await client.grantApiKeyProject(api_key_id, project_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_revoke_api_key_project',
  'Revoke an API key access from a project',
  {
    api_key_id: z.string().describe('API key ID'),
    project_id: z.string().describe('Project ID to revoke access from'),
  },
  async ({ api_key_id, project_id }) => {
    try {
      const result = await client.revokeApiKeyProject(api_key_id, project_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_grant_api_key_security_role',
  'Grant a security role to an API key',
  {
    api_key_id: z.string().describe('API key ID'),
    security_role_id: z.string().describe('Security role ID to grant'),
  },
  async ({ api_key_id, security_role_id }) => {
    try {
      const result = await client.grantApiKeySecurityRole(api_key_id, security_role_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_revoke_api_key_security_role',
  'Revoke a security role from an API key',
  {
    api_key_id: z.string().describe('API key ID'),
    security_role_id: z.string().describe('Security role ID to revoke'),
  },
  async ({ api_key_id, security_role_id }) => {
    try {
      const result = await client.revokeApiKeySecurityRole(api_key_id, security_role_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// 2FA / OTP TOOLS
// ============================================================

server.tool(
  'ftrack_configure_otp',
  'Configure OTP (One-Time Password) for a user',
  {
    user_id: z.string().describe('User ID'),
    otp_type: z.string().describe('OTP type (e.g., "totp", "email")'),
  },
  async ({ user_id, otp_type }) => {
    try {
      const result = await client.configureOtp(user_id, otp_type);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_configure_totp',
  'Configure TOTP (Time-based One-Time Password) for a user',
  {
    user_id: z.string().describe('User ID'),
  },
  async ({ user_id }) => {
    try {
      const result = await client.configureTotp(user_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_generate_totp',
  'Generate a new TOTP secret for a user',
  {
    user_id: z.string().describe('User ID'),
  },
  async ({ user_id }) => {
    try {
      const result = await client.generateTotp(user_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_disable_2fa',
  'Disable two-factor authentication for a user',
  {
    user_id: z.string().describe('User ID'),
  },
  async ({ user_id }) => {
    try {
      const result = await client.disable2FA(user_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// FILE / MEDIA TOOLS
// ============================================================

server.tool(
  'ftrack_get_upload_metadata',
  'Get metadata required for uploading a file to ftrack',
  {
    component_id: z.string().describe('Component ID for the upload'),
    file_size: z.number().describe('Size of the file in bytes'),
    file_name: z.string().optional().describe('Name of the file'),
    checksum: z.string().optional().describe('MD5 checksum of the file (base64 encoded)'),
  },
  async ({ component_id, file_size, file_name, checksum }) => {
    try {
      const result = await client.getUploadMetadata(component_id, file_size, file_name, checksum);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_complete_multipart_upload',
  'Complete a multipart upload after all parts have been uploaded',
  {
    component_id: z.string().describe('Component ID'),
    upload_id: z.string().describe('Upload ID from the multipart upload initiation'),
    parts: z.array(z.object({
      part_number: z.number(),
      etag: z.string(),
    })).describe('Array of uploaded parts with part numbers and ETags'),
  },
  async ({ component_id, upload_id, parts }) => {
    try {
      const result = await client.completeMultipartUpload(component_id, upload_id, parts);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_generate_signed_url',
  'Generate a signed URL for accessing or uploading a component',
  {
    component_id: z.string().describe('Component ID'),
    operation: z.enum(['get', 'put']).optional().default('get').describe('Operation type: "get" for download, "put" for upload'),
  },
  async ({ component_id, operation }) => {
    try {
      const result = await client.generateSignedUrl(component_id, operation);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_encode_media',
  'Trigger media encoding/transcoding for a component',
  {
    component_id: z.string().describe('Component ID to encode'),
    options: z.record(z.any()).optional().describe('Additional encoding options'),
  },
  async ({ component_id, options }) => {
    try {
      const result = await client.encodeMedia(component_id, options || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// ENTITY CONVERSION TOOL
// ============================================================

server.tool(
  'ftrack_convert_entity',
  'Convert an entity from one type to another',
  {
    entity_type: z.string().describe('Current entity type'),
    entity_id: z.string().describe('Entity ID to convert'),
    target_type: z.string().describe('Target entity type'),
  },
  async ({ entity_type, entity_id, target_type }) => {
    try {
      const result = await client.convertEntity(entity_type, entity_id, target_type);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// PERMISSIONS TOOL
// ============================================================

server.tool(
  'ftrack_permissions',
  'Check permissions for an entity',
  {
    entity_type: z.string().describe('Entity type'),
    entity_id: z.string().describe('Entity ID'),
    actions: z.array(z.string()).optional().describe('Specific actions to check (e.g., ["read", "write", "delete"])'),
  },
  async ({ entity_type, entity_id, actions }) => {
    try {
      const result = await client.permissions(entity_type, entity_id, actions);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// STORAGE TOOL
// ============================================================

server.tool(
  'ftrack_storage_usage',
  'Get storage usage information',
  {
    project_id: z.string().optional().describe('Project ID (optional, returns global usage if not specified)'),
  },
  async ({ project_id }) => {
    try {
      const result = await client.storageUsage(project_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// REVIEW SESSION TOOL
// ============================================================

server.tool(
  'ftrack_send_review_session_invite',
  'Send an invitation to participate in a review session',
  {
    review_session_id: z.string().describe('Review session ID'),
    email: z.string().describe('Email address to invite'),
    name: z.string().optional().describe('Name of the invitee'),
    message: z.string().optional().describe('Custom message to include in the invitation'),
  },
  async ({ review_session_id, email, name, message }) => {
    try {
      const result = await client.sendReviewSessionInvite(review_session_id, email, name, message);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// RESET TOOLS
// ============================================================

server.tool(
  'ftrack_reset_remote_api_key',
  'Reset a user remote API key',
  {
    user_id: z.string().describe('User ID'),
  },
  async ({ user_id }) => {
    try {
      const result = await client.resetRemoteApiKey(user_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_reset_remote_password',
  'Reset a user remote password',
  {
    user_id: z.string().describe('User ID'),
  },
  async ({ user_id }) => {
    try {
      const result = await client.resetRemotePassword(user_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// DELAYED JOB TOOLS
// ============================================================

server.tool(
  'ftrack_csv_import_delayed_job',
  'Create a CSV import delayed job',
  {
    job_data: z.record(z.any()).describe('CSV import job data'),
  },
  async ({ job_data }) => {
    try {
      const result = await client.csvImportDelayedJob(job_data);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_delete_delayed_job',
  'Create a delete delayed job for batch entity deletion',
  {
    entity_type: z.string().describe('Entity type to delete'),
    entity_id: z.string().describe('Entity ID to delete'),
  },
  async ({ entity_type, entity_id }) => {
    try {
      const result = await client.deleteDelayedJob(entity_type, entity_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_export_review_session_feedback_delayed_job',
  'Export review session feedback as a delayed job',
  {
    review_session_id: z.string().describe('Review session ID'),
    options: z.record(z.any()).optional().describe('Export options'),
  },
  async ({ review_session_id, options }) => {
    try {
      const result = await client.exportReviewSessionFeedbackDelayedJob(review_session_id, options || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_iconik_sync_structure_delayed_job',
  'Sync structure to iconik as a delayed job',
  {
    project_id: z.string().describe('Project ID to sync'),
    options: z.record(z.any()).optional().describe('Sync options'),
  },
  async ({ project_id, options }) => {
    try {
      const result = await client.iconikSyncStructureDelayedJob(project_id, options || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_sync_ldap_users_delayed_job',
  'Sync LDAP users as a delayed job',
  {
    options: z.record(z.any()).optional().describe('LDAP sync options'),
  },
  async ({ options }) => {
    try {
      const result = await client.syncLdapUsersDelayedJob(options || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// BATCH OPERATIONS TOOL
// ============================================================

server.tool(
  'ftrack_batch',
  'Execute multiple operations in a single transaction (all succeed or all fail)',
  {
    operations: z.array(z.object({
      action: z.string().describe('Operation action (query, create, update, delete, etc.)'),
      entity_type: z.string().optional().describe('Entity type for the operation'),
      entity_data: z.record(z.any()).optional().describe('Entity data'),
      entity_key: z.array(z.string()).optional().describe('Entity key/ID'),
      expression: z.string().optional().describe('Query expression (for query action)'),
    })).describe('Array of operations to execute'),
  },
  async ({ operations }) => {
    try {
      const result = await client.batch(operations);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

const taskHierarchyNodeSchema = z.object({
  name: z.string().describe('Task name. Must match ^[A-Za-z0-9_]+$'),
  existing_id: z.string().optional().describe('Existing Task ID to reuse or rename. Required for renames.'),
  rename_to: z.string().optional().describe('Optional new task name. Requires existing_id.'),
  clear_custom_attributes: z.boolean().optional().default(false).describe('Clear selected custom attributes on an existing task'),
  custom_attribute_keys: z.array(z.string()).optional().describe('Custom attribute keys to clear when clear_custom_attributes is true'),
  fields: z.record(z.any()).optional().describe('Additional fields for create/update; cannot override id/name/parent/project/custom_attributes'),
});

const hierarchyNodeSchema = z.object({
  name: z.string().describe('Root entity name. Must match ^[A-Za-z0-9_]+$'),
  existing_id: z.string().optional().describe('Existing entity ID to reuse or rename. Required for renames.'),
  rename_to: z.string().optional().describe('Optional new entity name. Requires existing_id.'),
  clear_custom_attributes: z.boolean().optional().default(false).describe('Clear selected custom attributes on an existing entity'),
  custom_attribute_keys: z.array(z.string()).optional().describe('Custom attribute keys to clear when clear_custom_attributes is true'),
  fields: z.record(z.any()).optional().describe('Additional fields for create/update; cannot override id/name/parent/project/custom_attributes'),
  tasks: z.array(taskHierarchyNodeSchema).optional().describe('Tasks to upsert directly under this root entity'),
});

const hierarchyRootSchema = z.object({
  parent_id: z.string().describe('Allowlisted existing parent context ID where root entities may be created or reused'),
  entity_type: z.enum(['AssetBuild', 'Shot']).describe('Root entity type to upsert under parent_id'),
  parent_ref: z.string().optional().describe('Optional display label for this parent in plan results'),
  nodes: z.array(hierarchyNodeSchema).describe('Root entities to upsert under this parent'),
});

function findResolvedRoot(plan, entityType, node) {
  const desiredName = node.rename_to || node.name;
  return plan.resolved.find((record) => record.entity_type === entityType && record.name === desiredName) || null;
}

async function buildDryRunTaskPlan(projectId, rootPlan, rootSpec) {
  const plans = [];
  for (const node of rootSpec.nodes || []) {
    const tasks = node.tasks || [];
    if (tasks.length === 0) continue;

    const root = findResolvedRoot(rootPlan, rootSpec.entity_type, node);
    if (!root) {
      plans.push({
        ...mergeHierarchyPlans(),
        errors: [{
          message: 'Parent was not resolved; refusing to plan child tasks',
          item: { entity_type: rootSpec.entity_type, name: node.name },
        }],
      });
      continue;
    }

    const existingTasks = root.id ? await queryHierarchyChildren('Task', projectId, root.id) : [];
    plans.push(planHierarchyLevel({
      projectId,
      parentId: root.id,
      parentRef: rootNodeKey(rootSpec.entity_type, root.name),
      parentKind: rootSpec.parent_ref || rootSpec.parent_id,
      entityType: 'Task',
      nodes: tasks,
      existingChildren: existingTasks,
      allowCreates: Boolean(root.id),
    }));
  }
  return mergeHierarchyPlans(...plans);
}

async function buildCommittedTaskPlan(projectId, rootSpec, rootRecords) {
  const plans = [];
  for (const node of rootSpec.nodes || []) {
    const tasks = node.tasks || [];
    if (tasks.length === 0) continue;

    const desiredName = node.rename_to || node.name;
    const root = findRecordByName(rootRecords, desiredName);
    if (!root) {
      plans.push({
        ...mergeHierarchyPlans(),
        errors: [{
          message: 'Parent was not found after root commit; refusing child task writes',
          item: { entity_type: rootSpec.entity_type, name: desiredName },
        }],
      });
      continue;
    }

    const existingTasks = await queryHierarchyChildren('Task', projectId, root.id);
    plans.push(planHierarchyLevel({
      projectId,
      parentId: root.id,
      parentRef: rootNodeKey(rootSpec.entity_type, root.name),
      parentKind: rootSpec.parent_ref || rootSpec.parent_id,
      entityType: 'Task',
      nodes: tasks,
      existingChildren: existingTasks,
    }));
  }
  return mergeHierarchyPlans(...plans);
}

async function buildVerificationSummary(projectId, rootGroups) {
  const summary = [];
  for (const group of rootGroups) {
    const roots = [];
    for (const root of group.roots) {
      const tasks = await queryHierarchyChildren('Task', projectId, root.id);
      roots.push({
        id: root.id,
        name: root.name,
        tasks: tasks.map((task) => ({ id: task.id, name: task.name })),
      });
    }
    summary.push({
      parent_id: group.parent_id,
      parent_ref: group.parent_ref,
      entity_type: group.entity_type,
      roots,
    });
  }
  return summary;
}

server.tool(
  'ftrack_clear_custom_attributes',
  'Clear custom attributes on a single ftrack entity using native custom_attributes mapping',
  {
    entity_type: z.string().describe('Entity type to update, e.g. AssetBuild, Shot, or Task'),
    entity_id: z.string().describe('Entity ID to update'),
    keys: z.array(z.string()).min(1).describe('Custom attribute keys to clear'),
  },
  async ({ entity_type, entity_id, keys }) => {
    try {
      const safeType = validateIdentifier(entity_type, 'entity_type');
      const clearKeys = validateCustomAttributeKeys(keys);
      const result = await client.update(safeType, entity_id, buildClearCustomAttributesData(clearKeys));
      return {
        content: [{
          type: 'text',
          text: formatResult({
            entity_type: safeType,
            entity_id,
            custom_attributes_cleared: clearKeys,
            result,
          }),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_batch_upsert_hierarchy',
  'Safely create/reuse/rename root entities and Tasks under explicit allowlisted parents',
  {
    project_id: z.string().describe('Project ID that owns the hierarchy'),
    writable_parent_ids: z.array(z.string()).min(1).describe('Explicit allowlist of parent IDs this operation may write under'),
    mode: z.enum(['dry_run', 'commit']).optional().default('dry_run').describe('dry_run plans only; commit applies safe chunks and verifies the resulting tree'),
    chunk_size: z.number().int().positive().max(100).optional().default(50).describe('Maximum operations per ftrack batch call in commit mode'),
    tree: z.object({
      roots: z.array(hierarchyRootSchema).min(1).describe('Root entity groups to upsert under allowlisted parent IDs'),
    }).describe('Hierarchy payload'),
  },
  async ({ project_id, writable_parent_ids, mode, chunk_size, tree }) => {
    try {
      const writableParentIds = new Set(writable_parent_ids);

      for (const rootSpec of tree.roots) {
        if (!writableParentIds.has(rootSpec.parent_id)) {
          throw new Error(`root parent_id ${rootSpec.parent_id} must be included in writable_parent_ids`);
        }
      }

      const rootPlanParts = [];
      for (const rootSpec of tree.roots) {
        const existingRoots = await queryHierarchyChildren(rootSpec.entity_type, project_id, rootSpec.parent_id);
        rootPlanParts.push(planHierarchyLevel({
          projectId: project_id,
          parentId: rootSpec.parent_id,
          parentRef: rootSpec.parent_ref || rootSpec.parent_id,
          parentKind: rootSpec.parent_ref || rootSpec.parent_id,
          entityType: rootSpec.entity_type,
          nodes: rootSpec.nodes,
          existingChildren: existingRoots,
        }));
      }
      const rootPlan = mergeHierarchyPlans(...rootPlanParts);

      if (mode === 'dry_run') {
        const taskPlanParts = [];
        for (const rootSpec of tree.roots) {
          taskPlanParts.push(await buildDryRunTaskPlan(project_id, rootPlan, rootSpec));
        }
        const taskPlan = mergeHierarchyPlans(...taskPlanParts);
        const fullPlan = mergeHierarchyPlans(rootPlan, taskPlan);
        return {
          content: [{
            type: 'text',
            text: formatResult({
              mode,
              committed: false,
              ...summarizePlan(fullPlan),
            }),
          }],
        };
      }

      if (rootPlan.errors.length > 0) {
        return {
          content: [{
            type: 'text',
            text: formatResult({
              mode,
              committed: false,
              errors: rootPlan.errors,
              message: 'Root hierarchy validation failed; no writes were applied.',
            }),
          }],
          isError: true,
        };
      }

      const preCommitTaskPlanParts = [];
      for (const rootSpec of tree.roots) {
        preCommitTaskPlanParts.push(await buildDryRunTaskPlan(project_id, rootPlan, rootSpec));
      }
      const preCommitTaskPlan = mergeHierarchyPlans(...preCommitTaskPlanParts);

      if (preCommitTaskPlan.errors.length > 0) {
        return {
          content: [{
            type: 'text',
            text: formatResult({
              mode,
              committed: false,
              errors: preCommitTaskPlan.errors,
              message: 'Task hierarchy validation failed; no writes were applied.',
            }),
          }],
          isError: true,
        };
      }

      await runOperationsInChunks(rootPlan.operations, chunk_size);

      const taskPlanParts = [];
      for (const rootSpec of tree.roots) {
        const records = await queryHierarchyChildren(rootSpec.entity_type, project_id, rootSpec.parent_id);
        taskPlanParts.push(await buildCommittedTaskPlan(project_id, rootSpec, records));
      }
      const taskPlan = mergeHierarchyPlans(...taskPlanParts);

      if (taskPlan.errors.length > 0) {
        return {
          content: [{
            type: 'text',
            text: formatResult({
              mode,
              committed: true,
              root_operations_committed: true,
              errors: taskPlan.errors,
              message: 'Root operations were committed, but task validation failed before task writes.',
            }),
          }],
          isError: true,
        };
      }

      await runOperationsInChunks(taskPlan.operations, chunk_size);

      const requestedRootGroups = [];
      const rootIds = [];
      const recordsByParentId = new Map();
      for (const rootSpec of tree.roots) {
        const records = await queryHierarchyChildren(rootSpec.entity_type, project_id, rootSpec.parent_id);
        recordsByParentId.set(rootSpec.parent_id, records);
        const requestedRoots = rootSpec.nodes
          .map((node) => findRecordByName(records, node.rename_to || node.name))
          .filter(Boolean);
        requestedRootGroups.push({
          parent_id: rootSpec.parent_id,
          parent_ref: rootSpec.parent_ref || rootSpec.parent_id,
          entity_type: rootSpec.entity_type,
          roots: requestedRoots,
        });
        rootIds.push(...requestedRoots.map((record) => record.id));
      }
      const tasksByParentId = await queryTasksForParents(project_id, rootIds);
      for (const [parentId, tasks] of tasksByParentId.entries()) {
        recordsByParentId.set(parentId, tasks);
      }

      const fullPlan = mergeHierarchyPlans(rootPlan, taskPlan);
      fullPlan.creates = [
        ...fullPlan.creates.flatMap((record) => hydrateCreatedRecords([record], recordsByParentId, record.entity_type)),
      ].filter((record, index, records) => (
        records.findIndex((candidate) => (
          candidate.entity_type === record.entity_type &&
          candidate.name === record.name &&
          candidate.parent_ref === record.parent_ref
        )) === index
      ));

      return {
        content: [{
          type: 'text',
          text: formatResult({
            mode,
            committed: true,
            ...summarizePlan(fullPlan),
            verification: await buildVerificationSummary(project_id, requestedRootGroups),
          }),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// CONVENIENCE / HELPER TOOLS
// ============================================================

server.tool(
  'ftrack_list_projects',
  'List all projects (convenience wrapper for query)',
  {
    include_archived: z.boolean().optional().default(false).describe('Include archived projects'),
    limit: z.number().optional().default(100).describe('Maximum number of projects to return'),
  },
  async ({ include_archived, limit }) => {
    try {
      let expression = `select id, name, full_name, status, start_date, end_date from Project`;
      if (!include_archived) {
        expression += ` where status.name is_not "archived"`;
      }
      expression += ` limit ${limit}`;
      const result = await client.query(expression);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_list_tasks',
  'List tasks for a project or context',
  {
    project_id: z.string().optional().describe('Project ID to filter by'),
    parent_id: z.string().optional().describe('Parent context ID to filter by'),
    assignee_id: z.string().optional().describe('User ID to filter by assignee'),
    status: z.string().optional().describe('Status name to filter by'),
    limit: z.number().optional().default(100).describe('Maximum number of tasks to return'),
  },
  async ({ project_id, parent_id, assignee_id, status, limit }) => {
    try {
      let expression = `select id, name, type.name, status.name, priority.name, start_date, end_date, assignments.resource.username from Task`;
      const conditions = [];
      if (project_id) conditions.push(`project_id is "${escapeQL(project_id)}"`);
      if (parent_id) conditions.push(`parent_id is "${escapeQL(parent_id)}"`);
      if (assignee_id) conditions.push(`assignments any (resource_id is "${escapeQL(assignee_id)}")`);
      if (status) conditions.push(`status.name is "${escapeQL(status)}"`);
      if (conditions.length > 0) {
        expression += ` where ${conditions.join(' and ')}`;
      }
      expression += ` limit ${limit}`;
      const result = await client.query(expression);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_list_users',
  'List all users',
  {
    include_inactive: z.boolean().optional().default(false).describe('Include inactive users'),
    limit: z.number().optional().default(100).describe('Maximum number of users to return'),
  },
  async ({ include_inactive, limit }) => {
    try {
      let expression = `select id, username, first_name, last_name, email, is_active from User`;
      if (!include_inactive) {
        expression += ` where is_active is true`;
      }
      expression += ` limit ${limit}`;
      const result = await client.query(expression);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_list_asset_versions',
  'List asset versions for a task or asset',
  {
    asset_id: z.string().optional().describe('Asset ID to filter by'),
    task_id: z.string().optional().describe('Task ID to filter by'),
    limit: z.number().optional().default(50).describe('Maximum number of versions to return'),
  },
  async ({ asset_id, task_id, limit }) => {
    try {
      let expression = `select id, version, asset.name, task.name, user.username, date, comment from AssetVersion`;
      const conditions = [];
      if (asset_id) conditions.push(`asset_id is "${asset_id}"`);
      if (task_id) conditions.push(`task_id is "${task_id}"`);
      if (conditions.length > 0) {
        expression += ` where ${conditions.join(' and ')}`;
      }
      expression += ` order by version descending limit ${limit}`;
      const result = await client.query(expression);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_list_statuses',
  'List all available statuses',
  {},
  async () => {
    try {
      const result = await client.query('select id, name, color, sort from Status order by sort');
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_list_types',
  'List all available task/object types',
  {},
  async () => {
    try {
      const result = await client.query('select id, name, sort from Type order by sort');
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_list_priorities',
  'List all available priorities',
  {},
  async () => {
    try {
      const result = await client.query('select id, name, color, sort from Priority order by sort');
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_get_entity',
  'Get a single entity by type and ID with specified projections',
  {
    entity_type: z.string().describe('Entity type (e.g., "Task", "Project", "User")'),
    entity_id: z.string().describe('Entity ID'),
    projections: z.array(z.string()).optional().describe('Attributes to return (e.g., ["id", "name", "status.name"])'),
  },
  async ({ entity_type, entity_id, projections }) => {
    try {
      const attrs = projections?.length ? projections.map(validateIdentifier).join(', ') : '*';
      const expression = `select ${attrs} from ${validateIdentifier(entity_type)} where id is "${escapeQL(entity_id)}"`;
      const result = await client.query(expression);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_create_note',
  'Create a note on an entity',
  {
    entity_type: z.string().describe('Entity type to add note to'),
    entity_id: z.string().describe('Entity ID to add note to'),
    content: z.string().describe('Note content'),
    author_id: z.string().optional().describe('Author user ID (defaults to API user)'),
  },
  async ({ entity_type, entity_id, content, author_id }) => {
    try {
      const noteData = {
        content,
        parent_type: entity_type,
        parent_id: entity_id,
      };
      if (author_id) noteData.author_id = author_id;
      const result = await client.create('Note', noteData);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_list_notes',
  'List notes for an entity',
  {
    entity_type: z.string().describe('Entity type'),
    entity_id: z.string().describe('Entity ID'),
    limit: z.number().optional().default(50).describe('Maximum number of notes to return'),
  },
  async ({ entity_type, entity_id, limit }) => {
    try {
      const expression = `select id, content, author.username, date from Note where parent_type is "${escapeQL(entity_type)}" and parent_id is "${escapeQL(entity_id)}" order by date descending limit ${limit}`;
      const result = await client.query(expression);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_update_task_status',
  'Update the status of a task',
  {
    task_id: z.string().describe('Task ID'),
    status_id: z.string().describe('New status ID'),
  },
  async ({ task_id, status_id }) => {
    try {
      const result = await client.update('Task', task_id, { status_id });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_assign_user_to_task',
  'Assign a user to a task',
  {
    task_id: z.string().describe('Task ID'),
    user_id: z.string().describe('User ID to assign'),
  },
  async ({ task_id, user_id }) => {
    try {
      const result = await client.create('Appointment', {
        context_id: task_id,
        resource_id: user_id,
        type: 'assignment',
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_list_security_roles',
  'List all security roles',
  {},
  async () => {
    try {
      const result = await client.query('select id, name, type from SecurityRole');
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'ftrack_list_review_sessions',
  'List review sessions',
  {
    project_id: z.string().optional().describe('Filter by project ID'),
    limit: z.number().optional().default(50).describe('Maximum number of sessions to return'),
  },
  async ({ project_id, limit }) => {
    try {
      let expression = `select id, name, description, created_at, end_date from ReviewSession`;
      if (project_id) {
        expression += ` where project_id is "${project_id}"`;
      }
      expression += ` order by created_at descending limit ${limit}`;
      const result = await client.query(expression);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'list_shots',
  'List shots for a project or parent sequence',
  {
    project_id: z.string().optional().describe('Project ID to filter by'),
    parent_id: z.string().optional().describe('Sequence or parent context ID to filter by'),
    status: z.string().optional().describe('Status name to filter by'),
    limit: z.number().optional().default(100).describe('Maximum number of shots to return'),
  },
  async ({ project_id, parent_id, status, limit }) => {
    try {
      let expression = `select id, name, status.name, parent.name, start_frame, end_frame from Shot`;
      const conditions = [];
      if (project_id) conditions.push(`project_id is "${escapeQL(project_id)}"`);
      if (parent_id) conditions.push(`parent_id is "${escapeQL(parent_id)}"`);
      if (status) conditions.push(`status.name is "${escapeQL(status)}"`);
      if (conditions.length > 0) {
        expression += ` where ${conditions.join(' and ')}`;
      }
      expression += ` limit ${limit}`;
      const result = await client.query(expression);
      return {
        content: [{ type: 'text', text: formatResult(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'list_asset_builds',
  'List asset builds for a project',
  {
    project_id: z.string().optional().describe('Project ID to filter by'),
    asset_type: z.string().optional().describe('Asset type name to filter by (e.g., "Character", "Prop")'),
    status: z.string().optional().describe('Status name to filter by'),
    limit: z.number().optional().default(100).describe('Maximum number of asset builds to return'),
  },
  async ({ project_id, asset_type, status, limit }) => {
    try {
      let expression = `select id, name, type.name, status.name, parent.name from AssetBuild`;
      const conditions = [];
      if (project_id) conditions.push(`project_id is "${escapeQL(project_id)}"`);
      if (asset_type) conditions.push(`type.name is "${escapeQL(asset_type)}"`);
      if (status) conditions.push(`status.name is "${escapeQL(status)}"`);
      if (conditions.length > 0) {
        expression += ` where ${conditions.join(' and ')}`;
      }
      expression += ` limit ${limit}`;
      const result = await client.query(expression);
      return {
        content: [{ type: 'text', text: formatResult(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'get_project_structure',
  'Get the top-level structure of a project (immediate children such as sequences, episodes, folders)',
  {
    project_id: z.string().describe('Project ID'),
    limit: z.number().optional().default(200).describe('Maximum number of children to return'),
  },
  async ({ project_id, limit }) => {
    try {
      const expression = `select id, name, __entity_type__, parent_id from TypedContext where project_id is "${escapeQL(project_id)}" and parent_id is "${escapeQL(project_id)}" limit ${limit}`;
      const result = await client.query(expression);
      return {
        content: [{ type: 'text', text: formatResult(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'list_user_assignments',
  'List all tasks assigned to a user, optionally filtered by project or status',
  {
    user_id: z.string().describe('User ID to list assignments for'),
    project_id: z.string().optional().describe('Project ID to filter by'),
    status: z.string().optional().describe('Task status name to filter by'),
    limit: z.number().optional().default(100).describe('Maximum number of assignments to return'),
  },
  async ({ user_id, project_id, status, limit }) => {
    try {
      let expression = `select id, name, type.name, status.name, priority.name, start_date, end_date, project.name from Task`;
      const conditions = [`assignments any (resource_id is "${escapeQL(user_id)}")`];
      if (project_id) conditions.push(`project_id is "${escapeQL(project_id)}"`);
      if (status) conditions.push(`status.name is "${escapeQL(status)}"`);
      expression += ` where ${conditions.join(' and ')}`;
      expression += ` limit ${limit}`;
      const result = await client.query(expression);
      return {
        content: [{ type: 'text', text: formatResult(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'list_milestones',
  'List milestones for a project',
  {
    project_id: z.string().optional().describe('Project ID to filter by'),
    status: z.string().optional().describe('Status name to filter by'),
    limit: z.number().optional().default(100).describe('Maximum number of milestones to return'),
  },
  async ({ project_id, status, limit }) => {
    try {
      let expression = `select id, name, status.name, date from Milestone`;
      const conditions = [];
      if (project_id) conditions.push(`project_id is "${escapeQL(project_id)}"`);
      if (status) conditions.push(`status.name is "${escapeQL(status)}"`);
      if (conditions.length > 0) {
        expression += ` where ${conditions.join(' and ')}`;
      }
      expression += ` order by date ascending limit ${limit}`;
      const result = await client.query(expression);
      return {
        content: [{ type: 'text', text: formatResult(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// START SERVER
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ftrack MCP server started');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
