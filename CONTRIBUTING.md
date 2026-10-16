# Contributing to SpaceApp

Advanced API settings are documented in the [configuration reference](docs/configuration-reference.md).

Use a checkout you own. Do not run development tests against an installed
operator instance or reuse its credentials, browser profiles, sockets or data.

## Development prerequisites

The monorepo requires Node **>=22.12 <23**, as declared in the root
`package.json`, and npm. Linux is the reference development environment;
Windows contributors can use WSL. Building `node-pty` may require Python 3,
Make and a C++ compiler if a compatible prebuilt binary is unavailable.

The `run-spaceapp` installer is a separate package with its own host Node
requirement. Installing the application and developing this monorepo have
different prerequisites; consult the selected installer's `engines` field.

From the repository root, install the locked dependencies:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
```

Skipping the Electron download is suitable for core development. Desktop
packaging requires its normal toolchain and separate platform acceptance.
Dependency installation may use the network; the smoke command below does not
need a provider account, API key, Docker, PostgreSQL or Temporal.

## Run the full app from source

Use Node from `.nvmrc` (22.x), npm, and Docker Engine with Compose v2 on
Linux. Native dependencies may need Python 3, Make and a C++ compiler
(`python3 make g++` on Debian/Ubuntu). The complete test suite also uses the
`sqlite3` CLI (`apt install sqlite3`, or `brew install sqlite` on macOS). Docker must be running and accessible to
your user. No provider credentials are needed to open OpenCode's terminal UI;
using a model may require provider access. Desktop packaging is separate.

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run dev:stack
```

The launcher reads PostgreSQL/pgvector and Temporal image digests from the
installer's Compose template. It starts those containers, installs the
Dockerfile-pinned OpenCode CLI under `.dev-stack/opencode`, builds the source,
runs migrations, and starts the CLI host, worker, API watcher and Vite. It waits
for `/readyz` and the web page before printing the URL and owner setup token.
Enter that token in the browser, register the owner, and sign in. Development
login is explicitly disabled. Open Getting Started and add an OpenCode pane.

All published ports bind to `127.0.0.1`:

| Service | Default port | Override |
| --- | --- | --- |
| API | 4912 | `SPACE_DEV_API_PORT` |
| Vite | 4913 | `SPACE_DEV_WEB_PORT` |
| PostgreSQL | 55432 | `SPACE_DEV_DB_PORT` |
| Temporal | 57233 | `SPACE_DEV_TEMPORAL_PORT` |

Ports must be distinct integers from 1024 through 65535 and free before startup.
The checkout has its own Compose project derived from its absolute path and its
own git-ignored `.dev-stack/`. Credentials are generated once with mode 0600,
and state directories use mode 0700. Only the setup token is printed; do not
paste it into issue comments or CI logs. The token expires after 15 minutes;
restart the stack to renew its bootstrap window before the owner is claimed.
Owner credentials and database state survive `down`.

API source edits restart the API; frontend edits trigger Vite HMR. After changing
workspace packages, rebuild and restart from a second terminal with one command:

```sh
npm run dev:stack -- rebuild
```

The original supervisor exits; the rebuild command becomes the new foreground
supervisor. It retains the isolated database and credentials. For lifecycle
commands, use the same checkout and port overrides:

```sh
npm run dev:stack -- down   # stop source process groups and Docker services
npm run dev:stack -- reset  # also delete owned volumes and .dev-stack state
```

Ctrl+C stops source processes; use `down` to stop the retained containers too.
An unexpected service exit is reported by name and stops the other source
services with a nonzero exit status. Cleanup targets this checkout's process
groups and Compose project; it does not search for or kill installed instances.
Reset refuses unrecognized or symlinked state. Do not move a checkout while its
stack is running, or delete its state directory manually.

### Platform notes and troubleshooting

- **Linux:** verify `docker version` and `docker compose version`. If a port is
  busy, choose the corresponding override; do not stop an installed SpaceApp.
- **macOS:** use Docker Desktop or Colima with a working Docker context and
  Compose v2. Install the Xcode command-line tools for native npm modules.
- **Windows 11:** use WSL2 with a Linux distribution, Node and npm installed
  inside it, and Docker Desktop WSL integration (or a Docker daemon in WSL).
  Clone into the Linux filesystem, such as `~/src/spaceapp`, rather than
  `/mnt/c`, to preserve Unix permissions, sockets and watcher behavior.
  Native Windows PowerShell is not supported by this Unix process supervisor.

Check the first failing service output, Docker health status and disk space.
Temporal initialization can take a minute on first boot. Internal Docker gRPC
traffic is excluded from HTTP proxies. Dependency downloads still require the
npm registry and the pinned Docker registries. If installation failed, rerun
`npm ci` with the pinned Node version before starting again. A stale control
socket after a killed supervisor requires investigation of that checkout's
remaining processes before removing it; avoid broad `pkill` commands.

The destructive integration check requires a fresh `.dev-stack` and runs real
Docker services, owner setup, CLI session creation, terminal output, reloads and
cleanup:

```sh
node scripts/dev-stack-integration.mjs
node scripts/dev-stack-integration.mjs --worker-failure
node scripts/dev-stack-integration.mjs --rebuild
```

Containers used as development machines need an init that reaps orphaned
subprocesses. If PID 1 does not do that, run the supervisor and integration
checks under `tini -s --` (or the Docker-provided `docker-init -s --`), for
example `docker-init -s -- node scripts/dev-stack-integration.mjs`. The cleanup
check requires the owned process tree and groups to disappear; dead zombie
processes are not treated as a passing cleanup result. Normal desktop/VM hosts
already provide init. This does not require running Docker services as root on
the host.

The Ubuntu CI job runs these checks without a TTY. Linux cloud validation does
not establish a macOS or WSL2 run; attach actual terminal evidence from at least
one of those platforms before submitting a solution to issue #65.

## First executed task, without a provider

```sh
npm run smoke:offline
```

This builds the CLI host and runs an explicitly **simulated runtime** through
the real Unix socket protocol and a real PTY child. It submits two arithmetic
tasks, checks their results, reconnects without replacing the process, and
resubmits an input key to verify duplicate suppression within that host's
retained session. The child receives an allowlisted environment. Its process,
socket and temporary directory are removed before success is reported.

Success is a JSON record with `mode: "SIMULATED_RUNTIME"`, `passed: true` and
`cleaned: true`. A wrong answer or early child exit fails the command. This is
a contributor transport/acceptance check, not evidence of AI quality, provider
authentication, native task resume, browser behavior or crash durability.

Unix socket paths are short. If your inherited `TMPDIR` is deeply nested,
select a short temporary directory you own and set `TMPDIR` for the command.
On Windows run this particular smoke check inside WSL or a Linux development
container. It does not certify the Windows/macOS installer.

## Make and verify a small change

Work on a branch, not on `main`, so the change can become a pull request:

```sh
git switch -c my-change
```

For example, change the synthetic task's result handling in
`scripts/fixtures/offline-cli.mjs`, then run:

```sh
npm run test:contributor
npm run check
```

The contributor regression tests reject incorrect task output and early process
exit, and check cleanup after both. Restore the intended behavior before
submitting a change. Use the tests for the affected workspace as well; the
offline smoke is not a substitute for them.

## Checks before a commit

After `npm ci`, these commands work in this order, also on a fresh clone:

```sh
npm run check
npm test
npm run build
npm run hygiene:preflight
```

`npm run check` runs the dependency boundary check, builds the internal
`@space/*` packages in dependency order and then type-checks the apps, so it
does not need an earlier `npm run build`. `npm test` builds the internal
packages and runs the test suites in this checkout. `npm run build` also builds
the API, worker and web app. Run `npm run hygiene:preflight` before every
commit: it fails on untracked files and on staged runtime, secret, dependency,
generated or report paths. Commit from your branch; older releases of this
check also refuse to run on `main`.

Opt-in database and authenticated provider proofs require separate isolated
fixtures; skipped proofs are not passing evidence.

In the maintainers' source repository, `npm run check:claims` compares the
version, licence, Node requirement, runtime list and key constants stated in
the README and `docs/` with the code, and rejects unqualified latency or
isolation claims; maintainers run it when a change touches any of them. Current
results and known failures are indexed there in `docs/quality/README.md`, and
its `AGENTS.md` describes the guidance to read before changing session
attachment, room retention, control, readiness, polling or deployment.

Keep changes reviewable and include the exact commands and limitations of your
verification. Never include credentials, private transcripts or local runtime
state in a contribution.
