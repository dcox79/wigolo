# Hardened local Docker run

This path runs the code in your checked-out, reviewed fork. It does not run
`npx`, invoke `wigolo init`, pull `ghcr.io/knockoutez/wigolo:latest`, or mount
your Windows home directory into the container.

> A container is a containment boundary, not a vulnerability fix. Run the
> dependency audit and tests before building, and rebuild the image whenever
> `package-lock.json` or the pinned base-image digest changes.

## What the hardened profile does

[`packaging/compose.serve.yml`](../packaging/compose.serve.yml) builds the local
working tree as `wigolo-local:reviewed` and applies these runtime controls:

- UID/GID `1000:1000`, all Linux capabilities dropped, and no new privileges;
- a read-only root filesystem, with only `/data`, `/tmp`, and `/dev/shm`
  writable;
- a Docker named volume for cache, models, browser binaries, and configuration;
- an in-memory, `noexec` `/tmp` and bounded process, memory, CPU, and log usage;
- host publishing on `127.0.0.1` only;
- mandatory bearer authentication, delivered as a Compose secret file;
- private/loopback fetches, startup engine probes, remote local-target access,
  and telemetry disabled;
- hybrid search backed by a pinned, internal-only SearXNG container, automatic
  per-domain TLS hardening, eager local-model warmup, and runtime-injected
  synthesis credentials;
- third-party plugin loading pointed at a nonexistent, read-only directory;
- a `/health` probe for Docker health reporting.

The application listens on `0.0.0.0` *inside* its isolated container network so
Docker can forward the port. The host-side mapping remains
`127.0.0.1:3333`; other computers cannot connect to it.

## Windows Docker Desktop

Use Linux containers. From a PowerShell window at the repository root, create a
token file outside the repository. Docker Desktop supports file-backed Compose
secrets consistently, and the token is mounted read-only rather than exposed in
the container environment. First verify that the production lock has no high or
critical advisory (this audit mode does not install packages or run lifecycle
scripts), then start the reviewed local build:

```powershell
$secretDir = Join-Path $env:LOCALAPPDATA 'wigolo\secrets'
New-Item -ItemType Directory -Force $secretDir | Out-Null
$env:WIGOLO_API_TOKEN_SECRET_FILE = Join-Path $secretDir 'docker-api-token'

$tokenBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
$token = [Convert]::ToHexString($tokenBytes).ToLowerInvariant()
[IO.File]::WriteAllText($env:WIGOLO_API_TOKEN_SECRET_FILE, $token)
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $env:WIGOLO_API_TOKEN_SECRET_FILE /inheritance:r /grant:r "${currentUser}:(R,W)" | Out-Null

npm audit --package-lock-only --omit=dev --audit-level=high
docker compose -f .\packaging\compose.serve.yml up --build -d
docker compose -f .\packaging\compose.serve.yml ps
```

Do not proceed when the audit command exits nonzero for a high or critical
production finding. Advisory data changes over time, so repeat it before every
rebuild even when the lockfile has not changed.

The service cannot start if `WIGOLO_API_TOKEN_SECRET_FILE` is missing or points
to a nonexistent file: Compose cannot mount the required secret, and Wigolo's
non-loopback bind gate also fails closed on an empty token. Compose mounts the
file at `/run/secrets/wigolo_api_token`; the token is not baked into the image
or copied into the container environment. Keep the host file private and do not
commit it.

Before `docker compose up`, configure the synthesis provider in the same
PowerShell session. Gemini is the optimized default:

```powershell
$env:WIGOLO_LLM_PROVIDER = "gemini"
$env:WIGOLO_LLM_MODEL_GEMINI = "gemini-3.1-flash-lite-preview"
$env:GEMINI_API_KEY = Read-Host "Gemini API key"

# Optional: lifts GitHub code search from 10 to 30 requests per minute.
$env:WIGOLO_GITHUB_TOKEN = Read-Host "GitHub token"
```

For Anthropic, OpenAI, or Groq, set `WIGOLO_LLM_PROVIDER` accordingly and set
the matching `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GROQ_API_KEY`. For a
keyless local provider, use `WIGOLO_LLM_PROVIDER=ollama`; when Ollama runs on
the Windows host, make sure its endpoint is reachable from Docker rather than
assuming the container's `localhost` points at the host.

Provider credentials are passed into the container at creation time because
Wigolo reads these provider-specific environment variables. They are not added
to the image or repository, but Docker administrators can inspect container
environment variables. Use narrowly scoped tokens and recreate the container
after rotating them.

Verify the unauthenticated health endpoint and an authenticated API endpoint:

```powershell
Invoke-RestMethod http://127.0.0.1:3333/health
$token = (Get-Content -Raw -LiteralPath $env:WIGOLO_API_TOKEN_SECRET_FILE).Trim()
Invoke-WebRequest http://127.0.0.1:3333/openapi.json `
  -Headers @{ Authorization = "Bearer $token" } `
  -UseBasicParsing
```

MCP clients use `http://127.0.0.1:3333/mcp` and the same
`Authorization: Bearer <token>` header. Legacy SSE clients use `/sse`.

To view logs or stop the service, keep using the same PowerShell session so
Compose can resolve the secret definition:

```powershell
docker compose -f .\packaging\compose.serve.yml logs -f wigolo
docker compose -f .\packaging\compose.serve.yml down
```

`down` preserves the `wigolo-data` volume. Do not add `--volumes` unless you
intend to delete the cached pages, models, browser binary, stored config, and
SearXNG state.

### Optional settings

These PowerShell variables are consumed by the Compose file:

```powershell
$env:WIGOLO_HOST_PORT = "3334"       # host remains 127.0.0.1 only
$env:WIGOLO_MEMORY_LIMIT = "3g"
$env:WIGOLO_CPU_LIMIT = "3.0"
$env:WIGOLO_DOCKER_TARGET = "full"   # browser binary baked into the image
$env:WIGOLO_SEARCH = "core"          # opt out of the hybrid retrieval funnel
$env:WIGOLO_TLS_TIER = "off"         # opt out of learned TLS hardening
$env:WIGOLO_EAGER_WARMUP = "0"       # return to lazy model initialization
```

The default `default` target downloads the Playwright browser binary and local
models into `wigolo-data` on first use. The `full` target installs the browser
binary at image-build time but still downloads models when first required.

## Local stdio MCP instead of HTTP

For one MCP client, build once and make Docker itself the MCP command. This
also avoids `npx` and does not publish a network port:

```powershell
docker build --pull --target default -t wigolo-local:reviewed .
docker run --rm -i --init --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m --mount type=volume,src=wigolo-data,dst=/data wigolo-local:reviewed mcp
```

A JSON-based MCP host can use the same exact command:

```json
{
  "mcpServers": {
    "wigolo": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i", "--init", "--read-only",
        "--user", "1000:1000", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=256m",
        "--mount", "type=volume,src=wigolo-data,dst=/data",
        "wigolo-local:reviewed", "mcp"
      ]
    }
  }
}
```

## Boundary and operating rules

- Do not mount the Docker socket, your browser profile, your home directory, or
  cloud-credential directories into this container.
- Do not enable CDP/browser-profile authentication or install third-party
  Wigolo plugins until those components have been reviewed separately. The
  hardened profile disables plugin discovery with `WIGOLO_PLUGINS_DIR`.
- Keep `WIGOLO_FETCH_ALLOW_PRIVATE`, `WIGOLO_SERVE_ALLOW_LOCAL_TARGETS`, and
  `WIGOLO_SERVE_ALLOW_UNAUTHENTICATED` disabled.
- Keep `WIGOLO_WARM_ENGINES=0` if you do not want outbound engine probes before
  the first user-requested search. Search requests still contact their selected
  search engines normally.
- The container needs outbound internet access to search and fetch pages.
  Containerization does not stop a malicious dependency from making outbound
  requests, so dependency pinning and audit remediation still matter.
- Treat the `wigolo-data` volume as sensitive: it can contain browsing cache,
  configuration, and encrypted credential material.
