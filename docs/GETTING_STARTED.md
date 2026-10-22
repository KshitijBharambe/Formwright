# Your first application with Formwright

Formwright fills supported application fields from facts and answers you supply. You choose the jobs, review the employer's form, and submit yourself. Start with one application so you can see the whole flow.

## 1. Install and prepare your facts

From the downloaded or cloned Formwright folder, with Node.js 22+ and npm installed:

```sh
npm ci
npx playwright install chromium
npm run setup
```

On Linux, if Playwright reports missing system libraries, use `npx playwright install --with-deps chromium`. Setup creates local profile/answer files and an empty job list; it preserves existing files.

- Put your résumé in `resumes/`, for example `resumes/backend.pdf`.
- Edit `config/profile.json`: replace the sample name, contact details, location and links, and set `resumePath` to your file. Paths are relative to the Formwright folder. Remove optional values you do not want used. Use verified records for optional work history and education; the [usage reference](USAGE.md#workday-structured-profile) describes their format.
- Edit `config/answers.json`: replace the example question/answer pairs with answers you approve, or use `{}`. Delete unanswered entries rather than leaving placeholder text. Legal, immigration, salary, demographic and consent answers are never inferred for you.

Start the dashboard and open [localhost:4318](http://127.0.0.1:4318):

```sh
npm run dashboard
```

Open **Answers & profile** and review the values before running an application. Edit local files in your editor and click **Sync** to reload them. Do not upload private config or your résumé to GitHub.

## 2. Add jobs

Choose either source, or use both:

- **Manual links:** click **Add links**, paste direct employer job/application URLs, one per line, then click **Add to queue**. Valid links are saved and selected. Nothing starts until you click **Run queue**. Search pages and board homepages are not application targets.
- **Notion:** follow the [Notion setup guide](NOTION.md), then click **Sync**. Notion is optional and needs your own integration token. New synced jobs appear unselected. A connected Answer Bank supplies only nonempty **Confirmed** answers with **Auto-fill OK** checked; those approved answers take precedence over equivalent local answers.

Manual links stay local; adding one does not create a Notion record. Notion jobs are rechecked before each application starts. If a source refresh fails, resolve the error and sync again before retrying.

## 3. Inspect the selected queue

In **Applications**, check individual rows or use **Select page**. Select page affects only eligible rows on the current page, up to 50 rows. Open **Review queue** to inspect the batch; clear a checkbox to leave a job tracked without running it. Search and filters can hide selected jobs, so review the queue before starting.

In **Configuration**, begin with **Applications to fill at once = 1** and **Without LLM: deterministic only**. **Continue between application steps** allows supported Continue/Next controls, up to eight steps, stopping at unanswered questions or final review. With continuation off, handle subsequent steps yourself in the browser.

Shared website credentials and LM Studio are optional. Existing browser sessions are tried first. Enable automatic login only for hostnames you explicitly allow; CAPTCHA, MFA and email verification still need you. Model connection checks do not establish answer-matching accuracy. See the [usage reference](USAGE.md) before enabling either feature.

## 4. Run autofill

Click **Run queue**. Formwright opens its own persistent Chromium session; it does not attach to your existing Chrome or Arc profile. Supported fields use your profile and approved answers. Filled tabs stay open for review.

**Pause queue** allows active applications to finish, then stops pending work. Wait for active work to become idle before changing queue settings or tracking. Restarting restores pending work paused; it does not silently resume the queue.

## 5. Resolve anything that needs attention

Open **Needs attention**, then the affected row's **Details**. Read the message and inspect the employer's tab.

| Progress | What to do |
| --- | --- |
| Ready for review | Inspect every field, uploaded attachment and application step. This does not mean submitted. |
| Needs information | Where offered, supply an explicit answer under the row and choose **Save answers & queue retry**, then **Run queue**. Those answers apply only to that application. |
| Error or Interrupted | Inspect Details and the browser, correct the cause, and use the offered retry control when appropriate. |
| Verify submission | Check the employer's confirmation or application history before doing anything else; avoid submitting twice. |

Login, CAPTCHA, MFA, consent, failed uploads, uncertain options and unsupported widgets may require manual completion. A retry can return to the same problem if the supplied value cannot match the employer's choices. Do not replace an approved fact just to make a control accept it.

Saving an application-specific answer does not change your profile or global Answer Bank, and does not override an existing approved global answer. If a reusable approved answer needs correction, update its source and sync.

## 6. Submit, then record the outcome

Review the employer's entire form and résumé, complete any remaining steps, and click the employer's final submit control yourself. The dashboard never submits applications.

After the employer confirms submission, click **Mark applied** where available, or select **Applied** in the row's application status. **Apply** means you intend to apply; **Applied** means you have submitted. Tracking is separate from autofill progress. A status change saves immediately and removes pending work for that application.

For Notion-linked jobs, tracking requires update-content permission and an existing matching status option. Formwright reads the page back to verify the saved value; an error beneath the row means it could not verify the update. Manual jobs keep tracking locally. Applied, Rejected, Closed and Archived jobs remain tracked but are blocked from autofill.

## Common questions

- **The dashboard is empty.** Add a direct link, populate `data/jobs.txt`, or configure Notion and sync. Setup intentionally creates an empty list.
- **A source is stale.** Check the error in the relevant view, correct the mapping/token/file, and click **Sync**. A displayed old snapshot does not authorize running a stale Notion link.
- **My résumé did not upload.** Check `resumePath`, confirm the file exists and matches the employer's allowed format, then inspect the upload widget. Upload it manually if needed.
- **The default port is busy.** Run `npm run dashboard -- --port=4320` and open `http://127.0.0.1:4320`.
- **I want to remove a job.** Under **Details**, choose **Remove from dashboard**. It does not delete the Notion record or results. Use **Removed → Restore** to bring it back; restoration does not select it.
- **Can I close Formwright?** Stop the dashboard with Ctrl+C when finished. Keep the dashboard process running while using its review session. Local queue state and results persist in `output/`; browser sessions persist in `.browser/`.

The [usage reference](USAGE.md) covers CLI flags, multi-step forms, structured profiles and adapter limits. The CLI has an explicit `--submit` mode separate from the dashboard workflow above. Local fixtures test supported behavior; live employer layouts and acceptance still need review.
