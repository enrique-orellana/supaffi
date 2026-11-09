# Local sandbox UI checks

Use the `local-sandbox` tenant for manual browser checks. The app and its database both run locally; the production snapshot is a separate local database and is not the UI fixture.

## Local data sources

- `supaffi` is the existing local database and contains the `local-sandbox` tenant.
- `supaffi_test` is reserved for automated database tests.
- `supaffi_live_snapshot_20261109` is a point-in-time local copy of deployed data. Do not use it for routine UI checks or point the app at it.

On this workstation, the existing PostgreSQL container is `supaffi-plan-db-1`, publishing `127.0.0.1:5432`. If it is stopped, start that existing container with `docker start supaffi-plan-db-1`; do not start a second Compose project, which may create a new empty database volume.

Before opening the UI, run:

```powershell
pnpm exec prisma migrate status
```

Confirm Prisma reports database `supaffi` at `127.0.0.1:5432` and that the schema is up to date. Do not print or copy the `DATABASE_URL`; it contains credentials.

## Start and check the UI

From the repository root, start the local app if it is not already running:

```powershell
pnpm exec next dev -p 3000
```

Use Brave for browser checks. Open <http://localhost:3000/affiliates/login> and confirm the page says **Local Sandbox affiliate program**. This verifies the local tenant/domain mapping.

For owner dashboard checks, sign in at <http://localhost:3000/login> with the local owner account. Credentials stay in the ignored local `.env`; never paste them into documentation or commit them. Then use:

- Overview: <http://localhost:3000/dashboard/products/local-sandbox>
- Payouts: <http://localhost:3000/dashboard/products/local-sandbox/payouts>

Use existing sandbox records for visual checks. Avoid actions that mark payouts paid, change program settings, clear seed records, or reset the database unless the task specifically requires them. If the affiliate dashboard needs an account without a password, create a password link from the local sandbox owner UI; do not use production credentials.

As of 2026-11-09, the local sandbox contained 16 affiliates, 731 commissions, and 6,710 clicks. Treat these counts as a baseline, not a permanent assertion.

## Automated tests

Run the automated suite with `pnpm test`; database-backed tests are guarded to use `supaffi_test`. Do not switch tests to `supaffi` or the production snapshot.
