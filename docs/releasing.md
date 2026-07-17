# npm release operations

Gestalt Mobile releases are produced only by the `Release` job in
`.github/workflows/ci.yml` after the exact `main` commit passes both required
jobs. Maintainers do not publish or create release tags from local clones.

## Repository configuration checklist

Configure the canonical `dyne/gestalt-mobile` repository as follows:

- Protect `main` and require pull requests.
- Require the stable `Verify` and `Package smoke` status checks before merge.
- Do not permit administrators or other roles to bypass failed required checks.
- Allow GitHub Actions to create releases and tags. The release job itself has
  only `contents: write` and `id-token: write`; all other jobs have
  `contents: read`.
- Grant this repository access to the organization Actions secret named
  `NPM_TOKEN`. Do not expose it to pull-request jobs or other environments.
- Ensure `NPM_TOKEN` belongs to an npm maintainer authorized to publish the
  unscoped `gestalt-mobile` package and requires the least privileges npm
  supports for publication.

Verify these settings after changing the workflow or repository rules. A test
pull request with a deliberately failing required check must remain unmergeable,
and its jobs must not have access to `NPM_TOKEN`.

## Version and release behavior

The first release is npm `gestalt-mobile@0.1.0`, Git tag `v0.1.0`, and a matching
GitHub Release. Later versions are selected by `ietf-tools/semver-action` from
conventional commits:

- `feat` and `feature` bump the minor version.
- `fix`, `bugfix`, `perf`, `refactor`, `test`, and `tests` bump the patch version.
- `BREAKING CHANGE` and the conventional `!` marker bump the major version.
- `docs`, `chore`, `style`, and unrecognized commit types do not release alone.

The workflow changes package versions only inside its runner. It publishes npm
first, then pushes exactly one annotated tag, then creates the GitHub Release.
It never changes the version committed on `main`.

## Credential rotation and revocation

Rotate `NPM_TOKEN` from npm first, replace the organization secret, then revoke
the old token. Run a normal verified release only when a release-worthy change
is ready; do not print or test the token in a pull-request workflow. If the token
is suspected to be exposed, revoke it immediately, audit npm package versions
and GitHub releases, and replace the secret before any retry.

Prefer migrating to [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
when the organization is ready. Remove the token only after a rehearsed trusted
publisher configuration successfully proves the same repository, workflow, and
release environment restrictions.

## Partial-release recovery

Rerun the failed workflow for the same `main` commit. The release policy inspects
npm, the exact Git tag, and the GitHub Release before mutation:

- If npm publication failed, a retry publishes normally.
- If npm succeeded but the tag is absent, a retry verifies npm `gitHead`, then
  creates only the missing tag and release.
- If npm and the tag exist but the release is absent, a retry at the tagged
  commit creates only the missing GitHub Release.
- If all three exist and match, the retry succeeds without mutation.
- Any package/version ownership conflict, mismatched commit, or unexpected
  pre-bootstrap remote tag fails closed and requires investigation.

Never delete or move an existing release tag to force a retry, and never
republish an existing npm version.

## Inherited tags

Some developer clones retain unrelated `v1.x` tags from the former Gestalt
repository. Never run `git push --tags` from such a clone. Push branches normally;
the workflow uses `git push origin "refs/tags/v$VERSION"` to push one exact tag.
Before `v0.1.0`, any unexpected remote `v*` tag intentionally blocks release so
maintainers can resolve the collision without importing the inherited history.
