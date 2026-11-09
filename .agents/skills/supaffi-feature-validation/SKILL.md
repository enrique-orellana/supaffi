---
name: supaffi-feature-validation
description: Run Supaffi's optional end-of-feature validation with independent adversarial review, deterministic property-based and fuzz tests, and regression coverage. Use only after the user opts in at the end of a Supaffi feature or bug fix.
---

# Supaffi Feature Validation

Run this workflow only after the user explicitly opts in. It challenges a completed Supaffi change; it is not a default test step and does not authorize deployment or commits.

## Workflow

1. Read repository instructions and inspect the feature diff, affected code paths, and existing tests. Write down the feature's security and correctness invariants before delegating.
2. Choose test ideas that fit the feature. Consider malformed and boundary inputs, unauthorized use, replay and duplication, ordering and concurrency, partial failures, numeric/date limits, and interactions with adjacent behavior. Skip categories that do not apply; do not add random tests without a stated invariant.
3. Spawn three independent agents with disjoint responsibilities. Tell each to follow repository instructions, avoid secrets and live external services, and make no production-code edits:
   - **Adversarial reviewer (read-only):** try to violate invariants, abuse trust boundaries, and identify missing tests. Return concrete scenarios with affected files and severity.
   - **Property/fuzz test author:** add deterministic, bounded property-based or mutation/fuzz tests in a new, dedicated test file. Use fixed seeds, assert meaningful invariants, and include seed/input details in failures. Prefer structured generators for valid inputs plus malformed-input fuzzing where parsing is involved.
   - **Regression/integration test author:** add focused tests for feature interactions and failure paths in a different test file. Check idempotency, duplicates, ordering, authorization, and persistence only where relevant. Use existing project fixtures and the isolated `_test` database.
4. Keep agent edits to separate test files. Agents must not run database-backed suites concurrently or change production code. If a suitable test cannot be written without overlapping edits, have that agent return test cases for the primary agent to implement.
5. Review every agent change and finding. Reject flaky, redundant, unbounded, network-dependent, or implementation-coupled tests. Convert valid findings into fixes or report them clearly if they need a product decision.
6. Run the narrow affected tests, then the relevant typecheck, lint, and formatting checks. Use `pnpm`; run database-backed tests only against a database whose name ends in `_test`. Run broader suites only when the user asks or the risk warrants it.
7. Summarize the invariants challenged, test types and counts, commands and results, issues fixed, and any remaining gaps. Do not commit, push, or deploy unless separately requested.

## Test design rules

- Make generated tests reproducible: fixed seed, bounded cases, and failure output that can reproduce the counterexample.
- Compare against independent invariants, not just a second implementation of the same logic.
- Keep fuzzing local and bounded. Do not make real payment requests, contact production callbacks, or depend on live provider availability.
- Preserve normal feature tests; add adversarial cases alongside them rather than replacing them.
- Test security-sensitive state changes through the same production entry point when practical, including signature/authentication, duplicate delivery, and persistence behavior.
- Treat a signed provider event as authenticated input, not proof that every field fits local storage or business rules.
