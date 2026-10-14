# DWFx Measure: deployment pack for IT

DWFx Measure is a Microsoft Excel add-in for quantity surveyors. It opens Revit DWFx models in a 3D view inside
Excel and writes take-off quantities to the workbook. This pack gives IT what it needs to approve, deploy and
support it.

| | |
|---|---|
| Publisher | QSGS (Chanuka Mudiyanselage) |
| Add-in type | Office web add-in (task pane + ribbon tab), manifest `manifest.xml`, version 0.5.1.0 |
| Hosts | Microsoft 365 Excel for Windows, Mac and the web (ribbon needs the shared runtime, Microsoft 365) |
| Server | `https://dwfx-addin-production.up.railway.app` (Railway, EU region) |
| Permissions | `ReadWriteDocument`: reads and writes the open workbook only |
| Sign-in | Email and password created by the add-in administrator (Microsoft sign-in can be added later) |

## 1. Install

**Recommended: central deployment (Microsoft 365 admin center)**
1. Microsoft 365 admin center › Settings › Integrated apps › *Upload custom apps*.
2. Choose *Office Add-in*, upload `manifest.xml`.
3. Assign users or groups. Excel shows the **DWFx Measure** tab for them (it can take up to 24 hours).

**Alternative: shared folder catalog (Windows)** — put `manifest.xml` in a read-only network share, then in Excel:
File › Options › Trust Center › Trust Center Settings › Trusted Add-in Catalogs › add the share, tick *Show in Menu*.
Users add it from Home › Add-ins › Shared Folder.

**Updating**: the add-in code updates automatically from the server. Only a new `manifest.xml` (new ribbon buttons)
needs to be uploaded again; users may need to clear the web add-in cache (Trusted Add-in Catalogs ›
*clear all previously-started web add-ins cache*).

## 2. Network

User computers need HTTPS (port 443) to:

| Host | Why |
|---|---|
| `dwfx-addin-production.up.railway.app` | The add-in pages, the API and file uploads/downloads |
| `appsforoffice.microsoft.com` | Microsoft's Office.js library (required by every Office add-in) |

Nothing else is called from user computers. AI requests go **from the server** to the AI provider, not from users.
Uploads can be up to 500 MB per file.

## 3. Data flow

```
Excel (user PC) ──HTTPS──> DWFx Measure server (Railway, EU) ──> PostgreSQL database (Railway, EU)
                                   │                         └─> Private file storage bucket (Railway, Amsterdam)
                                   └──HTTPS (optional)──> AI provider (names, counts, totals only)
```

| Data | Where it is kept | How long |
|---|---|---|
| User accounts (email, name, role, password hash) | Database | While the user is listed by the administrator |
| Projects, team members, take-off methods, saved views, zones, QS rules | Database | Until deleted |
| Uploaded DWFx files, processed model data, drawings, audit PDFs | Private storage bucket, per project | Until the version, drawing or project is deleted |
| Activity log (who uploaded, measured, exported) | Database | Life of the project |
| Error log | Database | 90 days |
| Database backups | Storage bucket | Daily, last 30 kept |
| The workbook itself | On the user's computer / OneDrive / SharePoint | Not stored by the add-in |

- Files are never public. Every download goes through the API after a permission check (project role Owner, Editor or Viewer).
- All traffic is HTTPS. Passwords are stored as scrypt hashes; session tokens are stored hashed and expire after 30 days.
- Deleting a project deletes its files from the bucket. *Export ZIP* gives a full copy of a project for hand-over.

## 4. AI (optional)

- The AI can be switched off for everyone (Admin › AI assistant) or for one confidential project (project settings).
- What is sent: element category, family and type names, counts, levels, quantity names, sample and total values,
  take-off group names and totals, and the user's request. **Never** the DWFx file, the 3D geometry or the workbook.
- Provider: any OpenAI-compatible API chosen by the administrator (currently DeepSeek). Choose a provider that your
  company and your clients approve for project data, and check its data-retention terms.
- Each user has a daily request limit; use is logged per user.

## 5. Security summary

- Access: sign-in required for everything except the static add-in pages and Help; per-project roles; admin-only
  administration; failed sign-ins are throttled and accounts lock for 15 minutes after 8 wrong passwords.
- API rate limit per user; upload size and type limits; HTML is escaped everywhere; text written to Excel can never
  become a formula.
- Security headers on every response, including a Content Security Policy (scripts only from the server and
  Microsoft's Office host) and HSTS.
- Dependencies are checked with `npm audit` (0 known vulnerabilities at release) and tested automatically on every change.
- Full report: `docs/SECURITY.md` in the repository.

## 6. Support and operations

- Users see a reference code with any server error; administrators find it in Admin › Errors.
- Health check: `https://dwfx-addin-production.up.railway.app/health` (database, storage and AI status).
- Services on Railway: `dwfx-addin` (web and API), `dwfx-worker` (model processing and backups), `Postgres`, bucket `dwfx-files`.
- Railway variables used: `DATABASE_URL`, `APP_USERS`, bucket credentials, `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`,
  `WORKER_IN_API`, optional `CSP_MODE` (`enforce`, `report` or `off`), `RATE_LIMIT_PER_MIN`, `SESSION_DAYS`.

## 7. Privacy note for users

DWFx Measure stores the models, drawings and take-off data you upload so your project team can use them. Only
people added to a project can see it. Your name and email are used to sign you in and to show who did what in the
project activity log. If the AI assistant is on, the names and quantities of model elements (never files or 3D
geometry) are sent to the AI provider chosen by your administrator to plan or check a take-off. Ask your
administrator to delete a project or your account at any time. Before uploading client models, make sure your
company and the client allow storing them on this service.

## 8. Licences

The 3D decoder uses the open-source `dwf-viewer` package (AGPL-3.0). This is fine for internal company use. Selling
or distributing the add-in to other companies would require publishing its source code or replacing the decoder.
Other components use permissive licences (MIT, Apache-2.0, BSD).
