# Spike: Decap CMS as a profile editor

Issue #12. Question: can [Decap CMS](https://decapcms.org/) edit decision
profiles in a private config repository with a form, and commit valid
profiles?

**Short answer: yes for editing; with two conditions.** Decap can show every
part of a profile as a form and writes YAML that our validator accepts. It does
not replace the validator, and its GitHub login needs care so that editors do
not hand out write access to all their repositories.

Tried with Decap CMS 3.16.3 and `decap-server` 3.11.3 (local backend), on copies
of the two example profiles. The config used is
[decap-cms.config.yml](decap-cms.config.yml).

## What works

- **The whole profile fits in a form.** Bilingual text (`en`/`ja`) as an object
  with two fields; model and fallback models as selects; the input mapping and
  the policy rules as lists.
- **Typed questions.** Decap's list "types" use the `type` field to choose the
  form of each question: yes/no (`noul`) with an optional "yes means / no
  means", choice with a list of options, score with a list of levels. Existing
  profiles load with the right form for each question.
- **Field checks before saving.** Required fields, patterns (id, names,
  actions, JSONPath) and list sizes (1 to 64 questions, 2 to 255 options, 2 to
  10 levels) are checked in the form, with our hint texts.
- **Valid output.** Saving an existing profile and creating a new one both gave
  files that `validate-profiles.mjs` accepts. New files are named after the id.

## What does not work (or needs care)

1. **Checks across fields are missing.** A rule `team.p >= 0.85` in a profile
   without a `team` question was saved without a warning; the validator
   rejected it (`"team.p" does not refer to a question of this profile`). The
   same applies to option values used in conditions, and to file name = id
   after a later id change. So profiles must reach `main` only through a pull
   request with the validation workflow, never by a direct commit.
2. **The version is not bumped.** Decap does not know that a changed profile
   needs a new `version`. Today this is noticed only at deploy, after the merge
   (publish-profiles refuses to overwrite a published version). With a form
   editor, a check in the pull request is worth adding: a changed profile file
   must have a higher version than on `main`.
3. **Formatting changes.** Decap rewrites the whole file: comments are dropped
   (also the `yaml-language-server` line), short lists such as
   `{ value: backend, description: … }` become block style, and the yes/no keys
   are quoted (`"true":`). The data is the same, but the first save of a
   hand-written profile gives a large diff.
4. **Optional switches are written out.** Leaving the MCP and decision-log
   switches untouched wrote `mcp: { visible: false }` and
   `log: { store_state: false }`. Harmless (same as the defaults), but noise;
   removing `default: false` from the config may avoid it.
5. **The preview pane** does not show typed questions. It can be turned off;
   the form itself is the useful part.

## Login with GitHub

Decap's GitHub backend has no login of its own: it needs an OAuth endpoint
(Netlify's, Decap's paid hosted one, or one we run). It asks GitHub for the
`repo` scope (`AuthenticationPage.js`: `auth_scope` or `repo`), which with a
classic OAuth App gives the editor's token write access to **every** private
repository the editor can reach. For a config repository that is too much.

Better: a separate **GitHub App** ("Pointsman profile editor") with only
Contents and Pull requests (write), installed only on the config repository.
Its user tokens are limited to that app's permissions and repositories, whatever
scope is asked for. The OAuth endpoint for Decap's login popup is small and can
run in the Pointsman Worker or its own Worker, next to the GitHub login we
already have for MCP. Tokens of GitHub Apps expire after 8 hours; Decap does not
refresh them, so editors log in again after that.

Decap's "editorial workflow" (`publish_mode: editorial_workflow`) saves each
change as a branch and pull request, which is what point 1 needs: the existing
validation workflow runs on it, a person merges, and the deploy publishes.

## Recommendation

Use Decap for people who should not edit YAML, on these terms:

- `publish_mode: editorial_workflow`, and branch protection on `main` in the
  config repository, so every change is a pull request that the validation
  workflow checks.
- A pull-request check that a changed profile has a higher version.
- A dedicated GitHub App for the editor login, installed only on the config
  repository; a small OAuth endpoint for Decap in a Worker.
- Keep hand-edited and form-edited profiles apart, or accept one large
  formatting diff per profile on its first form save.

Not tried: [Sveltia CMS](https://github.com/sveltia/sveltia-cms), which reads
Decap configs and is more actively developed, but is not at 1.0 yet. It would
be a drop-in alternative if Decap's form becomes a problem.

No production code is needed for this decision; the work above can be its own
issue when there are editors who need it.
