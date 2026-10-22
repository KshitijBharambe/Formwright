# Formwright — local application autofill

New here? Start with the [first-application walkthrough](GETTING_STARTED.md). This page is the CLI, adapter and configuration reference. The dashboard also has a **How to use** view.

A TypeScript/Playwright script that fills employer application forms using your profile and approved answers. It can import the installed Simplify Copilot package's ATS detection and field selectors. No browser extension is required to run Formwright.

The [implementation direction](IMPLEMENTATION.md) maps the verification-first architecture to the current code and the next authentication, workflow, and benchmarking milestones.

## Run

```sh
npm ci
npm run build
# Review a single application. The browser stays open until you finish reviewing.
npm run run -- --url='https://jobs.ashbyhq.com/company/job-id/application' --visible
# Fill successive steps, stopping at unanswered questions or final review.
npm run run -- --visible --advance --max-steps=8 --limit=3
# Fill five applications concurrently, in separate tabs in one browser.
npm run run -- --visible --advance --concurrency=5 --limit=5
# Explicit final submission mode, for applications you authorize the script to submit.
npm run run -- --submit --advance --limit=3
```

Omit `--url` to use `data/jobs.txt`, one employer application URL per line. Without `--submit`, final submission is never attempted. `--advance` permits continue buttons between steps; it is separate from final submission. Results and unresolved fields go to `output/results.jsonl` and `output/exceptions.json`. The runner skips previously submitted applications and uncertain submissions unless `--retry-uncertain` is explicitly supplied.

The browser uses its own persistent `.browser` directory. This does not attach to your existing Arc or Chrome session. Shared account credentials can handle recognized login/signup forms as described below. Verification steps can require manual interaction. Use `--visible --pause-on-unresolved` or `--visible --pause-on-error` when inspecting a form.

## Local dashboard

```sh
npm run dashboard
# Optional: choose a different local port
npm run dashboard -- --port=4320
```

Open `http://127.0.0.1:4318`. The dashboard uses Node's built-in HTTP server and plain HTML/CSS/JavaScript, with no new dependencies or frontend build tooling. Existing CLI commands still work.

- **Applications** combines results, file links, fetched Notion jobs, and manual links in stable company → role → URL alphabetical order. Queue/running/result changes never move rows. **Details** opens lifecycle controls and full autofill details directly beneath a row.
- **Select page**, the row checkboxes, and **Add to queue** stage jobs without starting autofill. **Review queue** shows the selected batch with pagination; the queue controls report selections outside the current view. Clear a row checkbox or use **Clear visible** to leave jobs tracked while removing them from pending work. **Run queue** explicitly starts the batch; source refreshes never add jobs automatically.
- **Add an application link** validates the entire URL batch and saves it locally. **Remove from dashboard** under Details removes a job from the queue and hides it across refreshes. It does not delete its Notion record or result history; **Removed → Restore** brings it back without selecting it.
- **Pause queue** lets active tabs finish. Queue edits and tracking changes wait until active work is idle. Set concurrency (1–8) in Configuration. Filled browser tabs remain open for your review.
- **Notion jobs** shows the current fetched matching list, sorted A–Z, with tracking values, fetch time, and source errors. **Inline application status** changes an existing Status or Lifecycle option, verifies the saved value with a fresh page read, and removes pending work for that application. Applied/Rejected/Closed/Archived rows remain tracked but cannot autofill. A failed write/readback appears beneath its application and is never shown as synced. Tracking options come from the actual Notion schema; defaults are `Status` and `Lifecycle`, overridable via `statusProperty` / `lifecycleProperty`. Automatic company labels use `Company` unless `companyProperty` is configured. The integration needs **update-content** access for these explicit tracking edits. Autofill and the Answer Bank remain read-only.
- **Additional information needed** displays missing questions and employer options beneath the affected application. **Save answers & queue retry** stores explicit answers for that application only and stages a retry; it never starts one. Approved live Notion/local answers retain precedence. Repeated ambiguous questions, existing approved answers that failed to match, uploads, CAPTCHA, login, validation, and manual navigation steps point to the browser for review. New answers do not update the global Answer Bank or applicant profile.
- **Answers & profile** shows effective merged answers with provenance. **Configuration** provides account, engine, continuation, concurrency, and source settings. Passwords and Notion tokens are omitted. Last successful source snapshots are marked stale after refresh failures.

Queue selections, tracking snapshots, removed items, and application-specific answers persist with owner-only permissions in `output/dashboard-state.json`. Restarting restores pending work paused and marks interrupted attempts for review. Before every Notion-linked task, the source is fetched again and the same page/URL must still be eligible. A source/setup failure pauses new work while active tabs drain. Profile and approved answers reload for every attempt. Submitted and uncertain results, including known employer aliases, stay protected.

Dashboard autofill **never submits**. Autofill progress and application tracking are separate: mark **Applied** yourself after submitting. Explicit tracking edits use Notion’s [page update API](https://developers.notion.com/reference/patch-page), validate the configured data source and URL, and read back the saved property. The server binds only to `127.0.0.1` and checks local host/origin and a per-session token for controls. Profile/answer values are visible to local users in the browser; keep the dashboard on your own machine. Run one dashboard instance; `output/dashboard.lock` prevents two instances from overwriting its queue. The dashboard shares `.browser` with the CLI, so close any separate Formwright CLI browser session before running dashboard autofill. Stop the server with Ctrl+C.

```sh
npm run test:dashboard
```

This regression uses temporary files, mocked Notion responses, a temporary loopback server, and an offline browser fixture. It checks queue persistence, deduplication, pause/resume, retries/protected results, source refresh behavior, answer provenance, local request validation, and shared-runner browser retention without submitting. It does not run applications on live employer sites.

## Shared website login and signup

In the dashboard’s **Configuration → Shared website account**, enter one account email/username and password, list the allowed account hostnames, and enable automatic sign-in. Enable **Also create an account** to permit recognized registration forms. Save once to reuse these credentials across allowed websites. Leave the password blank on later saves to keep it. This account email can differ from the applicant contact email.

For CLI use, copy `config/credentials.example.json` to `config/credentials.json` and fill the same settings:

```json
{
  "enabled": true,
  "allowSignup": true,
  "username": "your-account-email",
  "password": "your-shared-password",
  "allowedHosts": ["*.myworkdayjobs.com", "*.myworkdaysite.com"]
}
```

Use the **login page’s hostname**, which may differ from the job website. Only HTTPS is allowed. An exact hostname allows that host; `*.example.com` allows its subdomains, excluding `example.com` itself. Add other account providers explicitly. Unlisted redirects, embedded account frames and form-post destinations stop for review before credentials are filled.

Credentials are stored locally in `config/credentials.json` with owner-only file permissions (0600) and are Git-ignored. This is a local plaintext file, **not Keychain storage**. The dashboard never returns the password in state or save responses. Credentials do not go into the answer bank, LLM, result messages, or authentication error reports. No credentials are configured by default. Configuration displays login availability; an application requiring login reports missing credentials or disabled sign-in with the Configuration steps needed to fix it.

Existing browser sessions are reused first. Recognized email/password forms and email-first then password flows are supported. Signup fills the shared account email, password/confirmation and explicitly supplied profile names. A failed login does not automatically create an account or retry credentials. Sibling tabs also stop after a rejected login or pending verification on that account host. Signup must be a clearly identified registration form; use the site’s Create Account link manually if sign-in is the initial screen. Unknown required fields, terms/consent, password resets, SSO, CAPTCHA, MFA and email verification require manual action. Disabled or missing credentials retain the existing manual handoff. Use `--visible --pause-on-unresolved` for an interactive CLI handoff; dashboard tabs remain open for review.

## Parallel autofill

Use `--concurrency=N` on the CLI or **Applications to fill at once** in the dashboard. Both accept 1–8 and default to 1. `--limit` continues to bound the total selected applications; concurrency only controls simultaneous work. Each application gets its own page and owns any popups it creates. All tabs share the persistent browser context. Account operations for the same origin are serialized so sibling tabs can reuse a newly established login session. Concurrently discovered aliases to the same employer application are held for review instead of being filled twice at once.

Notion selection and input preparation remain ordered and refresh before each new application. Workers use separate profile/answer snapshots. A source refresh failure stops new work and drains active applications. Result history and exception snapshots are serialized so a late worker cannot overwrite another worker’s results. Dashboard concurrency persists across restart; pending jobs restart paused. Final submission still requires `--submit`, and dashboard autofill never submits.

```sh
npm run test:auth
npm run test:parallel
```

These tests use synthetic accounts, intercepted browser requests and temporary local files. They cover login/signup, email-first login, rejection and verification handoffs, host restrictions, session reuse, concurrent filling, tab ownership, pause/resume and persistence. They do not establish live employer compatibility or create real accounts.

## Jobs from Notion

Use Node.js 22 or later. Create a Notion integration with read-content access, then share your job database with it using Notion's Connections menu. Formwright reads Notion directly; a Notion connection in Codex does not supply credentials to this local program.

Copy `config/notion.example.json` to `config/notion.json`, then enter your credentials there:

```json
{
  "token": "your-integration-token",
  "databaseId": "your-database-uuid",
  "urlProperty": "URL"
}
```

Keep the example's `filter` and `sorts` alongside these fields to select only the intended jobs. Set `urlProperty` to the exact column containing the employer job URL. URL, plain rich-text URL, and string-formula properties are supported. The title property is detected automatically; optional `titleProperty` and `companyProperty` map names explicitly. A database with multiple data sources requires `dataSourceId` instead of `databaseId`. IDs must be UUIDs, not view URLs.

Formwright reads this local file each time it runs. No environment variables or credential prompts are needed; Notion environment variables are ignored. `config/notion.json` is excluded from Git and holds your local token. Keep real credentials out of `config/notion.example.json`. The token is never included in job previews or results.

```sh
# Preview selected jobs without opening a browser:
npm run run -- --source=notion --list-jobs --limit=5
# Fill jobs and leave them open for review:
npm run run -- --source=notion --visible --advance --limit=3
```

`--notion` is an alias for `--source=notion`. It cannot be combined with `--url`.

The example filter selects `Lifecycle` **select** = `Active` and `Status` **select** = `New` or `Apply`. These are configurable defaults, not a verified schema for your database. Match the exact property names, types, and values in your database (for a Status property, change the filter key from `select` to `status`). Edit the native Notion `filter` to choose eligible jobs; remove it only if you intend to read every row. Jobs always sort by Notion’s `last_edited_time` descending, so newly added or edited records come first. Newer creation times break last-edit ties; optional property `sorts` apply after these timestamp rules. Empty results exit without launching a browser.

CLI autofill is read-only. Explicit dashboard tracking edits are described above. The client follows pagination, ignores archived records, skips missing/invalid URLs, deduplicates normalized job URLs, and retains the first record for duplicates. Initial API errors prevent browser launch; later refresh errors stop selection. `--limit=N` restricts Notion selection to the current top N matching records. Before every next application, the runner re-reads the local config and queries Notion again, so changed links, newly added jobs, and status/filter changes affect the next selection. It never fills the batch with older records outside that current top N. It processes each Notion page and normalized URL at most once in a run, stops when that window has no eligible unprocessed jobs, and stops on refresh failure instead of using cached links. Changes do not replace applications already open for review. Without `--limit`, all matching records remain eligible, newest first. File queues retain their existing processed-job limit. A preview displays the current top N without launching a browser. Results include a `notion` object with page ID, page URL, last-edited timestamp, title, and optional company alongside the existing application result. Existing submitted/uncertain-result checks still apply. No final submission occurs without `--submit`.

The client pins Notion API `2025-09-03` and uses the [data source query endpoint](https://developers.notion.com/reference/query-a-data-source), resolving single-source databases through [Retrieve a database](https://developers.notion.com/reference/retrieve-a-database). Run `npm run test:notion` for mocked API and queue/preview regressions. These tests do not establish live database access or ATS compatibility.

## Profile and answers

Create `config/profile.json` from `config/profile.example.json`. Use verified information and a real local resume file. Supply `config/answers.json` as a map of exact question text to approved answer text. Existing personal files are never modified by the import command.

To read your Notion Answer Bank, add this to `config/notion.json` (using the same local token):

```json
"answerBank": { "dataSourceId": "YOUR_ANSWER_BANK_DATA_SOURCE_UUID" }
```

Share the Answer Bank with your Notion integration. It is read before browser launch and refreshed before each subsequent application, including file/URL job queues. Only nonempty **Canonical Answer** values with **Status = Confirmed** and **Auto-fill OK** checked are eligible. Dynamic entries require contextual checks and remain unresolved; custom, unconfirmed, manual, placeholder, and `skip` entries are excluded. Conflicting approved duplicates are omitted. Short answers are not substituted because they can drift from canonical answers. Matching uses exact question text with punctuation/case/spacing normalization plus explicit equivalent-wording groups (for example, future employment/visa sponsorship). It does not use fuzzy similarity. A country-relative work-authorization question uses the US bank answer only when job-posting location evidence establishes a US job; applicant location is never used for that decision. Approved Notion answers override matching or explicitly equivalent local JSON entries; local answers supplement other questions. The local answers file is optional. A configured bank error stops processing instead of silently using stale answers. Remove `answerBank` to use local answers only. The Answer Bank is read-only.

Education fields use `profile.education` when supplied. If absent, the loader accepts approved canonical education text in the explicit format `Master of Science in Computer Science (School Name, May 2025) and Bachelor of Engineering in Computer Engineering (Other School, May 2023).` It extracts degree, field, and school without inventing records. Greenhouse education rows are added through the education section's visible Add another button, then matched by row index. Unrecognized prose remains unresolved. A single approved degree name can also answer the first degree field; it does not create a school or another education row.

Matching has two stages: resolve the visible question to an approved fact, then resolve that fact against the choices the control actually offers. Explicit wording groups cover personal fields and education labels such as `Degree type` / `Academic degree`, `University name` / `School`, and `Major` / `Field of study`. Case, punctuation, curly apostrophes and trailing `(required)` / `(optional)` markers are normalized. Highest/completed education questions stay separate from a general degree record; ongoing or planned education questions are not substituted.

For dropdowns and radio groups, exact option text wins, followed by equivalent degree names (`Master of Science` / `Masters of Science` / `MS` / `MSc`), then a single generic level option (`Master’s degree`). The same rules cover bachelor's, associate and doctoral qualifications. A generic answer cannot select a specific qualification, and Master of Science cannot select Master of Arts. Duplicate or equally suitable options and conflicting bank entries remain unresolved. Searchable dropdowns can retry using a degree-level search term, but choices are always checked against the original approved answer. Native selects, ARIA comboboxes and Workday menus share this resolver. A selection must persist, and required fields with an approved answer are checked against that answer again before readiness; nonempty text or a different prefilled option is insufficient. New wording groups belong in `src/answers.ts`; qualification aliases belong in `src/degree-matching.ts`. This uses explicit equivalences, not unrestricted similarity or generated applicant facts.

Run `npm run test:answers` for Answer Bank loading and matching regressions, `npm run test:resolution` for equivalent wording, degree options, ambiguity, search-only dropdowns, rejected selections and repeat-run checks, and `npm run test:braze` for the offline browser fixture using synthetic data with network access blocked. The fixtures do not submit applications. The Braze fixture checks authorization, sponsorship, LinkedIn, both education rows, uploads, and untouched unknown/consent fields. These checks do not verify live employer persistence.

YC contact fields also use deterministic rules. Phone readback ignores display punctuation only when all digits, including the dialing prefix, remain identical. A phone-country selector may resolve a unique displayed dialing code from an explicitly international approved phone number; it never infers residence or nationality. “Current location” uses the approved city, with state-name/abbreviation matching to disambiguate actual city options. Plain-text questions immediately above a radio group are discovered only within an isolated owner containing no other fields, so required authorization questions are reported even without a matching bank entry. US-specific sponsorship still needs a matching approved answer. Run `npm run test:yc-fields` for the offline YC contact/radio regression.

Lever forms normalize the `✱` required marker for approved-answer matching and required-field discovery. Filling stays inside the application form. Its `location-input` / `selected-location` widget is handled as an autocomplete: select a unique city/region suggestion, require a changed hidden selection plus matching displayed text, and audit both after stability. Hidden values are never written by the runner. Rejected suggestions, stale payloads, ambiguous cities and delayed resets remain unresolved. Native radio validation is reported once using the question, rather than as separate Yes/No errors. Employer-specific work-country, consent, start-date and essay questions still require their own approved answers. Run `npm run test:lever` for the offline regression; this does not establish live employer acceptance.

Choice controls share deterministic discovery, matching, and final readback: native/styled radios and checkboxes, ARIA radios/checkboxes/switches, buttons with explicit `aria-pressed` state, native single/multiple selects, and standalone ARIA single/multiple listboxes. Question labels come from legends, accessible group names, and ATS annotations; option labels stay separate. Radio names are scoped to their question and form. Hidden native choices can be operated through a unique visible associated label. Arbitrary action buttons are not answers, and a choice button that could submit/reset its form is left for review.

For a multi-select question, supply one exact option or a JSON array encoded in the answer string. For example, local config can contain `"Preferred locations": "[\"New York, NY\",\"Boston\"]"`; the Notion Canonical Answer can contain `["New York, NY","Boston"]`. `[]` explicitly clears an optional group. Commas and prose are never split into guessed choices. The complete set must resolve before any change; stale selections are cleared, and every selected/unselected option is audited. Required groups still need a selection. Yes/No may match complete True/False or Y/N options, but qualified employer options such as “Yes, only if …” are not reduced to Yes.

Office-attendance questions also support bounded whole-question templates in `src/office-attendance.ts`. For example, an approved answer to `Are you comfortable working out of our NYC office 4 days a week?` matches `Are you able to work from our New York City office four days per week?`. Location and weekly day count must match. NYC/New York City are aliases; downtown San Francisco stays separate from San Francisco. Only the listed templates and locations are recognized; added conditions, negation, unknown cities, different schedules, relocation, and remote-work preferences do not inherit the answer. Add an exact Confirmed, Auto-fill OK Answer Bank entry for other wording. US-specific current-or-future sponsorship wording stays separate from current-only and country-unspecified sponsorship answers. No personal office preference is supplied by this feature.

Run `npm run test:choices` for the offline control matrix and office-attendance cases, including rerenders, mixed/disabled states, duplicate options, rejected clicks, delayed resets, config precedence, and no-submit checks. New wording remains an explicit equivalence or an exact approved bank entry; current-only, future-only, negated, country-specific, demographic, and consent questions are not inferred from loosely related answers. This is not universal widget support: custom controls without readable state, shadow-root controls, and unrecognized multi-select combobox/chip widgets require a portal adapter and regression fixture. Local tests do not establish live employer acceptance.

Optional profile fields include `address`, `address2`, `coverLetterPath`, and `coverLetterText`. A cover letter file is uploaded only when an imported selector identifies its file input unambiguously. For semantic fields recognized by Simplify, explicitly supplied `autofill` values can extend the standard profile:

```json
{
  "autofill": {
    "preferred_name": "Alex",
    "phone_country": "United States"
  }
}
```

Use actual values, not these example names. An exact approved answer for a visible question takes precedence over a semantic profile value. The script does not generate prose, infer visa or demographic answers, or call Simplify's answer service. An unknown required field, invalid value, ambiguous option, or unconfirmed continuation prevents submission. Consent checkboxes change only for an exact approved question/answer with Yes/No or True/False.

## Import Simplify compatibility data

The local snapshot imported during this change comes from Simplify Copilot **3.1.10**. To refresh it from your installed package:

```sh
npm run import:simplify -- '/absolute/path/to/extension/version'
```

The importer reads `manifest.json` and `remoteConfig.json` as data and writes `config/simplify-rules.json`. It records the source version and SHA-256. It extracts 54 ATS rule sets in the supplied version, including Greenhouse, Lever, AshbyHQ, Workday, and others. A rule set is not a guarantee of live site compatibility.

The integration uses:

- URL patterns, exclusions, and DOM probes for ATS and embedded-form detection.
- Application containers, known semantic field selectors, and tracked question labels.
- ARIA/custom dropdown option paths and selected-value metadata where supported.
- Apply, continue, final-submit, and success selectors.
- Playwright file uploads, ordinary form events, and reinspection after each fill.

Simplify action programs are not interpreted. Dynamic XPath placeholders, shadow-root path extensions, remote option catalogs, proprietary widget internals remain unsupported. Workday has a separate structured history/education adapter described below. The script uses Playwright interactions for supported controls. Known required fields and native/ARIA invalid markers are checked, but ATS-specific validation can still need manual review.

No Simplify backend client, analytics, cookies, Village/LinkedIn SDK, or extension runtime is loaded. Imported rule records may contain inert action metadata and option-source definitions; these are never executed or fetched. The compatibility snapshot is extracted third-party data for this local integration; its provenance is recorded, and no redistribution license is asserted.

## Application sites

The queue accepts specific job listings from the following platforms:

| Site | Implemented route |
|---|---|
| Greenhouse | Hosted and detected embedded forms |
| Lever | Hosted forms; scoped questions, required-marker normalization, radios/selects, and verified location suggestions |
| Ashby | Job listing to hosted application |
| Y Combinator | Role-specific Apply to role control and scoped applicant dialog; excludes founder application links |
| Workday | Apply Manually, structured history/education/websites, segmented dates, prompt menus, validation, continuation, and final review |
| Indeed | Listing to Indeed Apply/SmartApply, or an employer application link |
| LinkedIn | Easy Apply dialogs and employer application links |
| ZipRecruiter | Quick Apply forms and employer application links |
| Other imported ATSs | URL/embedded detection and the compatible subset of the 54 imported rule sets |

Entry routing follows visible Apply controls before login or filling when an application is not already open, including employer landing pages, embedded frames, and links wrapping Apply buttons. Repeated links to the same application destination are treated as one choice. Hidden controls, empty application wrappers, and a lone email-alert field do not establish an open application. A final form-submit button labelled Apply is left untouched during routing. The board routes follow same-tab navigation and new-tab application links. Both the source listing and resolved employer URL are recorded. The runner checks existing results for the resolved employer URL to reduce duplicate applications from different listings. Search pages and homepages are not application targets. On YC job listings, only **Apply to role** is followed; the navigation’s **Apply** is a founder application. The applicant dialog is scoped so background controls are excluded. Username-first login accepts text inputs with username autocomplete or an explicit email/username label. An established application can fill approved fields while a CAPTCHA remains untouched for manual review. Failed entry results record the actual reached URL.

Sign in through the persistent browser when needed. With `--visible --pause-on-unresolved`, the runner pauses for login or verification and retries detection after you press Resume. It uses the approved profile and answer bank for application questions; unknown required answers still stop the workflow. Immediate one-click submission controls require manual review because they can submit before the script has inspected an application form.

Final submission requires `--submit`. A visible new confirmation message must appear after the click before the result is recorded as submitted. A generic success icon, a job-description JSON-LD block, or a login screen does not establish submission.

These routes have been checked against local synthetic fixtures, including multi-step LinkedIn, Indeed, and ZipRecruiter review screens. Live authenticated layouts and employer-specific customizations still require validation. Custom employer domains can work when the page or an iframe matches an imported ATS probe.

## Checks

```sh
npm run check
npm run build
npm run test:build
npm run test:browser
npm run test:resolution
npm run test:simplify
npm run test:sites
npm run test:workday
npm run test:notion
npm run test:queue
npm run test:entry
npm run test:yc
npm run test:yc-fields
npm run test:lever
npm run test:upload
```

The Simplify fixture checks exercise imported selectors, embedded detection, approved-answer handling, resume upload, dropdown scoping, invalid values, and a two-step form. The site-routing fixtures additionally cover all seven named sites, external application popups, modal-only filling, empty review screens, login handoff/resumption, search-page rejection, and explicit confirmation. They use synthetic pages with external requests intercepted locally. Live ATS compatibility and submission success rates have not been measured.

## Main modules

| File | Purpose |
|---|---|
| `scripts/import-simplify.mjs` | Local package-to-JSON importer |
| `src/simplify.ts` | Rule loading, ATS detection, field annotation, navigation selectors |
| `src/sites.ts` | Board routes and application-dialog selectors |
| `src/application-entry.ts` | Apply controls, popups, redirects, and login/verification handoffs |
| `src/confirmation.ts` | Explicit submission confirmation messages |
| `src/profile-values.ts` | Semantic profile mapping with approved-answer precedence |
| `src/form.ts` | Inspection, dropdowns, upload, filling, validation, submission checks |
| `src/journey.ts` | Bounded optional continuation between application steps |
| `src/notion.ts` | Notion queries, URL/schema mapping, and explicit verified tracking updates |
| `src/job-source.ts` | File, single URL, and Notion source loading |
| `src/job-queue.ts` | Refresh Notion before each selection, enforce current top N, and prevent repeats |
| `src/run.ts` | Shared autofill runner and single-URL CLI |
| `src/dashboard.ts` | Local HTTP server and shared browser worker |
| `src/dashboard-state.ts` | Stable alphabetical queue, selection, tracking, scoped answers and source snapshots |
| `src/application-answers.ts` | Application-only answer eligibility and live approved-answer precedence |
| `web/dashboard.html`, `web/dashboard.css`, `web/dashboard.js` | Plain dashboard interface; no frontend framework |


## Workday structured profile

Workday uses a dedicated adapter in addition to imported selectors. Add verified records to your existing `config/profile.json`:

```json
{
  "experience": [
    {
      "title": "YOUR_JOB_TITLE",
      "company": "YOUR_EMPLOYER",
      "location": "YOUR_LOCATION",
      "description": "YOUR_APPROVED_DESCRIPTION",
      "startDate": "2023-05",
      "current": true
    }
  ],
  "education": [
    {
      "school": "YOUR_SCHOOL",
      "degree": "YOUR_EXACT_DEGREE_OPTION",
      "fieldOfStudy": "YOUR_FIELD_OF_STUDY",
      "startDate": "2018",
      "endDate": "2022"
    }
  ],
  "websites": ["https://YOUR_WEBSITE"]
}
```

Replace every placeholder and example date with your actual information. Employment dates use `YYYY-MM` or `YYYY-MM-DD`; year-only values work when the site asks only for a year. A missing month or day is never inferred. Supply `endDate` for past jobs, and use a boolean `current`. The current-job checkbox is changed only when that flag is present.

The adapter adds required rows for supplied records, fills each row in isolation, and verifies date parts and prompt selections. It does not remove extra existing rows or overwrite conflicting nonempty history fields; those conflicts stop continuation for review. Omit arrays for sections you have not configured. Empty arrays explicitly represent zero supplied records and cause existing extra rows to be flagged, not deleted.

Country, degree, school, and other Workday prompts support exact matching and visible search. An approved value such as `Parent category > Exact child option` expresses a hierarchical menu path. Typed search text is not counted as a committed choice. The adapter checks upload processing and visible Workday error messages before continuing, and recognizes review pages that have no editable controls.

Run `npm run test:workday` for the dedicated local regression. This covers structured rows, segmented dates, current employment, education year fields, websites, rerun idempotence, conflicts, prompt commitment, validation, and final review. Language rows and skill tokens can be supplied through `languages` and `skills`. A language entry has `name`, optional boolean `native`, and optional exact choice text for `reading`, `writing`, `speaking`, `listening`, `overall`, and `level`. `skills` is an array of verified skill names. Site-specific localized widgets, certification sections, and all live tenant variations have not been verified. Recognized sign-in and opt-in account creation use the shared website account settings described above; unsupported account flows and interactive verification still use the manual handoff.

Resume-upload rerenders are checked with `npm run test:upload`. The uploader watches the attachment widget independently of file-input replacement; an unconfirmed or rejected upload is reported for review while other approved factual fields continue filling. Local fixtures cover form replacement and rejected uploads.


## Optional LM Studio autofill and reliability checks

The dashboard’s **Configuration → Answer matching & LM Studio** selects **Without LLM** or
**With LLM**. The default is deterministic only. Start LM Studio’s local server,
click **Check connection & load models**, choose a chat model, and save. An empty
model setting prefers the sole loaded chat model using LM Studio’s native model
inventory; older servers can select the only available model. Multiple loaded
models require an explicit choice. Settings persist in `output/dashboard-state.json`
and apply to the next application. Queue work must be idle before settings change.
The connection check lists models; it does not establish mapping accuracy.

CLI defaults are independent of the dashboard. Optionally copy
`config/autofill.example.json` to `config/autofill.json`, then override per run:

```sh
# Existing deterministic behavior, with no LLM requests:
npm run run -- --url='APPLICATION_URL' --visible --autofill=deterministic

# Deterministic matching first, then local semantic fallback:
npm run run -- --url='APPLICATION_URL' --visible --autofill=llm \
  --lmstudio-url=http://127.0.0.1:1234/v1 --lmstudio-model=MODEL_ID
```

The server URL accepts loopback HTTP endpoints ending in `/v1`. If your LM Studio
server requires authentication, set `LMSTUDIO_API_KEY` in the environment before
starting Formwright; it is never saved in dashboard state or sent to the browser.
No SDK or new dependency is required. This integration follows LM Studio’s
[Chat Completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions),
[structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output),
and [model inventory](https://lmstudio.ai/docs/developer/rest/list) APIs.

The first semantic fallback supports ordinary names, contact details, city/state,
postal codes and profile links. It shortlists up to eight approved candidate
questions from the effective Answer Bank and profile. Only question metadata is
sent to the model; the actual approved values remain inside Formwright. The model
returns a candidate ID or abstains. Independent scope checks exclude immigration,
authorization, salary, consent, demographics, employment history, education,
references and other consequential screening. Exact approved deterministic answers
for those fields continue to work. No model writes answers, controls the browser,
learns aliases automatically, or establishes submission success.

Responses must be complete final JSON with exactly the expected keys, a supported
status and a supplied candidate ID. Page options must match one approved value.
Conflicting approved entries remain unresolved. Invalid JSON, truncated output,
empty final answers, timeouts and connection errors leave fields for review and
stop further inference for that application. A model which emits JSON only in its
reasoning channel is unsupported for that request: use a chat model with a final
JSON response or disable thinking in LM Studio. Formwright deliberately does not
reinterpret reasoning as a final answer. Small-model quality must be measured;
LM Studio notes that some models do not support structured output.

Each application has a 12-call default limit and 15-second per-request timeout
(configurable as `maxCalls` and `timeoutMs`). Resolution decisions are cached only
within that application. Results record mode, model, call count and mapping/error
outcomes in `autofill`; approved values are omitted from these new diagnostics.
Application details show the engine and fallback errors.

The shared form engine now rediscovers controls and reads values after filling,
retries a rejected or replaced field at most once, and counts fills only after
final readback. It also verifies answerable optional controls and flags unknown
required fields even when they contain a nonempty default. Existing resume upload
confirmation, sensitive-answer matching and final-submission checks still apply.

```sh
npm run check
npm run test:llm          # Mock provider contract and fail-closed checks; no model needed
npm run test:robustness   # Offline Chromium recovery and on/off integration fixtures
npm run test:verification # Delayed controls, resets, checkbox answers, and attachment rechecks
npm run test:dashboard    # Queue, HTTP controls and actual mode-selector UI

# Paired deterministic/LLM evaluation with fictional data; no employer sites:
npm run eval:llm -- --lmstudio-model=MODEL_ID
# Short smoke test:
npm run eval:llm -- --lmstudio-model=MODEL_ID --limit=3
```

The evaluation uses 32 curated synthetic cases, reports correct/incorrect/abstained
results by question group and p95 inference latency, and saves a timestamped JSON
report under `output/`. Exit status 1 means an incorrect answer; status 2 means a
provider/format failure. These fixtures test behavior and provide an initial
comparison, not a production ATS accuracy benchmark. Build a reviewed dataset from
actual unresolved questions before expanding semantic fallback to new categories.
No employer application or resume upload is needed for these tests.
