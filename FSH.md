# FSH delivery branch

This branch (`fsh`) is [Full Stack House](https://fullstack.house)'s delivery branch for
Open Mercato. It carries **only patches that are already open as pull requests upstream**,
so that client deployments don't have to wait for an upstream release to pick up a fix we
have already written.

It is **not** a fork of the project in any other sense: no FSH-only features, no divergent
roadmap, no renamed packages beyond the publishing scope below. Every commit here is meant
to disappear the moment upstream merges its PR.

## Branches

| Branch | Role |
| --- | --- |
| `main` | Bit-for-bit mirror of `open-mercato/open-mercato@main`. Upstream PR branches are cut from here. Never carries FSH commits. |
| `fsh` | Upstream + FSH patches in flight. Deployed to FSH clients. |

## Rules

1. **Every commit on `fsh` carries an `Upstream-PR:` trailer** pointing at its pull request
   in `open-mercato/open-mercato`:

   ```
   fix(query_index): don't drop custom field filters on re-index

   Upstream-PR: https://github.com/open-mercato/open-mercato/pull/1234
   ```

   A commit without one has no way out of this branch, and we pay for it at every sync.

2. **When upstream merges a patch, drop our commit** at the next sync. This branch is a
   queue that drains, not a ledger that grows.

3. **Never modify a file that upstream also owns** — `README.md`, `CONTRIBUTING.md`,
   `AGENTS.md`, `CLAUDE.md`, configs — for FSH-specific reasons. Every shared file we touch
   becomes a merge conflict on every sync, permanently. This file exists as a new path for
   exactly that reason.

4. **New functionality does not belong here.** Client-specific work goes into the project's
   own `src/modules/`; anything reusable goes into a standalone `@fullstackhouse/*` package
   installed alongside Open Mercato. Only fixes to core that are being upstreamed live on
   this branch.

5. **Keep patches small and isolated.** The sync cost is proportional to blast radius.

## Adding a patch

```bash
git fetch upstream
git checkout -b fix/<slug> upstream/main       # cut from upstream, not from fsh
# ...commit, with the Upstream-PR trailer once the PR exists
git push fsh fix/<slug>                        # open the PR upstream from this branch

git checkout fsh
git cherry-pick <sha>                          # then bring it onto the delivery branch
git push fsh fsh
```

Opening the upstream PR first is what keeps rule 1 true by construction.

## Syncing with upstream

Weekly, not "when something breaks":

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push fsh main
git checkout fsh && git merge main              # drop commits already merged upstream
```

The GitHub "Sync fork" API needs a token with `workflow` scope because upstream ships
workflow files; syncing over plain git avoids that entirely.

## Releasing

Packages are published from `fsh` to GitHub Packages as `@fullstackhouse/om-<package>`,
versioned `<upstream-version>-fsh.<n>` — e.g. `@fullstackhouse/om-core@0.6.4-fsh.1` for a
patch on top of upstream `0.6.4`.

## Consuming in a project

```yaml
# .yarnrc.yml
npmScopes:
  fullstackhouse:
    npmRegistryServer: "https://npm.pkg.github.com"
    npmAlwaysAuth: true
    npmAuthToken: "${GITHUB_PACKAGES_TOKEN}"
```

```jsonc
// package.json
"resolutions": {
  "@open-mercato/core": "npm:@fullstackhouse/om-core@0.6.4-fsh.1",
  "@open-mercato/shared": "npm:@fullstackhouse/om-shared@0.6.4-fsh.1"
}
```

Application imports are unchanged — the alias installs into `node_modules/@open-mercato/<pkg>`.

**Cover every `@open-mercato/*` package you depend on, including transitive ones.** Open
Mercato packages depend on each other under their original names; any package missing from
`resolutions` is resolved from public npm instead, leaving two copies of Open Mercato
installed side by side.

## Upstream

Bugs and improvements belong in
[`open-mercato/open-mercato`](https://github.com/open-mercato/open-mercato) — please open
them there, not here. This branch exists to keep FSH deliveries unblocked while those PRs
are reviewed, and it tracks upstream continuously.
