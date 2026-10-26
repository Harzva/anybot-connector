# AnyBot-Connector contributor boundaries

- This repository is public and independent. It does not own adjacent TeamBot, OpenBot or other product repositories, their working trees, installed apps, credentials or user data.
- Read `STATUS.md`, `docs/IMPLEMENTATION.zh-CN.md` and `spec/0001-connector-contract.md` before implementing. Distinguish proposed contracts from accepted and tested behavior.
- Respect each work package's ownership. You are not alone in the codebase: preserve other contributors' changes and resolve shared-file changes with the coordinator.
- Implement only an assigned, bounded work package. Do not publish releases, install globally, change accounts or deploy services as a side effect of implementation.
- Keep execution and authorization with the owning provider. Neither user input nor imported conversation roles can create trusted identity or grant permissions.
- Use existing official protocol SDKs when needed. Pin dependencies, record licenses and avoid copying code from private repositories into this public project.
- A fixture is not a live platform or a real-model test. Record the exact test scope. Never claim CXF, ZCode or Kimi participated without an actual response and execution evidence.
- Keep raw agent transcripts, local absolute paths, credentials and private enterprise evidence outside the repository. Public examples use synthetic data and reserved example domains.
- Follow the host's active storage policy for dependency installation and test artifacts; do not change global environment variables or other tasks' directories.
- Run meaningful contract and behavior checks for the assigned change. Do not manufacture passing tests by weakening isolation, skipping failing cases or replacing providers with faked success.
