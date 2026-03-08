# ftrack MCP Server

A Model Context Protocol (MCP) server that provides AI assistants (like Claude) with full access to the ftrack production tracking API. This enables natural language interactions with your ftrack workspace - query projects, manage tasks, update statuses, and more.

## Prerequisites

- **Node.js** 18 or higher
- **ftrack account** with API access
- **MCP-compatible client** (Claude Desktop, Cursor, VS Code with Claude extension, etc.)

> **Note:** This project was developed and tested on Windows. It should work on macOS and Linux but hasn't been tested on those platforms yet. If you encounter issues, please open an issue on GitHub.

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/VFX-Tools-LLC/ftrack-mcp.git
cd ftrack-mcp
```

### 2. Install dependencies

```bash
npm install
```

### 3. Get your ftrack API credentials

1. Log into your ftrack workspace
2. Go to **Settings** > **API Keys** (or click your avatar > Settings > API Keys)
3. Create a new API key or use an existing one
4. Note down:
   - Your **ftrack server URL** (e.g., `https://your-workspace.ftrackapp.com`)
   - Your **username**
   - Your **API key**

## Configuration

### Step 1: Set Credentials

**Option A: `.env` file (easiest for local development)**

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

```ini
FTRACK_SERVER=https://your-workspace.ftrackapp.com
FTRACK_API_USER=your-username
FTRACK_API_KEY=your-api-key
```

The `.env` file is automatically loaded at startup and is excluded from git.

**Option B: System Environment Variables (recommended for production)**

The most secure approach is to set your credentials as system environment variables. The MCP server reads from these automatically.

**Windows (PowerShell - run as Administrator):**
```powershell
[System.Environment]::SetEnvironmentVariable('FTRACK_SERVER', 'https://your-workspace.ftrackapp.com', 'User')
[System.Environment]::SetEnvironmentVariable('FTRACK_API_USER', 'your-username', 'User')
[System.Environment]::SetEnvironmentVariable('FTRACK_API_KEY', 'your-api-key', 'User')
```

**Windows (GUI):** Settings → System → About → Advanced system settings → Environment Variables

**macOS/Linux (~/.bashrc or ~/.zshrc):**
```bash
export FTRACK_SERVER="https://your-workspace.ftrackapp.com"
export FTRACK_API_USER="your-username"
export FTRACK_API_KEY="your-api-key"
```

After setting environment variables, restart your terminal/IDE.

### Step 2: Configure Your MCP Client

#### Claude Desktop

Edit your config file:
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ftrack": {
      "command": "node",
      "args": ["C:/path/to/ftrack-mcp/src/index.js"]
    }
  }
}
```

#### Cursor / VS Code

Add to your MCP settings or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ftrack": {
      "command": "node",
      "args": ["/absolute/path/to/ftrack-mcp/src/index.js"]
    }
  }
}
```

**Note:** Use forward slashes (`/`) even on Windows.

### Alternative: Credentials in Config (Less Secure)

If you can't set system environment variables, you can pass them through the MCP config:

```json
{
  "mcpServers": {
    "ftrack": {
      "command": "node",
      "args": ["C:/path/to/ftrack-mcp/src/index.js"],
      "env": {
        "FTRACK_SERVER": "https://your-workspace.ftrackapp.com",
        "FTRACK_API_USER": "your-username",
        "FTRACK_API_KEY": "your-api-key"
      }
    }
  }
}
```

⚠️ **Warning:** This stores credentials in a config file. Make sure this file is not committed to version control.

### Running Standalone (for testing)

```bash
npm start
```

## Usage Examples

Once configured, you can ask Claude to interact with ftrack using natural language:

- *"List all my ftrack projects"*
- *"Show me tasks assigned to John on the Marvel project"*
- *"Create a new task called 'Final Review' under shot SH010"*
- *"Update the status of task XYZ to 'In Progress'"*
- *"What's the storage usage for my workspace?"*
- *"List all versions for the compositing task"*

## Available Tools (55+)

### Query Operations
| Tool | Description |
|------|-------------|
| `ftrack_query` | Execute ftrack query language expressions |
| `ftrack_parse_query` | Validate a query without executing |
| `ftrack_query_schemas` | Get all available entity schemas |
| `ftrack_query_server_information` | Get server version and config |
| `ftrack_search` | Full-text search across entities |

### CRUD Operations
| Tool | Description |
|------|-------------|
| `ftrack_create` | Create any entity type |
| `ftrack_update` | Update entity attributes |
| `ftrack_delete` | Delete entities |
| `ftrack_batch` | Execute multiple operations atomically |

### Convenience Tools
| Tool | Description |
|------|-------------|
| `ftrack_list_projects` | List all projects |
| `ftrack_list_tasks` | List tasks with filters |
| `ftrack_list_users` | List all users |
| `ftrack_list_asset_versions` | List versions for a task/asset |
| `ftrack_list_statuses` | List available statuses |
| `ftrack_list_types` | List task/object types |
| `ftrack_list_priorities` | List priorities |
| `ftrack_get_entity` | Get single entity by ID |
| `ftrack_create_note` | Add a note to any entity |
| `ftrack_list_notes` | List notes on an entity |
| `ftrack_update_task_status` | Change task status |
| `ftrack_assign_user_to_task` | Assign user to task |
| `list_shots` | List shots for a project or sequence |
| `list_asset_builds` | List asset builds for a project |
| `get_project_structure` | Get top-level hierarchy of a project |
| `list_user_assignments` | List all tasks assigned to a user |
| `list_milestones` | List milestones for a project |

### User & Security Management
| Tool | Description |
|------|-------------|
| `ftrack_add_user_security_role` | Add security role to user |
| `ftrack_remove_user_security_role` | Remove security role |
| `ftrack_grant_user_security_role_project` | Grant project access |
| `ftrack_revoke_user_security_role_project` | Revoke project access |
| `ftrack_assume_user` | Impersonate user (admin) |
| `ftrack_send_user_invite` | Send invitation email |
| `ftrack_list_security_roles` | List all security roles |

### File & Media Operations
| Tool | Description |
|------|-------------|
| `ftrack_get_upload_metadata` | Get upload parameters |
| `ftrack_complete_multipart_upload` | Complete chunked upload |
| `ftrack_generate_signed_url` | Get download/upload URL |
| `ftrack_encode_media` | Trigger media transcoding |
| `ftrack_storage_usage` | Get storage statistics |

### Review Sessions
| Tool | Description |
|------|-------------|
| `ftrack_list_review_sessions` | List review sessions |
| `ftrack_send_review_session_invite` | Invite to review |

### API Key Management
| Tool | Description |
|------|-------------|
| `ftrack_grant_api_key_project` | Grant API key project access |
| `ftrack_revoke_api_key_project` | Revoke API key access |
| `ftrack_grant_api_key_security_role` | Add role to API key |
| `ftrack_revoke_api_key_security_role` | Remove role from API key |

### 2FA/Authentication
| Tool | Description |
|------|-------------|
| `ftrack_configure_otp` | Configure OTP |
| `ftrack_configure_totp` | Configure TOTP |
| `ftrack_generate_totp` | Generate TOTP secret |
| `ftrack_disable_2fa` | Disable 2FA |
| `ftrack_reset_remote_api_key` | Reset API key |
| `ftrack_reset_remote_password` | Reset password |

### Delayed Jobs (Background Tasks)
| Tool | Description |
|------|-------------|
| `ftrack_csv_import_delayed_job` | Import CSV data |
| `ftrack_delete_delayed_job` | Batch delete |
| `ftrack_export_review_session_feedback_delayed_job` | Export feedback |
| `ftrack_iconik_sync_structure_delayed_job` | Sync to iconik |
| `ftrack_sync_ldap_users_delayed_job` | Sync LDAP users |

## ftrack Query Language Examples

The `ftrack_query` tool accepts ftrack's query language:

```sql
-- List all active projects
select id, name, status from Project where status is "active"

-- Get tasks assigned to a user
select id, name, status.name from Task
where assignments any (resource.username is "john")

-- Find shots in a sequence
select id, name from Shot where parent.name is "SEQ010"

-- Get latest versions for a task
select id, version, date, user.username from AssetVersion
where task_id is "abc-123" order by version descending

-- Search with wildcards
select id, name from Project where name like "%marvel%"
```

## Troubleshooting

### "Failed to initialize ftrack client"
- Verify your environment variables are set correctly
- Check that your API key is valid and not expired
- Ensure your ftrack server URL includes `https://`

### "Connection refused" or timeout errors
- Check your network connection to ftrack
- Verify the server URL is correct
- Check if your workspace is accessible

### "Permission denied" errors
- Your API key may not have sufficient permissions
- Contact your ftrack administrator to adjust your security role

## Security Notes

- **Never commit your API credentials** to version control
- Use environment variables or secure secret management
- API keys have the same permissions as the user - use dedicated service accounts for automation
- Consider using project-scoped API keys for limited access

## License

ISC

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.
