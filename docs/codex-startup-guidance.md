# Codex startup guidance

On a fresh Mobile Codex session, native `config/read` selects the effective
developer scalar for the running launcher/project context. Mobile adds
the optional Agents startup contract in that same `config.developer_instructions`
channel on `thread/start`. RPC `developerInstructions` is a separate transport;
Mobile does not set it or replace native foundation instructions. Explicit model,
personality, foundation and permission choices retain native precedence.

Mobile skill profiles select skills through the saved
`effectiveSkillSelection` and existing `compileSkillOverride` path. Their names
do not select native Codex CLI configuration layers. The production launcher
uses `codex app-server --stdio` in its established environment. Observed Codex
0.164.0 rejects `--profile` for app-server; CLI support for that flag on other
commands does not establish app-server support.

Startup-layering coverage verifies a named Mobile skill selection together with the
effective native developer scalar and synthetic role-duty bytes. It asserts
the final sent selection and actual model-input delivery, with the same skill
mask on both sides of the native comparison. It does not claim native CLI
profile precedence or native child-role dispatch. A separate negative native
case checks selector rejection before any model request.

Native skill discovery identifies the selected installed Gestalt package. Mobile
requires one selected package root and its `gestalt-startup-contract.json`
descriptor, then reads its package-relative bootstrap. It never searches for the
newest cached version, imports a source checkout or embeds a second guide.
The version-1 composer preserves bytes outside owned startup blocks, replaces
the first supported block and removes further copies in the mutable channel.
Role duties remain outside that block; no installed role file is rewritten.

Missing older package data or unsupported contract versions preserve existing
instructions. Invalid data or malformed/newer owned blocks also preserve the
original stable layer. The adapter's `startup` result contains only a fixed
status/reason, selected package version and, on success, block version/hash.
It contains no instruction text or filesystem diagnostics. Excluded Gestalt
skills or `skills.include_instructions=false` omit new stable delivery. Optional
XERJ and Serena failures do not suppress an otherwise available stable contract.

If native configuration readback fails and no explicit input developer scalar is
known, Mobile omits the scalar override entirely. It cannot safely append even
unavailability guidance to an unknown native value. Optional connections remain
disabled; no foundation/RPC replacement channel is used to mask the failed read.

XERJ, Serena and Playwright own separate complete capability blocks. Preparation
and verification update only the relevant block, retaining user text and other
capabilities. Connection availability does not establish repository coverage or
semantic readiness. Ephemeral catalog probes do not install the stable bootstrap
or acquire durable Org role duties.

Existing threads retain their native durable instructions, including legacy
absence. Package updates and ordinary resume are not an instruction migration.
When the existing missing-rollout policy authorizes a replacement, the new
thread prepares its stable instructions from the selected package using the
native configuration snapshot already read for that owned runtime. Only the
bounded instruction read/composition repeats; capabilities, model/permission
settings, resource ownership and scratch allocation retain their existing
preparation and publication order. Ordinary resume never takes this boundary.
This fresh-start integration grants no refresh, cleanup or allocation authority.
Native Codex 0.164.0 child roles retain native precedence: a custom role's
developer scalar replaces the parent scalar. A role containing the owned
bootstrap delivers that block once; a role without it retains that absence.
Mobile does not add parent duties to a custom role or rewrite installed role
files. Adding guidance to such a role is a fresh role-configuration boundary,
not a migration performed by continuing an existing child.
Lifecycle fixtures exercise actual native role dispatch and permitted child
continuations, including manual Off and attention fences.

Native restore and recovery retain complete root instruction components.
Native fork and child continuation can regenerate the default foundation while
retaining developer, skill and permission layers. Lifecycle tests compare the
complete resulting components against a paired native fork/resume control;
they do not discard unmarked foundation content. Explicit foundation choices
also remain covered by the startup delivery tests.
Scratch, provider associations and resource leases retain the
[session scratch contract](session-scratch-contract.md).

The startup tests capture actual sent parameters. Native integration tests use
an isolated package installation, Codex home and local synthetic Responses
provider. They compare native instruction components/hashes and supported
separate foundation fields, rather than assuming one fixed model-input layout.
These captures prove synthetic delivery structure, not real-model adoption.
They opt in with `RUN_INSTALLED_CODEX=1`, require the host's installed `codex`
executable and local listening/process permissions, and run through the supported
host test runner when sandboxed. Ordinary unit coverage remains independent of
that optional native executable.
