# Formwright

Fill out job applications without retyping the same details every time.

Formwright uses Playwright to open application forms and fill supported fields from your profile, résumé and saved answers. A dashboard lets you choose which jobs to run, resolve missing answers and track your applications.

**You review the form and submit it yourself.** Dashboard autofill never submits an application.

[Get started](#get-started) · [How it works](#how-it-works) · [Report an autofill issue](#help-improve-autofill) · [Documentation](#documentation)

## What it does

- **Reuse your details.** Save your profile, résumé path and answers to recurring application questions.
- **Choose your queue.** Paste job links or import them from Notion, then select the applications you want to fill.
- **Fill application forms.** Open supported fields in a browser session and upload your résumé where supported.
- **Handle missing answers.** See which applications need attention, add answers and queue a retry.
- **Track your progress.** Record application statuses locally or sync them with your Notion pipeline.

The dashboard runs on your computer. Notion and local models through LM Studio are optional.

## Get started

You need **Node.js 22+**, npm and a résumé file.

### 1. Install

```sh
git clone https://github.com/KshitijBharambe/Formwright.git
cd Formwright
npm ci
npx playwright install chromium
npm run setup
```

Setup creates local configuration files from examples. It preserves existing files.

### 2. Add your details

| File | What to add |
| --- | --- |
| `config/profile.json` | Your contact details and résumé path. Replace the example values. |
| `config/answers.json` | Answers you want reused on applications. Use `{}` to start without saved answers. |
| `resumes/` | Your résumé file. Set `resumePath` in your profile to match its location. |

Your personal configuration, résumés and browser sessions are excluded from Git.

### 3. Start the dashboard

```sh
npm run dashboard
```

Open **[http://127.0.0.1:4318](http://127.0.0.1:4318)** and check **Answers & profile** before your first run.

## How it works

Start with one application so you can check the entire flow.

| Step | In the dashboard |
| --- | --- |
| Add jobs | Open **Add links** and paste direct job or application URLs, one per line. |
| Choose applications | Select the rows you want, then open **Review queue**. |
| Start autofill | Click **Run queue**. Formwright opens its own browser session. |
| Resolve missing details | Check **Needs attention** and the affected row's **Details**. Save missing answers and queue a retry where offered. |
| Review and submit | Check every field and the uploaded résumé in the employer's tab, then submit yourself. |
| Update tracking | After the employer confirms submission, click **Mark applied**. |

**Ready for review** means autofill has finished its attempt. It does not mean the application is complete or submitted. **Mark applied** updates tracking only.

For a detailed walkthrough, see [Your first application](docs/GETTING_STARTED.md).

## What to expect from autofill

Formwright includes adapters for Greenhouse, Lever, Ashby, Workday and other application platforms. Coverage varies by employer, question type and layout; an adapter does not guarantee that every form on that platform works.

- Unanswered questions and unsupported controls can require manual input.
- Login, CAPTCHA, MFA and email verification can require your help.
- Uploads and selected dropdown values still need your review.
- Employer forms change, so previously working flows can break.

Keep the dashboard on localhost. It is intended for use on your own computer. See [Security](SECURITY.md) for details, including how optional shared credentials are stored.

## Help improve autofill

**Formwright is a vibecoded project, built with AI assistance.** It is still evolving, and feedback on real application forms is welcome.

If autofill misses a field, selects the wrong option or gets stuck, [open an issue](https://github.com/KshitijBharambe/Formwright/issues/new) with:

- The application platform and employer, if you can share them.
- The field or step that failed.
- What you expected and what happened.
- Steps to reproduce, or a screenshot with personal details removed.

Use fictional examples when sharing answers. Keep credentials, résumés and browser-session data out of issues.

Fixes and contributions are welcome too. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

| Guide | Covers |
| --- | --- |
| [First application](docs/GETTING_STARTED.md) | Setup, running a queue and recovering from problems |
| [Notion integration](docs/NOTION.md) | Connecting a pipeline and approved answer bank; optional GPT Web workflow |
| [Usage reference](docs/USAGE.md) | CLI commands, concurrency, optional account login and LM Studio settings |
| [Implementation notes](docs/IMPLEMENTATION.md) | Architecture, current behavior and development direction |
| [Third-party notices](THIRD_PARTY_NOTICES.md) | Dependencies and optional locally imported compatibility data |

## Development

Built with TypeScript, Node.js and Playwright, with a plain HTML, CSS and JavaScript dashboard.

```sh
npm run check         # Type and JavaScript syntax checks
npm test              # Core, queue, Notion and dashboard fixtures
npm run test:ui       # Browser UI checks
npm run release:check # Audit public source for private files and credentials
```

Tests use synthetic data and mocked services; passing tests does not establish that a live employer form works. See the [contribution guide](CONTRIBUTING.md) for adapter tests and publishing checks.

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses.
