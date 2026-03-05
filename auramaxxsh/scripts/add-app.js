#!/usr/bin/env node
/**
 * Add a app to the AuraMaxx dashboard via WebSocket.
 *
 * Usage:
 *   node scripts/add-app.js <appType> [options]
 *
 * Examples:
 *   # Inline dynamic app
 *   node scripts/add-app.js dynamic --code "function Hi() { return <div>Hello</div>; }"
 *
 *   # File-based dynamic app (agents: use tmp/, then rm after)
 *   node scripts/add-app.js dynamic --file tmp/app.jsx --id "my-app"
 *
 *   # Iframe app
 *   node scripts/add-app.js iframe --url "https://example.com" --title "My Chart"
 *
 *   # Built-in apps
 *   node scripts/add-app.js wallets
 *   node scripts/add-app.js logs --x 400 --y 100
 *
 *   # Custom app (from src/components/apps/custom/)
 *   node scripts/add-app.js custom:ExampleApp --message "Hello"
 *
 *   # Position and size
 *   node scripts/add-app.js iframe --url "https://example.com" --x 100 --y 200 --width 500 --height 400
 *
 *   # Target a specific workspace
 *   node scripts/add-app.js logs --workspace "home"
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const WS_BASE_URL = process.env.WORKSPACE_WS_URL || 'ws://localhost:4748';
const AUTH_TOKEN = process.env.AURA_TOKEN;

// Build WebSocket URL with optional token
function getWsUrl() {
  if (AUTH_TOKEN) {
    return `${WS_BASE_URL}?token=${encodeURIComponent(AUTH_TOKEN)}`;
  }
  return WS_BASE_URL;
}

// Parse command line arguments
function parseArgs(args) {
  const result = { _: [] };
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];

      if (next && !next.startsWith('--')) {
        // Try to parse as number
        const num = parseFloat(next);
        result[key] = isNaN(num) ? next : num;
        i += 2;
      } else {
        result[key] = true;
        i += 1;
      }
    } else {
      result._.push(arg);
      i += 1;
    }
  }

  return result;
}

function printUsage() {
  console.log(`
Usage: node scripts/add-app.js <appType> [options]

Authentication:
  Set AURA_TOKEN env var with a valid token that has workspace:modify permission.
  Example: export AURA_TOKEN="your-agent-token"

App Types:
  Built-in (singleton):
    wallets, logs, send, agentKeys, status, launch

  Multi-instance:
    iframe      --url <url> [--title <title>]
    dynamic     --code <code> | --file <path>
    custom:*    --<key> <value> (passed as config)

Options:
  --id <id>           Custom app ID (for multi-instance apps)
  --workspace <id>    Target workspace ID (default: active workspace)
  --x <number>        X position (default: 20)
  --y <number>        Y position (default: 20)
  --width <number>    App width
  --height <number>   App height

Examples:
  # Set token first
  export AURA_TOKEN="your-agent-token"

  # Inline dynamic app
  node scripts/add-app.js dynamic --code "function Hi() { return <div>Hello</div>; }"

  # File-based dynamic app (use tmp/, then rm after)
  node scripts/add-app.js dynamic --file tmp/app.jsx --id "my-app"

  # Iframe
  node scripts/add-app.js iframe --url "https://dexscreener.com/base/0x123"

  # Built-in apps
  node scripts/add-app.js wallets --x 400 --y 100

  # Custom app (from src/components/apps/custom/)
  node scripts/add-app.js custom:ExampleApp --message "Hello"
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appType = args._[0];

  if (!appType || args.help) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  // Build config from remaining args
  const config = {};
  const reserved = ['_', 'id', 'workspace', 'x', 'y', 'width', 'height', 'file', 'code', 'url', 'title'];

  // Handle specific app types
  if (appType === 'iframe') {
    if (!args.url) {
      console.error('Error: iframe app requires --url');
      process.exit(1);
    }
    config.url = args.url;
    if (args.title) config.title = args.title;
  } else if (appType === 'dynamic') {
    if (args.file) {
      const filePath = path.resolve(args.file);
      if (!fs.existsSync(filePath)) {
        console.error(`Error: File not found: ${filePath}`);
        process.exit(1);
      }
      config.code = fs.readFileSync(filePath, 'utf-8');
    } else if (args.code) {
      config.code = args.code;
    } else {
      console.error('Error: dynamic app requires --code or --file');
      process.exit(1);
    }
  } else {
    // Pass through any non-reserved args as config
    for (const [key, value] of Object.entries(args)) {
      if (!reserved.includes(key)) {
        config[key] = value;
      }
    }
  }

  // Connect to WebSocket with optional authentication
  const wsUrl = getWsUrl();
  const ws = new WebSocket(wsUrl);

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    console.log('Make sure the Next.js app is running on port 4748');
    if (!AUTH_TOKEN) {
      console.log('Tip: Set AURA_TOKEN env var for authenticated mutations');
    }
    process.exit(1);
  });

  ws.on('open', () => {
    // Request current workspace state
    ws.send(JSON.stringify({
      type: 'workspace:state:request',
      timestamp: Date.now(),
      source: 'agent',
      data: { requestId: 'add-app-script' }
    }));
  });

  ws.on('message', (rawData) => {
    const msg = JSON.parse(rawData.toString());

    // Handle permission errors
    if (msg.type === 'error') {
      console.error('Error:', msg.error);
      if (msg.error.includes('Permission denied')) {
        console.log('Tip: Set AURA_TOKEN env var with a token that has workspace:modify permission');
      }
      ws.close();
      process.exit(1);
    }

    if (msg.type === 'workspace:state:response') {
      const workspaceId = args.workspace || msg.data.activeWorkspaceId;

      const appData = {
        workspaceId,
        appType,
        x: args.x || 20,
        y: args.y || 20
      };

      if (args.id) appData.id = args.id;
      if (args.width) appData.width = args.width;
      if (args.height) appData.height = args.height;
      if (Object.keys(config).length > 0) appData.config = config;

      // Wait for token validation to complete (race condition workaround)
      // The server validates tokens asynchronously, so we need a brief delay
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'app:added',
          timestamp: Date.now(),
          source: 'agent',
          data: appData
        }));

        // Wait for potential error response, then assume success
        setTimeout(() => {
          console.log('App added:', appType);
          if (args.id) console.log('  ID:', args.id);
          console.log('  Workspace:', workspaceId);
          console.log('  Position:', `(${appData.x}, ${appData.y})`);
          if (Object.keys(config).length > 0) {
            console.log('  Config:', JSON.stringify(config, null, 2).split('\n').map((l, i) => i === 0 ? l : '    ' + l).join('\n'));
          }
          ws.close();
          process.exit(0);
        }, 300);
      }, 150);
    }
  });
}

main();
