# Security

Formwright is a single-user local tool. Bind it only to localhost. It is not designed for remote hosting, shared-machine access or public tunnels. Local users can see profile and approved answer values; the dashboard omits Notion tokens and saved passwords.

Private data includes `config/*.json` except explicit examples, `data/jobs.txt`, `resumes/`, `.browser/`, `.env*` and `output/`. Optional shared-account credentials are plaintext with owner-only permissions, not OS-keychain encrypted. Do not attach these files to issues. Sanitize logs and screenshots.

Use read-only Notion access unless you need explicit status updates. Never place tokens in example files or GPT prompts. Submission is disabled in the dashboard. CLI submission requires an explicit flag. CAPTCHA, MFA, consent and unknown required answers are manual handoffs.

If a token is accidentally published, revoke it and remove it from Git history. Do not rely on deleting the latest file alone. The release checker detects common leaks and forbidden paths; it cannot identify every kind of personal data.

For vulnerabilities, use the repository's private security advisory channel once the public repository enables it. Do not post credentials or personal applicant data in public issues. No dedicated disclosure email or response SLA is configured yet.
