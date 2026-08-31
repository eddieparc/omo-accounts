# omo-accounts

Kiro multi-account support plus OpenGateway and TokenRouter providers for
[OMO](https://github.com/code-yeongyu/oh-my-openagent).

Kiro keeps conversations on the same account for prompt-cache affinity, places new
conversations according to remaining quota, and fails over when an account is
rate-limited or needs re-login. OpenGateway and TokenRouter use OMO's API-key
credential flow.

## Install

Requires OMO with Senpi `>= 2026.8.24`.

```bash
omo install npm:@eddieparc/senpi-accounts
```

The repository route works too:

```bash
omo install git:github.com/eddieparc/omo-accounts
```

From source:

```bash
git clone https://github.com/eddieparc/omo-accounts.git
cd omo-accounts
npm install
npm run build
```

Load a checkout directly:

```text
omo -e /absolute/path/to/omo-accounts --list-models kiro
```

## Kiro accounts

Open the account manager:

```text
/login kiro
```

It supports:

- Google, GitHub, and AWS Builder ID sign-in
- adding and removing individual accounts
- logging out every account
- pinning one account
- clearing account blocks
- `cache-first`, `balanced`, and `spread` scheduling
- `auto`, `ask`, and `never` migration policies

Select a Kiro model with `/model kiro/<model-id>`. The built-in catalog can be
extended for one run:

```bash
export KIRO_MODELS_OVERRIDE=auto,claude-sonnet-5,gpt-5.6-sol
```

Automatic catalog probing is intentionally disabled because probes consume credits
and one pooled account does not represent every account's entitlements.

## OpenGateway and TokenRouter

OpenGateway is always registered so `/login opengateway` can collect its API key:

```text
/login opengateway
```

TokenRouter registers after a credential exists. Set `TOKENROUTER_API_KEY`, or use
the provider login flow in a run where it is explicitly loaded:

```text
/login tokenrouter
```

The bundled catalogs expose OpenGateway's Kimi K3 Ultrafast and TokenRouter's Kimi,
DeepSeek, Qwen, and GLM routes.

## Commands

| Command | Purpose |
|---|---|
| `/login kiro` | Manage Kiro accounts and routing settings |
| `/usage` | Show remaining Kiro usage and account state |
| `/omo-accounts` | Show extension health |

## Storage and diagnostics

Credentials live in OMO's `~/.omo/agent/auth.json`, written atomically with `0600`
permissions. Set `OMO_CODING_AGENT_DIR` to override that directory.
`SENPI_CODING_AGENT_DIR` remains a legacy fallback.

Set `KIRO_DEBUG=1` for redacted protocol diagnostics under
`$OMO_CODING_AGENT_DIR/debug/debug.log`. Credentials and authorization headers are
redacted, and logging is off by default.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Publishing

The repository is `eddieparc/omo-accounts`; the existing npm package remains
[`@eddieparc/senpi-accounts`](https://www.npmjs.com/package/@eddieparc/senpi-accounts)
so installed configurations keep working. GitHub Actions trusted publishing must
therefore authorize the `eddieparc/omo-accounts` repository.

## License

MIT
