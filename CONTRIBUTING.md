# Contributing

Thank you for helping with Pointsman. Issues and pull requests are welcome.

## Before you start

- For a bug, open an issue with what you sent, what you expected and what
  happened. Never paste API tokens or private profiles.
- For a larger change, open an issue first, so we can agree on the approach
  before you write the code.

## Making a change

1. Fork the repository and create a branch.
2. Set up as in the [README](README.md#development): Node.js 24 and pnpm 12,
   then `pnpm install`.
3. Make your change with tests. Keep pull requests small: one topic each.
4. Run `pnpm check` (typecheck, tests, profile validation, public-data check
   and a dry-run deploy). It must pass.
5. Sign off every commit with `git commit -s` (see below), and open a pull
   request.

CI runs the same checks, plus security checks for workflows, dependencies and
secrets.

This is a public repository: do not commit organization-specific data such as
account IDs, real profiles or internal URLs. `pnpm check:public` looks for
common cases. Real deployments keep their configuration in a private
repository (see [docs/deployment.md](docs/deployment.md)).

## Sign-off (DCO)

`Signed-off-by: Name <email>` in a commit states that you agree to the
[Developer Certificate of Origin](https://developercertificate.org/): you wrote
the change or have the right to submit it, and it may be published under this
repository's license (MIT). There is no separate contributor agreement.

- How: `git commit -s` (the name and email must match the commit's author).
- Forgot it: `git rebase --signoff origin/main`, then
  `git push --force-with-lease`. If you would rather not rewrite history, add
  one follow-up commit that signs off the earlier ones, with the text shown in
  the DCO check's details.

The [DCO app](https://github.com/apps/dco) checks that every commit in a pull
request (except bots and merge commits) has a sign-off from its author.

## License

By contributing, you agree that your contribution is published under the
[MIT License](LICENSE).
