# Contributing to FitOS

## Pull request flow

1. Open a pull request with a title matching `[TAG] description` or Conventional Commit format (for example `fix(auth): description`).
2. GitHub Actions runs `lint`, `typecheck`, `test`, `build`, `codeql`, and `secretlint`.
3. Danger posts one structured review comment covering results, PR size, tests, and sensitive paths.
4. A clean PR can be auto-merged with squash when all required checks pass, no review threads remain unresolved, and no sensitive path is changed.
5. Otherwise, the PR remains blocked until the author fixes the reported issue and pushes again.
6. A push to `main` runs the deploy workflow's lint, typecheck, test, build, Secretlint, and CodeQL gate; only then does it call the two Render deploy hooks. Render services also have `autoDeploy: false`, database migrations run once in Render's pre-deploy phase rather than on every restart, and production uses compiled JavaScript so it does not depend on dev-only `ts-node`.

The review bot uses static analysis and open-source tooling only. It does not call a paid AI API. CodeQL, ESLint security rules, SonarJS rules, Secretlint, and Danger provide the automated review. The optional application OpenAI integration is unrelated to PR review and is not used by these workflows.

## Required GitHub settings

Repository administrators must configure these manually:

- Enable **Allow auto-merge** in repository settings.
- Protect `main` and require pull requests.
- Require these exact status checks: `lint`, `typecheck`, `test`, `build`, `codeql`, `secretlint`, and `danger`.
- Require conversation resolution before merging.
- Require at least one human approval for sensitive paths via `.github/CODEOWNERS`.
- Keep the GitHub Actions workflow permission for pull requests at least `Read and write` so Danger and auto-merge can operate.
- Add repository secrets `RENDER_API_DEPLOY_HOOK` and `RENDER_WEB_DEPLOY_HOOK` containing the two Render deploy-hook URLs.
- These secrets are currently missing in this repository. Create one deploy hook per Render service in the Render dashboard, then add both values under **GitHub Settings > Secrets and variables > Actions** before merging to `main`; the deploy workflow intentionally fails with a clear error until both are configured.
- Enable GitHub code scanning under **Settings > Code security and analysis** if CodeQL SARIF findings should be uploaded and shown in the Security tab. The workflow still runs CodeQL queries when upload is disabled.

GitHub controls Actions minutes and CodeQL availability by repository visibility and current plan. See the current [GitHub pricing page](https://github.com/pricing) for the live private-repository quota; no fixed quota is duplicated here.

## Sensitive paths

The following paths always require human review and are excluded from automatic merge:

- `backend/src/db/**`
- `backend/src/common/auth.ts`
- Any `auth` directory
- Any `payment` or `payments` directory
- `.github/workflows/**`
- `render.yaml`

The same policy is recorded in `.github/review-policy.yml` and `.github/CODEOWNERS`. Review those files before enabling branch protection if the list should be narrower or broader.

## Manual override

A maintainer listed in `.github/review-policy.yml` may comment `/override-review` on a pull request. The workflow verifies the commenter, records the override in the workflow summary, and uses GitHub's admin merge path. This is an explicit human override and remains auditable in the Actions run.

## Local checks

```bash
cd backend
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run secretlint
```

When ESLint can apply a safe mechanical fix, the `suggestions` job posts it as a GitHub suggested change. CodeQL and other non-mechanical findings remain blocking annotations with an explanation in the check output; they are never auto-fixed. The seed script uses `ON CONFLICT` for its equipment, exercise, relationship, and food inserts, so rerunning it is idempotent.
