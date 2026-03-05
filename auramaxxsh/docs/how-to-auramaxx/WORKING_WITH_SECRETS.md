# Working With Secrets

Use this guide to read, write, and inject secrets without pasting plaintext credentials into prompts or code.  
Start with `get`, `set`, and `list`, then use `inject` for controlled command execution.

## Getting Secrets

In local socket mode, `auramaxx get` confirms the credential can be decrypted (`SECRET DECRYPTED`), but it does **not** export an env var into your parent shell.
Use `auramaxx inject` when you want a value available to a command.

```bash
# local socket read: verifies/decrypts
auramaxx get DONTLOOK

# command-scoped injection (recommended)
auramaxx get DONTLOOK -- printenv AURA_DONTLOOK

# unsafe plaintext debug output (prints secret in terminal)
auramaxx get DONTLOOK --danger-plaintext

# custom env var name:
auramaxx inject DONTLOOK --env AURA_DONTNOTE -- printenv AURA_DONTNOTE
```

With explicit token auth (for example `AURA_TOKEN=...`), `auramaxx get` can print primary fields or full payloads. Use flags for specific fields or full payloads:

```bash
auramaxx get OURSECRET                     # primary value field only
auramaxx get OURSECRET --field username    # specific field
auramaxx get OURSECRET --json              # full credential payload
auramaxx get OURSECRET --totp              # current TOTP code only
auramaxx get OURSECRET --agent primary     # restrict match to a agent
auramaxx get OURSECRET                     # if name is ambiguous, first match is selected by default
auramaxx get OURSECRET --first             # compatibility flag (same behavior)
auramaxx get OURSECRET --reqId <reqId>     # retry with claimed one-shot approval token
```

## Setting Secrets

### Fast Path

```bash
auramaxx set OURSECRET 123
```

### Helper Flags

```bash
# set explicit type/field
auramaxx set GITHUB_LOGIN hunter2 --type login --field password

# attach tags
auramaxx set STRIPE_KEY sk_live_123 --type apikey --tags prod,api

# set extra structured fields
auramaxx set GITHUB_LOGIN hunter2 --type login --field password --username alice
```

MCP path:

- call `put_secret` with `name: "OURSECRET"` and `value: "123"`

## Listing Secrets

### Fast Path

```bash
auramaxx list
```

### Helper Flags

```bash
# filter by credential name/title substring
auramaxx list --name github

# filter by field key/value substring (best effort; reads credential payloads)
auramaxx list --field token

# filter by agent name or id
auramaxx list --agent primary
auramaxx list --agent agent-2

# combine filters + structured output
auramaxx list --agent primary --name github --json
```

MCP path:

- call `list_secrets`

## If It Fails

1. Check runtime health: `auramaxx status`
2. If agent is locked: unlock in dashboard (`http://localhost:4747`) or run `auramaxx unlock`
3. If MCP call gets permission denied: follow [AGENT_SETUP.md](../quickstart/AGENT_SETUP.md), then [AUTH.md](../ai-agents-workflow/AUTH.md)
