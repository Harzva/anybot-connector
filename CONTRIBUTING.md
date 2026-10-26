# Contributing

Start with an agreed work package and file ownership from [the implementation plan](docs/IMPLEMENTATION.zh-CN.md). The initial RFC is a proposal; material changes to authority, task ownership or compatibility must be resolved in a documented design decision before dependent implementation.

## Pull requests

Explain the concrete behavior change, capabilities supported, tests actually run and remaining limitations. Include a compatibility-matrix update when introducing an adapter. Keep changes reviewable and preserve concurrent work.

For copied or adapted third-party code, record the exact upstream revision, source path, license and modifications. A private repository being locally readable is not permission to publish its contents. Prefer original adapters against documented interfaces.

## Verification

Tests must run without production credentials or access to private product repositories. Use synthetic fixtures for ordinary CI. A reference provider must identify its deterministic behavior and must not impersonate a real model service.

Each provider must pass shared contract tests. Each transport must prove authorization, caller isolation, repeated requests, unknown outcomes, cancellation and unsupported-capability behavior. Real-platform tests are opt-in and reported separately.

## Public content

Keep prompts containing private source, agent transcripts, local runtime directories, enterprise identifiers, credentials and customer content out of commits, issues, CI logs and release assets. Example configuration uses placeholders and reserved example domains.

## Release readiness

A release requires a reproducible clean-checkout install, meaningful tests, dependency and license review, package file allowlist, documented capability limits and a changelog. Repository publication alone is not a runtime release or npm publication.
