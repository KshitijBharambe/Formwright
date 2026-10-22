# Contributing

Use Node.js 22+ and `npm ci`. Install Chromium with `npx playwright install chromium` (`--with-deps` on Linux CI). Run `npm run setup` for fictional placeholders, then edit local config only when you need an interactive run.

Run `npm run check`, `npm test` and `npm run test:ui`. Tests create isolated temporary workspaces and intercept Notion/employer traffic. Adapter-specific `test:*` scripts cover additional behavior. `test:simplify` alone requires an optional user-provided local compatibility snapshot and is not part of portable CI. Do not upload that snapshot.

Preserve these boundaries: dashboard autofill never submits; failed source refreshes never fall back to stale links; unknown answers stay unresolved; statuses must be verified after writes; credentials never enter UI state or logs. Test behavior using fictional candidates and employer fixtures, not saved browser sessions or personal Notion records.

Frontend assets live in `web/`; server/state are `src/dashboard*.ts`. Keep system fonts, no runtime frontend dependencies, theme tokens, keyboard focus and reduced-motion support. At most 50 application rows mount per page. The synthetic UI benchmark uses 1,000 jobs and 4x Chromium CPU throttling; it is a lab regression check, not a field performance claim.

Before publishing changes, run `npm run release:check`. Review every staged file. Never commit local configuration, user answers, résumés, screenshots of personal data, browser storage or output. Use `npm run release:export` for a clean allowlisted source copy.
