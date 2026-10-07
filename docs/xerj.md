# Root-wide source discovery

XERJ is optional. Install it with `gestalt xerj install`, then start Mobile:

```sh
gestalt mobile -- --cwd /path/to/source-root
```

`manual` is the default when launched through Mobile's CLI. It starts or discovers
the retrieval backend but does not scan source files, create an ignore file, or
start a watcher. Existing indexes remain available and unchanged; an empty index
provides no source results until explicitly populated. New files, edits and
deletions are not reflected until an operator runs indexing.

`--xerj auto` explicitly opts into background indexing and watching, including the
rc.87 incremental-addition limitation described below. `--xerj off` disables
Mobile's XERJ integration. An absent XERJ does not prevent startup. These use Mobile's existing CLI
configuration, not a separate service configuration file. The manager must be on
PATH (or selected by `GESTALT_MANAGER_BIN`). Automatic watching currently requires Linux util-linux
`flock` and `setpriv`; other hosts can use manual retrieval mode. The host account, not an
agent session, needs write access to the source root for the initial ignore file
and to the managed runtime directory.

Mobile uses its canonical `--cwd` root, including repositories beneath it, rather
than each session's selected workspace. In `auto` mode it starts indexing in a child process
without blocking startup. The existing Gestalt manager discovers or starts the
authenticated loopback backend. All workspaces share `$CODEX_HOME/xerj-data`
(default `~/.codex-gestalt/xerj-data`). Each source root has a stable namespace
`ax-<first 16 hex characters of SHA-256 of canonical root>` and native journal at
`xerj-data/autoindex/<namespace>`. Roots do not overwrite each other's catalogs.

The manager holds a kernel file lock for the lifetime of `autoindex --watch`.
Another watcher for that namespace exits with code 75; Mobile reports that the
root is owned elsewhere, without claiming to know its progress. Graceful Mobile
shutdown terminates only its own watcher, with a bounded kill fallback. It does
not stop the shared backend or remove persistent data. A parent-death signal also terminates the watcher when its Mobile owner dies.
Journal locks and watcher
locks are released by the OS when their processes exit.

## Indexing and scope

XERJ's native watcher performs the initial pass and handles changes and deleted
files within indexed repositories. Initial indexing includes all repositories
below the root. New directories are watched, but rc.87 can refuse newly added files or
repositories when its frozen datasets match ambiguously; Mobile reports a stale
index and an upstream limitation. It does not silently rebuild a large source tree. Mobile uses `--no-graph` because rc.87 requires it
for addition/deletion reconciliation, and `--no-semantic` to avoid model downloads.
Two workers, one PDF worker, 4 MB bulks and a two-second quiet period limit activity.
The per-file cap is 1 GB, the smallest whole-GB limit rc.87 supports. XERJ rejects
binary input. No independent index queue, crawler, database or polling rescan is
added by Gestalt.

Restart reuses native journals and committed generations. XERJ still walks and
hashes on the initial pass after restart. Changed generations can prepare substantial
parts of the corpus; this is not a promise of constant-cost incremental indexing.
Filesystem notifications may not work on NFS or some container mounts. After a
missed event, stop the watcher and run an ordinary indexing pass to reconcile.

When absent, Mobile creates `<root>/.xerjignore` using native gitignore syntax.
It excludes dependency/build/cache trees (`node_modules`, `target`, `build`, `dist`,
`coverage`, `__pycache__`, `.cache`, `.next`, `.astro`), common objects/binaries,
archives, temporary/log/database files, source maps/minified JS, and credential
names (`*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `credentials*`, `secrets/`). XERJ
always skips hidden names including `.git`, `.gestalt`, `.codex`, `.env`, `.ssh`,
and does not follow symlinks by default. Its native `.gitignore` and
`.git/info/exclude` handling remains enabled.

Useful `vendor/` source is re-included by the generated `!vendor/` rule. An existing
`.xerjignore` is never overwritten: review its policy before enabling automatic
indexing, including adding `!vendor/` if desired. XERJ's own built-in defaults still
apply. To exclude more, add a pattern; to include something ignored, add a native
`!pattern` rule (also re-include its parent directory if pruned). Changes to ignore
files trigger the watcher. Hidden-name skipping cannot be overridden. Exclusions
are filename rules, not a secret detector; add project-specific credential paths.

### Configuration fingerprint

Mobile stores `.gestalt-index-config.json` beside the root's native journal,
only after XERJ reports a successful generation. It contains an inspectable
settings object and SHA-256 fingerprint: canonical root, namespace, endpoint,
audited native version and content-affecting flags (graph/semantic mode, file-size
cap, sample size, PDF timeout, symlink/label policy). The indexing command uses
the same content-argument definition as the fingerprint.

Before starting an indexing child, Mobile compares this record with its intended
configuration. A mismatch or damaged record stops indexing with recovery guidance;
retrieval remains available. No automatic rebuild, deletion or fingerprint
replacement occurs. Restore the prior settings or explicitly rebuild the root.
Worker counts, bulk size, debounce and progress formatting do not affect this
fingerprint. Ignore files are live selection policy and also remain outside it.
Native validation remains authoritative: an older/manually created index without
a Gestalt fingerprint must pass native validation once before Mobile records one.

### Verified rc.87 addition limitation

Tests against the pinned binary distinguish these cases:

- One repository with one document dataset: new source files beside existing files
  and in new subdirectories are incrementally accepted.
- Multiple Git repositories with similar code schemas: a new file **inside an
  already indexed repository** can match two frozen datasets equally and abort
  reconciliation. This occurs in both watch mode and a direct `autoindex` pass.
  Passing `--dataset` does not resolve it; that option filters `autoindex map`,
  rather than selecting an indexing destination.
- A completely new repository can encounter the same refusal, or need unsupported
  dataset/schema evolution. An explicit root rebuild is then necessary.

This is a significant upstream limitation for a cross-repository source index,
not normal expected auto-index behavior. Existing paths retain their assignment,
so updates and deletions work; byte-identical added aliases can also retain their
content assignment. A rejected addition prevents that whole generation from
publishing until the ambiguity is removed or the index is explicitly rebuilt.

Source audit at commit `fcb73c1c725cf6532cb73e556c51e0388a791533` explains the
asymmetry: initial `compute_scopes`/`dataset::cluster` uses the nearest `.git`
repository; the frozen `PlanDataset` does not retain that scope, and incremental
`classify_new` receives only group, family and fields—not the new file's repository
path. Equal schema matches are deliberately refused. Watch mode calls the same
reconciliation path. No supported indexing scope/dataset-selection flag repairs
this in rc.87. See [native reconciliation](https://github.com/xerj-org/xerj/blob/fcb73c1c725cf6532cb73e556c51e0388a791533/engine/crates/xerj-autoindex/src/reconcile_plan.rs)
and [initial dataset grouping](https://github.com/xerj-org/xerj/blob/fcb73c1c725cf6532cb73e556c51e0388a791533/engine/crates/xerj-autoindex/src/dataset.rs).

The alternative native commands do not supply a missing incremental route:
`corpus index` calls the same `run_with_options(..., no_graph=true)` autoindex
engine; its `--fresh` flow builds a replacement generation. `code` is a query
command, and direct `index` ingestion would require Gestalt to implement extraction
and synchronization. Graph-mode autoindex resumes a frozen plan rather than
reconciling additions and deletions; the documented live-update route requires
`--no-graph`, which Mobile already uses. Gestalt does not silently rebuild or
substitute its own indexer for this upstream defect. See the pinned
[corpus lifecycle](https://github.com/xerj-org/xerj/blob/fcb73c1c725cf6532cb73e556c51e0388a791533/engine/crates/xerj-autoindex/src/xc.rs)
and [native live-reindexing guide](https://github.com/xerj-org/xerj/blob/fcb73c1c725cf6532cb73e556c51e0388a791533/docs/LIVE_REINDEXING.md).

## Retrieval and authority

Mobile reuses its existing readiness-checked ephemeral Codex MCP configuration.
After capability/skill verification it exposes only `xerj_map`, `xerj_search` and
`xerj_code_search` through `gestalt xerj mcp --url <verified endpoint>`. No workspace
MCP configuration or sandbox write grant is added. Profiles that exclude the XERJ
skill do not gain it automatically.

Use XERJ for broad engineering discovery and prior art across repositories. Use
Serena, when installed, for semantic navigation and structured changes in the
active workspace. Use context-mode for large retrieval, build, test and log output.
XERJ does not install or replace Serena or context-mode.

Results are reference material unless the task concerns their source repository.
Resolve root-relative paths using catalog root metadata. Similar files remain
separate; byte-identical files share indexed content but retain their identities
in `ax_paths` and catalog duplicate aliases. Preserve all aliases in fork comparisons,
not just the canonical `ax_path`. Verify current source before modifying anything.
**Retrieval scope does not grant modification authority.** Codex remains bound to
its current workspace permissions even when XERJ can retrieve another repository.

## Inspect and recover

The header configuration menu shows XERJ state, source root, current phase/percent,
last successful update and native file/record counts when reported. It refreshes
only while open. Errors also enter Mobile's existing notifications. Other Mobile
instances show shared ownership without proxying progress. Counts are observations
from the current process, not a new statistics database.

```sh
gestalt --version                 # detected component versions
gestalt xerj -V                   # installed native version
gestalt xerj test                 # isolated upstream regression probes
gestalt doctor                   # optional XERJ version and backend readiness
gestalt xerj status               # managed backend ownership/readiness
gestalt xerj autoindex map --json # native catalog and source roots
gestalt xerj autoindex status     # native indexing state
```

For a manual reconciliation, first stop the Mobile instance owning the watcher,
then run the same execution settings:

```sh
gestalt xerj autoindex --cwd /path/to/source-root --no-graph --no-semantic --yes \
  --workers 2 --pdf-workers 1 --bulk-mb 4 --max-file-gb 1
```

rc.87 refuses resume when content-affecting settings differ from the committed
generation. Worker counts and bulk size are operational, not index identity.
Use the endpoint returned by `gestalt xerj ensure-ready` with `--url` if nondefault.
Restart Mobile afterwards. An unchanged pass should reuse the committed generation.

Do not use `--fresh` as a routine rebuild command: rc.87 refuses it for generated
journals. To fully rebuild the managed root namespace, stop its watcher, use the
native authenticated API to delete only that root's indexes identified by the
catalog, and archive that root's journal directory before restarting Mobile.
Back up first; never delete the whole shared data directory to repair one root.
A manual `--prefix` can instead build a separate reference namespace, but Mobile
continues using its canonical-root namespace.

The opt-in native regression uses temporary data and loopback HTTP, with no downloads:

```sh
XERJ_NATIVE_HOME="$HOME/.gestalt" npx vitest run src/server/platform/retrieval/xerj-indexer.native.test.ts
```

Ordinary unit tests skip this external-binary test. Native file counts describe
unique content; identical-path aliases are retained but not counted separately.

To evaluate another release, use `gestalt xerj update [VERSION]` followed by
`gestalt xerj test --json`. These native tests use temporary indexes and bypass
Gestalt's watcher lock to detect upstream fixes. Updating does not change the
audited Mobile/MCP version gate or certify real-index migration; use
`gestalt xerj install` to restore the pinned version if necessary.
