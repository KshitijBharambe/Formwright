# Notion pipeline and GPT Web handoff

Notion owns job facts and application tracking. Formwright owns local queue selections, attempts, per-application answers and browser sessions. GPT Web can research and maintain the pipeline through your existing Notion connection; there is no GPT Web API bridge, scraping session or embedded GPT dependency.

## Set up your own database

Create these properties (names can be mapped in `config/notion.json`):

| Property | Type | Meaning |
| --- | --- | --- |
| Name | Title | Role title |
| Company | Text | Employer |
| URL | URL | Direct employer job/application URL |
| Status | Select | New, Apply, Applied, Rejected, Closed |
| Lifecycle | Select | Active, Archived |

1. Create a Notion integration with read-content access. Add update-content access if you want dashboard status changes. Connect the integration to your database.
2. Copy `config/notion.example.json` to `config/notion.json` and fill its local `token` and `databaseId` (or `dataSourceId`). These are your IDs, not a shared template's. Keep the token out of GPT prompts and Git.
3. Keep the example filter: Active lifecycle plus New or Apply status. If your property is Notion's **Status** type rather than **Select**, change its filter keys from `select` to `status`.
4. Click **Sync**. All readable valid jobs appear in Applications; the Notion pipeline view shows only the eligible subset. Select jobs and Run queue.

Notion uses [data source queries](https://developers.notion.com/reference/query-a-data-source). Formwright pins API version `2025-09-03`. The database and data source UUIDs differ; multiple-source databases require an explicit data-source ID. A browser view URL is not an ID.

Optional Answer Bank: add `"answerBank": {"dataSourceId": "YOUR_ANSWER_BANK_DATA_SOURCE_UUID"}`. Required columns are Question (Title), Canonical Answer (Text), Status (Select or Status), Auto-fill OK (Checkbox). Only nonempty Confirmed + Auto-fill OK answers are used. The bank is read-only and overrides equivalent local answers. GPT-generated answers are not automatically approved.

## Instruction for GPT Web

Copy this into your job-research chat, with a link to **your** database:

> Maintain my Notion Job Pipeline at [database link]. Find roles matching the criteria I provide. Check each employer's direct job page and save the exact employer URL, role title and company. Deduplicate by employer job URL and requisition when available. New verified jobs should be Status = New and Lifecycle = Active. Leave existing application statuses intact, especially Applied, Rejected and Closed. Do not mark jobs Applied, select local queue items, submit applications, or edit my approved Answer Bank. If a job is unavailable, report it for review rather than inventing a replacement URL. Report records added, duplicates skipped and uncertain links. Do not ask for or store my integration token.

This is a handoff contract, not enforcement of another tool's behavior. Review GPT Web's research. Formwright does not verify job suitability or guarantee that upstream content is accurate.

## Sync and status rules

- **Pipeline vs selection:** the dashboard reads the full valid, unarchived source catalog to reconcile tracking, then the configured filtered selection to decide eligibility. If either read fails, it retains the last complete snapshot and marks the source stale. Full catalog reads cost additional paginated requests on large databases.
- **Freshness:** while visible and idle, the dashboard refreshes sources once a minute by default. Turn this off in Notion pipeline. **Sync** is always available. The 3-second UI poll reads local state; it is not a Notion query. Background tabs stop polling and syncing.
- **New jobs:** appear after sync, unselected. Neither GPT Web nor a refresh starts browser work. Local selection and removed-state survive restarts. Restore does not select a job.
- **Execution:** each Notion-linked job must still match the same page and URL in a fresh eligible selection immediately before it starts. Removed, changed, filtered-out or failed sources stop that work. Active browser tasks finish when paused.
- **Status edits:** inline changes PATCH only the selected existing Status/Lifecycle property, then read back the page. The API verifies the source and URL and rejects a field changed since the displayed snapshot. Failed or unverified writes are not presented as saved. Tracking edits remove that application's pending queue item.
- **Concurrent writers:** the API has no compare-and-swap in this implementation. The preflight check catches changes already present before the write; a change between GET and PATCH can still race. Avoid having GPT Web and Formwright edit the same tracking field simultaneously. Refresh and review conflicts; there is no automatic overwrite retry.
- **History:** jobs outside the eligible filter still get current tracking from the catalog. Trashed/deleted pages, invalid URLs and old URL aliases remain historical snapshots, blocked from autofill. Notion duplicates with the same normalized URL collapse to the first result; clean duplicates upstream.
- **No automatic Applied:** only explicitly mark Applied after submitting yourself. A dashboard status edit never clicks an employer Submit button.

Local files and manual URLs are alternative inputs. They do not get silently written into Notion. No polling daemon runs when the dashboard browser is closed.
