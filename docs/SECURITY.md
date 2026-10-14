# Security review (phase 6)

Date: 14 October 2026. Scope: the server (`server.js`, `worker.js`, `src/`), the add-in pages (`public/`), the
processing scripts (`py/`), Railway configuration and dependencies.

## Fixed in this review

| Area | Finding | Fix |
|---|---|---|
| Dependencies | `npm audit`: 1 critical (XML parser inside the AWS SDK), 3 high (express / path-to-regexp, compression, multer) | Upgraded to patched versions; removed an unused AWS package. `npm audit --omit=dev`: 0 vulnerabilities |
| Sign-in | No limit on password guessing | 20 attempts per IP per 15 min; account locked 15 min after 8 wrong passwords (`src/security.js`) |
| Sign-in | Password checks blocked the server while running | Non-blocking scrypt check; same work for unknown emails (no user enumeration by timing) |
| Sessions | Changing a password in `APP_USERS` kept old sessions | Sessions are revoked when the password changes or an admin is demoted |
| API | No request rate limit | 600 requests per minute per user (configurable), `429` with `Retry-After` |
| Headers | Only basic headers | Content Security Policy (inline scripts allowed by hash only), HSTS, Permissions-Policy, CORP, `nosniff`, no `X-Powered-By` |
| Excel | Text from models or the AI starting with `=`, `+`, `-`, `@` could become an Excel formula (formula injection) | All text written to Excel and CSV is made safe |
| Errors | Unexpected errors were only in the console | Error log with reference numbers, crash handlers, client error reports, Admin view |
| Start-up | API and worker starting together could apply database changes twice | Migrations run under a database advisory lock |

## Checked, no change needed

- **SQL injection**: every query uses parameters.
- **Access control**: every project, version, drawing, take-off, view, zone, export and rule route checks the
  project role (viewer / editor / owner); admin routes check the admin role. Covered by automated tests.
- **XSS**: every value from models, users or the AI that is placed in HTML goes through `esc()`; statuses use `textContent`.
- **File storage**: keys are built by the server only; the local storage path is checked against traversal; the bucket is private.
- **Uploads**: size limit 500 MB, at most 20 files, file type allow-list for drawings, DWFx processed in a temporary folder that is always deleted.
- **Formulas in the add-in**: user and AI formulas are checked against a strict character allow-list before evaluation.
- **Secrets**: API keys and bucket credentials exist only as Railway variables; nothing secret is sent to the browser.

## Remaining risks and decisions

| Risk | Note |
|---|---|
| Rate limits are in memory | Correct for one API instance; with several instances use a shared store (e.g. Redis). |
| CSP allows `unsafe-eval` | Kept for compatibility with Microsoft's Office.js inside Excel. Set `CSP_MODE=report` or `off` in Railway if a host blocks the add-in. |
| No multi-factor sign-in | Planned through optional Microsoft Entra sign-in. Until then use long, unique passwords. |
| Data at rest | Encryption of the database volume and bucket is provided by Railway; confirm with Railway's security documentation for your compliance needs. |
| AI provider | Model metadata leaves the server when the AI is on. Choose an approved provider or switch the AI off per project. |
| AGPL decoder | Internal use only unless the decoder is replaced. |

## Tests

`npm test` runs 34 automated tests (27 server, 7 processing), including `tests/security.test.js` (headers and CSP, account lockout,
sign-out on password change, API rate limit, error reporting) and the access-control checks in
`tests/api.test.js` and `tests/features.test.js`.

## Load test

`scripts/loadtest.mjs`, 50 simultaneous users for 30 to 60 seconds on one server instance (realistic cycle: project
list, project, model data, 3D geometry, templates, save a take-off):

| Request | Median | 95th percentile |
|---|---|---|
| Project list | 53–76 ms | 125–162 ms |
| Project details | 64–94 ms | 159–198 ms |
| Model data | 112–139 ms | 235–285 ms |
| 3D geometry | 127–148 ms | 274–298 ms |
| Save take-off | 60–88 ms | 163–221 ms |

About 230–270 requests per second with **0 errors**. 50 sign-ins at the same moment take about 1 s each (the
password check is deliberately slow).
