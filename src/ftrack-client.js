/**
 * ftrack API Client
 * Handles authentication and communication with ftrack API
 */

export class FtrackClient {
  constructor(serverUrl, apiUser, apiKey) {
    // Remove trailing slash if present
    this.serverUrl = serverUrl?.replace(/\/$/, '') || process.env.FTRACK_SERVER;
    this.apiUser = apiUser || process.env.FTRACK_API_USER;
    this.apiKey = apiKey || process.env.FTRACK_API_KEY;

    if (!this.serverUrl) {
      throw new Error('FTRACK_SERVER environment variable or serverUrl is required');
    }
    if (!this.apiUser) {
      throw new Error('FTRACK_API_USER environment variable or apiUser is required');
    }
    if (!this.apiKey) {
      throw new Error('FTRACK_API_KEY environment variable or apiKey is required');
    }

    this.apiEndpoint = `${this.serverUrl}/api`;
  }

  /**
   * Execute one or more operations against the ftrack API
   * @param {Array} operations - Array of operation objects
   * @returns {Promise<Array>} - Array of results corresponding to each operation
   */
  async call(operations) {
    if (!Array.isArray(operations)) {
      operations = [operations];
    }

    const response = await fetch(this.apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'ftrack-user': this.apiUser,
        'ftrack-api-key': this.apiKey,
      },
      body: JSON.stringify(operations),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ftrack API error (${response.status}): ${errorText}`);
    }

    const results = await response.json();

    // Check for operation-level errors
    for (let i = 0; i < results.length; i++) {
      if (results[i] && results[i].exception) {
        throw new Error(`Operation ${i} failed: ${results[i].content}`);
      }
    }

    return results;
  }

  /**
   * Execute a single operation and return the first result
   */
  async callOne(operation) {
    const results = await this.call([operation]);
    if (results[0] === undefined) {
      throw new Error('ftrack API returned an empty response');
    }
    return results[0];
  }

  // ============================================================
  // QUERY OPERATIONS
  // ============================================================

  /**
   * Query entities using ftrack query language
   * @param {string} expression - Query expression (e.g., "select id, name from Project")
   */
  async query(expression) {
    return this.callOne({
      action: 'query',
      expression,
    });
  }

  /**
   * Parse a query expression without executing it
   */
  async parseQuery(expression) {
    return this.callOne({
      action: 'parse_query',
      expression,
    });
  }

  /**
   * Query available schemas
   */
  async querySchemas() {
    return this.callOne({
      action: 'query_schemas',
    });
  }

  /**
   * Query server information
   */
  async queryServerInformation() {
    return this.callOne({
      action: 'query_server_information',
    });
  }

  /**
   * Search using full-text search
   */
  async search(expression, entityType = null, terms = null, contextId = null, objectTypeIds = null) {
    const operation = {
      action: 'search',
      expression,
    };
    if (entityType) operation.entity_type = entityType;
    if (terms) operation.terms = terms;
    if (contextId) operation.context_id = contextId;
    if (objectTypeIds) operation.object_type_ids = objectTypeIds;
    return this.callOne(operation);
  }

  // ============================================================
  // CRUD OPERATIONS
  // ============================================================

  /**
   * Create a new entity
   * @param {string} entityType - Type of entity to create
   * @param {object} data - Entity data
   */
  async create(entityType, data) {
    return this.callOne({
      action: 'create',
      entity_type: entityType,
      entity_data: data,
    });
  }

  /**
   * Update an existing entity
   * @param {string} entityType - Type of entity
   * @param {string} entityId - ID of entity to update
   * @param {object} data - Data to update
   */
  async update(entityType, entityId, data) {
    return this.callOne({
      action: 'update',
      entity_type: entityType,
      entity_key: [entityId],
      entity_data: data,
    });
  }

  /**
   * Delete an entity
   * @param {string} entityType - Type of entity
   * @param {string} entityId - ID of entity to delete
   */
  async delete(entityType, entityId) {
    return this.callOne({
      action: 'delete',
      entity_type: entityType,
      entity_key: [entityId],
    });
  }

  // ============================================================
  // USER MANAGEMENT OPERATIONS
  // ============================================================

  /**
   * Add a security role to a user
   */
  async addUserSecurityRole(userId, securityRoleId) {
    return this.callOne({
      action: 'add_user_security_role',
      user_id: userId,
      security_role_id: securityRoleId,
    });
  }

  /**
   * Remove a security role from a user
   */
  async removeUserSecurityRole(userId, securityRoleId) {
    return this.callOne({
      action: 'remove_user_security_role',
      user_id: userId,
      security_role_id: securityRoleId,
    });
  }

  /**
   * Update a user's security role
   */
  async updateUserSecurityRole(userId, securityRoleId, isActive = true) {
    return this.callOne({
      action: 'update_user_security_role',
      user_id: userId,
      security_role_id: securityRoleId,
      is_active: isActive,
    });
  }

  /**
   * Grant a user's security role to a project
   */
  async grantUserSecurityRoleProject(userId, securityRoleId, projectId) {
    return this.callOne({
      action: 'grant_user_security_role_project',
      user_id: userId,
      security_role_id: securityRoleId,
      project_id: projectId,
    });
  }

  /**
   * Revoke a user's security role from a project
   */
  async revokeUserSecurityRoleProject(userId, securityRoleId, projectId) {
    return this.callOne({
      action: 'revoke_user_security_role_project',
      user_id: userId,
      security_role_id: securityRoleId,
      project_id: projectId,
    });
  }

  /**
   * Assume another user's identity (requires admin privileges)
   */
  async assumeUser(userId) {
    return this.callOne({
      action: 'assume_user',
      user_id: userId,
    });
  }

  /**
   * Stop assuming another user's identity
   */
  async unAssumeUser() {
    return this.callOne({
      action: 'un_assume_user',
    });
  }

  /**
   * Send an invite to a user
   */
  async sendUserInvite(userId, email = null) {
    const operation = {
      action: 'send_user_invite',
      user_id: userId,
    };
    if (email) operation.email = email;
    return this.callOne(operation);
  }

  // ============================================================
  // API KEY MANAGEMENT OPERATIONS
  // ============================================================

  /**
   * Grant an API key access to a project
   */
  async grantApiKeyProject(apiKeyId, projectId) {
    return this.callOne({
      action: 'grant_api_key_project',
      api_key_id: apiKeyId,
      project_id: projectId,
    });
  }

  /**
   * Revoke an API key's access to a project
   */
  async revokeApiKeyProject(apiKeyId, projectId) {
    return this.callOne({
      action: 'revoke_api_key_project',
      api_key_id: apiKeyId,
      project_id: projectId,
    });
  }

  /**
   * Grant a security role to an API key
   */
  async grantApiKeySecurityRole(apiKeyId, securityRoleId) {
    return this.callOne({
      action: 'grant_api_key_security_role',
      api_key_id: apiKeyId,
      security_role_id: securityRoleId,
    });
  }

  /**
   * Revoke a security role from an API key
   */
  async revokeApiKeySecurityRole(apiKeyId, securityRoleId) {
    return this.callOne({
      action: 'revoke_api_key_security_role',
      api_key_id: apiKeyId,
      security_role_id: securityRoleId,
    });
  }

  // ============================================================
  // 2FA / OTP OPERATIONS
  // ============================================================

  /**
   * Configure OTP for a user
   */
  async configureOtp(userId, otpType) {
    return this.callOne({
      action: 'configure_otp',
      user_id: userId,
      otp_type: otpType,
    });
  }

  /**
   * Configure TOTP for a user
   */
  async configureTotp(userId) {
    return this.callOne({
      action: 'configure_totp',
      user_id: userId,
    });
  }

  /**
   * Generate TOTP secret
   */
  async generateTotp(userId) {
    return this.callOne({
      action: 'generate_totp',
      user_id: userId,
    });
  }

  /**
   * Disable 2FA for a user
   */
  async disable2FA(userId) {
    return this.callOne({
      action: 'disable_2fa',
      user_id: userId,
    });
  }

  // ============================================================
  // FILE / MEDIA OPERATIONS
  // ============================================================

  /**
   * Get upload metadata for file upload
   */
  async getUploadMetadata(componentId, fileSize, fileName = null, checksum = null) {
    const operation = {
      action: 'get_upload_metadata',
      component_id: componentId,
      file_size: fileSize,
    };
    if (fileName) operation.file_name = fileName;
    if (checksum) operation.checksum = checksum;
    return this.callOne(operation);
  }

  /**
   * Complete a multipart upload
   */
  async completeMultipartUpload(componentId, uploadId, parts) {
    return this.callOne({
      action: 'complete_multipart_upload',
      component_id: componentId,
      upload_id: uploadId,
      parts,
    });
  }

  /**
   * Generate a signed URL for accessing a component
   */
  async generateSignedUrl(componentId, operation = 'get') {
    return this.callOne({
      action: 'generate_signed_url',
      component_id: componentId,
      operation,
    });
  }

  /**
   * Encode media (trigger transcoding)
   */
  async encodeMedia(componentId, options = {}) {
    return this.callOne({
      action: 'encode_media',
      component_id: componentId,
      ...options,
    });
  }

  // ============================================================
  // ENTITY CONVERSION
  // ============================================================

  /**
   * Convert an entity to a different type
   */
  async convertEntity(entityType, entityId, targetType) {
    return this.callOne({
      action: 'convert_entity',
      entity_type: entityType,
      entity_id: entityId,
      target_type: targetType,
    });
  }

  // ============================================================
  // PERMISSIONS
  // ============================================================

  /**
   * Check permissions for an entity
   */
  async permissions(entityType, entityId, actions = null) {
    const operation = {
      action: 'permissions',
      entity_type: entityType,
      entity_id: entityId,
    };
    if (actions) operation.actions = actions;
    return this.callOne(operation);
  }

  // ============================================================
  // STORAGE
  // ============================================================

  /**
   * Get storage usage information
   */
  async storageUsage(projectId = null) {
    const operation = {
      action: 'storage_usage',
    };
    if (projectId) operation.project_id = projectId;
    return this.callOne(operation);
  }

  // ============================================================
  // REVIEW SESSION
  // ============================================================

  /**
   * Send a review session invite
   */
  async sendReviewSessionInvite(reviewSessionId, email, name = null, message = null) {
    const operation = {
      action: 'send_review_session_invite',
      review_session_id: reviewSessionId,
      email,
    };
    if (name) operation.name = name;
    if (message) operation.message = message;
    return this.callOne(operation);
  }

  // ============================================================
  // RESET OPERATIONS
  // ============================================================

  /**
   * Reset remote API key
   */
  async resetRemoteApiKey(userId) {
    return this.callOne({
      action: 'reset_remote',
      user_id: userId,
      reset_type: 'api_key',
    });
  }

  /**
   * Reset remote password
   */
  async resetRemotePassword(userId) {
    return this.callOne({
      action: 'reset_remote',
      user_id: userId,
      reset_type: 'password',
    });
  }

  // ============================================================
  // DELAYED JOBS
  // ============================================================

  /**
   * Create a CSV import delayed job
   */
  async csvImportDelayedJob(data) {
    return this.callOne({
      action: 'delayed_job',
      job_type: 'csvimportdelayedjob',
      job_data: data,
    });
  }

  /**
   * Create a delete delayed job
   */
  async deleteDelayedJob(entityType, entityId) {
    return this.callOne({
      action: 'delayed_job',
      job_type: 'deletedelayedjob',
      entity_type: entityType,
      entity_id: entityId,
    });
  }

  /**
   * Export review session feedback as delayed job
   */
  async exportReviewSessionFeedbackDelayedJob(reviewSessionId, options = {}) {
    return this.callOne({
      action: 'delayed_job',
      job_type: 'exportreviewsessionfeedback',
      review_session_id: reviewSessionId,
      ...options,
    });
  }

  /**
   * Sync structure to iconik delayed job
   */
  async iconikSyncStructureDelayedJob(projectId, options = {}) {
    return this.callOne({
      action: 'delayed_job',
      job_type: 'iconiksyncstructure',
      project_id: projectId,
      ...options,
    });
  }

  /**
   * Sync LDAP users delayed job
   */
  async syncLdapUsersDelayedJob(options = {}) {
    return this.callOne({
      action: 'delayed_job',
      job_type: 'syncldapusers',
      ...options,
    });
  }

  // ============================================================
  // BATCH OPERATIONS
  // ============================================================

  /**
   * Execute multiple operations in a single transaction
   */
  async batch(operations) {
    return this.call(operations);
  }
}

export default FtrackClient;
