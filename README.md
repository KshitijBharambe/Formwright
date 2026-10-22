# Formwright

Your local workspace for job applications. Bring jobs from Notion or paste employer links, choose your queue, and autofill applications using your profile and approved answers. Review and submit in the employer's browser tab.

**Local first · Human review · No frontend framework**

Formwright is a **vibecoded project**, built with AI assistance and still improving. Feedback, bug reports and contributions are welcome, especially when autofill misses a field, chooses the wrong option or struggles with an application flow. Please open a GitHub issue with the ATS or site, what you expected and what happened. Use fictional examples and redact personal information; never include credentials, résumés or browser-session data.

## Get started

Requires Node.js 22+ and npm. macOS, Linux and Windows are intended targets; browser dependencies vary by OS.

```sh
npm ci
npx playwright install chromium
npm run setup
```

Edit `config/profile.json` with your real details and résumé path. Replace the placeholders in `config/answers.json` with answers you approve, or use `{}` and add answers later. Then:

```sh
npm run dashboard
```

Open [localhost:4318](http://127.0.0.1:4318). Add application links or connect [your Notion pipeline](docs/NOTION.md). Setup never overwrites existing files. An empty job list is valid; Notion, shared login and LM Studio are optional.

## How to use Formwright

**Set up your facts → Add jobs → Select a queue → Autofill → Review in the browser → Submit yourself → Update tracking.**

1. **Prepare your profile and answers.** Put your résumé in `resumes/`, set `resumePath` in `config/profile.json`, and replace all example values. In `config/answers.json`, keep only question/answer pairs you approve; `{}` is valid. Check the effective values in **Answers & profile** before starting.
2. **Bring in jobs.** Click **Add links** and paste direct employer job/application URLs, one per line. The **Add to queue** button saves and selects those links but does not start them. Alternatively, configure Notion and click **Sync**; incoming Notion jobs appear unselected.
3. **Choose what runs.** Select row checkboxes or **Select page**, then open **Review queue** to inspect the selected batch. In **Configuration**, start with one application at a time and deterministic answer matching. Enable continuation if you want Formwright to move between application steps.
4. **Run the queue.** Click **Run queue**. Formwright opens its own browser session and fills supported fields with your supplied facts. Unknown answers, failed uploads, login and verification can require your help. **Pause queue** lets active applications finish before stopping pending work.
5. **Resolve and review.** Open **Needs attention** and the affected row's **Details**. Where offered, **Save answers & queue retry** saves answers for that application and selects a retry; click **Run queue** to start it. Finish CAPTCHA, MFA, consent and unsupported controls in the browser. Check every field, uploaded résumé and step, even when progress says **Ready for review**.
6. **Submit and record it.** Submit in the employer's browser tab after your review. Once the employer confirms submission, use **Mark applied** or choose **Applied** in the row's application status. This records your action; it does not submit the form. Notion tracking writes are read back before being shown as saved.

The dashboard includes the same walkthrough under **How to use**. Read the [first-application walkthrough](docs/GETTING_STARTED.md) for setup details, status meanings and recovery steps, or the [usage reference](docs/USAGE.md) for CLI and advanced settings.

## A faster application desk

- **Inline status:** choose a status directly in the row; it saves immediately. **Mark applied** records a submission you already made. Lifecycle lives under Details.
- **Explicit queue:** select jobs individually or a page at a time, inspect Review queue, then Run queue. Pause lets active applications finish.
- **Dark, light or system appearance:** remembered on this browser, applied before the page paints.
- **Responsive workspace:** mobile layouts, keyboard focus, reduced motion, `/` to search and `N` to add links.
- **Stable updates:** 50 rows per page, unchanged rows stay mounted, row saves leave unrelated rows usable, hidden views render on demand, polling pauses in hidden tabs.
- **Clear source ownership:** GPT Web can populate Notion; Formwright reads the pipeline and eligible selection separately. Incoming jobs never start automatically. Idle source sync runs each minute while the dashboard is visible and can be turned off.

Autofill progress and application status are separate. A filled form is **Ready for review**, not **Applied**. Dashboard autofill never submits. The CLI has a separate explicit submission option; see the [full usage guide](docs/USAGE.md).

## Notion + GPT Web

GPT Web is an optional upstream research tool, not a service Formwright depends on. Use your own Notion database and integration. Formwright reads jobs and approved answers directly through Notion's API; a ChatGPT Notion connection does not authenticate this local program.

The [Notion guide](docs/NOTION.md) includes the schema, setup, a copyable GPT Web instruction, sync rules and concurrent-edit limitations. Manual links work without Notion or a ChatGPT subscription.

## Development

```sh
npm run check
npm test
npm run test:ui
npm run release:check
npm run release:export
```

`npm test` runs the portable queue, Notion, dashboard and core fixtures. `test:ui` covers themes, pagination, rapid independent edits, accessibility basics, responsive layouts and an interaction performance budget. Tests use synthetic data and mocked services. They do not prove live employer acceptance. See [CONTRIBUTING.md](CONTRIBUTING.md).

The frontend is plain HTML, CSS and JavaScript. The backend uses TypeScript, Node's HTTP server and Playwright. No hosted backend, account, analytics, remote fonts or cloud model is required.

## Before publishing

Personal configuration, résumés, browser sessions, job lists and output stay local and are ignored by Git. `release:check` audits the public source set and, when present, tracked Git files. `release:export` creates a fresh, audited source directory under `output/` using an allowlist; it does not publish anything. Review that directory before creating a public repository. The audit is a guardrail, not a guarantee that arbitrary personal information can be detected.

Optional locally extracted Simplify compatibility data is **not distributed** and is outside this project's license. The public source works with built-in adapters; the optional import-specific test requires your own local snapshot. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Limitations

ATS layouts change. Unknown answers, rejected uploads, CAPTCHA, MFA, consent and uncertain submissions require review. Shared credentials, if enabled, are stored locally as plaintext with owner-only permissions. Keep the dashboard on localhost; it is not a multi-user or internet-facing service. See [SECURITY.md](SECURITY.md) and [implementation notes](docs/IMPLEMENTATION.md).

## License

[MIT](LICENSE) for Formwright source. Third-party dependencies retain their own licenses.
