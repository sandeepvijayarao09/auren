# Connect Slack

Auren posts to Slack through a bot in a **demo workspace** with fictional members. Setup takes about 5 minutes.

## 1. Create the app from a manifest
1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**, and pick the demo workspace.
2. Paste this manifest:
   ```yaml
   display_information:
     name: Auren
   features:
     bot_user:
       display_name: Auren
       always_online: false
   oauth_config:
     scopes:
       bot:
         - channels:read
         - groups:read
         - chat:write
   settings:
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```
3. **Install to Workspace**, then copy the **Bot User OAuth Token** (it starts with `xoxb-`).

## 2. Add it to Auren
Put it in `Auren/.env` yourself:
```
SLACK_BOT_TOKEN=xoxb-…
```
Restart Core with `make dev`; it prints `slack live`.

## 3. Invite the bot
In each channel Auren should post to (for example `#office-hours`), type `/invite @Auren`. Auren can list every channel, but it can only post where the bot is a member, and it says so if it isn't.

## What Auren can do in Slack
| Tool | Tier | Scope |
|---|---|---|
| `list_channels` | read | `channels:read`, `groups:read` |
| `post_message` | **send**: waits for a tap signed by a paired device, and has no undo | `chat:write` |

Auren never reads message history. Every call shows up in the outbound ledger (`/v1/outbound`) as service, method and size, never the text.
