# Immutable scratch producer fixtures

`mobile-v1-producer.ts.txt` is the unmodified Mobile allocator from
`ba25c5cc77894d32dd094836567467e22504899a`, as documented in
`docs/legacy-scratch-provenance.md`.

`launcher-containment-runtime.cjs.txt` contains the exact runtime between
`// BEGIN SESSION SCRATCH RUNTIME` and `// END SESSION SCRATCH RUNTIME` in
Launcher `5f36e7abe81cabd29ad9e14d6b3e0a698199c025`, `public/gestalt`, preceded
only by the repository's AGPL copyright header. Runtime bytes: 23,920; SHA256:
`0fddab0c1f2b8dceae85706b5a959c54a162f40279c5f83f292bbda31a1513f8`.
Complete fixture SHA256:
`12a51c4306240366b3a316042d2b2deac6bdc0077020cfc611f36d346ad8fa94`.

Cross-process tests execute that producer's real `scratchAllocate` and
`scratchRelease` functions against Mobile cleanup in isolated workspaces, with a
controlled publication barrier. They exercise the shared filesystem protocol;
they do not launch a native provider or claim a complete CLI interaction test.
Bundled immutable bytes support CI checkouts without the sibling Launcher tree.
Neither fixture supplies authority to delete unmarked legacy directories.

`launcher-v2-runtime.cjs.txt` is the separate v2 runtime from the coordinated
`dyne/gestalt` commit `7c658e00d27a70f08a7f7b6a3e5bc2b90c581463`.
It is generated from the exact
`BEGIN/END SESSION SCRATCH RUNTIME` source, with the same copyright header.
Complete fixture SHA256:
`aca3aa8bc504a8715bf81d6dd75171865f5c10c5c4d9cff032692f9e195dfa46`.
The current composition tests execute this producer against v2 Mobile owners.
The original v1 fixtures above remain unchanged for retained-owner and explicit
old-consumer incompatibility coverage. Neither fixture launches a provider or
substitutes for the actual native-sandbox gate in Launcher CI.
