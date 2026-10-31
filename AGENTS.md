# Agent guide

An ACP-compatible coding agent powered by the Claude Agent SDK. Source in `src/`,
TypeScript, ESM, Node >= 22.

## Commands

```sh
npm run build         # tsc
npm run test:run      # vitest, single pass
npm run check         # eslint + prettier --check
npm run lint:fix      # eslint --fix
npm run format        # prettier --write
```

CI runs `format:check`, `lint`, `build` and `test:run`. Run `npm run check` before
opening a PR.

## Code comments

Keep comments straightforward, concise, and concrete. Say what the code does and
why, in plain terms: name the actual state, call, or failure involved instead of
alluding to it. Prefer a short concrete example over an abstract description.
Don't use vague phrases like "keeps it honest" or "the residual case" that make
the reader reconstruct the meaning.

## Personal information and repository hygiene (hard rule)

- **Never commit**: local absolute paths (`C:\Users\<name>\...`, `/home/<name>/...`), machine or real user names, device identifiers, real names, private email addresses, phone numbers, social accounts, internal company information, secrets / tokens / cookies / private keys, browser profiles, chat logs, user databases, and logs unrelated to the project.
- **Placeholders and screenshots**: use `C:\path\to\project`, `/home/user/project`, `user@example.com`, `alice` in docs and examples; check image/binary size, remove EXIF / GPS metadata and cover user names, paths, recent projects, and notifications before adding screenshots.
- **Before commit / push**: keep `git status --porcelain` limited to intended files; use `git grep` to scan for real names, email addresses, user names, local paths, hostnames, and device identifiers; check `git log --format='%an <%ae>%n%cn <%ce>' | sort -u`; keep personal contact details and sensitive context out of commit messages; never commit `.env`, `.runtime/`, logs, caches, or user profiles.
- **If information leaks**: clean the working tree first; deleting the file is not enough. If it reached Git history (including tags or remotes), back up a bundle and obtain explicit user authorization before rewriting history. Push rewritten history with `--force-with-lease`, update tags, and notify collaborators.
- The project's own public repository name, package name, copyright holder, upstream source, and public author identity are allowed.

---

## Branch policy (hard rule)

Develop and commit directly on the main branch; do not create feature or fix branches unless the user explicitly asks.

---

## Pull requests

Squash merges use the PR title as the commit subject, and release-please parses it
to compute the next version. Titles must be conventional commits using one of:
`feat`, `fix`, `perf`, `revert`, `docs`, `style`, `chore`, `refactor`, `test`,
`build`, `ci`. `conventional-prs.yml` rejects anything else.

The title also decides the release: `feat:` bumps the minor, `fix:`/`perf:` the
patch, and `chore:`/`ci:`/`test:` and friends do not release at all.

## Releasing

Stable releases are fully automated by release-please. There is no manual release
workflow, and the version is never chosen by hand — it follows from the commit
history.

```sh
npm run release:preflight     # verifies it is safe to release, prints the PR and version
gh pr merge <pr-number> --squash
```

The preflight is the guard-list as code; if it exits non-zero, follow what it
prints rather than merging.

Every _other_ push to `main` publishes a preview to npm — `0.73.1-preview.4` and
so on — under the `preview` dist-tag, tags the commit it came from, and updates
the agent registry the same way a release does. Only `latest` is reserved for
real releases. So anything merged to `main` is published within minutes; there is
no staging branch. Full runbook, including how to recover a stalled release:
[`docs/RELEASES.md`](docs/RELEASES.md).
