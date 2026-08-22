# Administrative credential history cleanup plan

Status: **plan only — not authorized or executed**.

Removing legacy credential A and legacy credential B from the current source does not remove them from existing Git commits, clones, forks, caches, CI artifacts, or local working copies. Both values must be treated as compromised until the affected accounts have been rotated and the previous credentials have been confirmed invalid.

## Preconditions

1. Rotate each affected account using a unique temporary secret supplied outside Git.
2. Verify the exact target, Supabase project ref, account status, and successful authorized login.
3. Confirm the previous credential no longer authenticates, without recording either value.
4. Inventory GitHub forks, protected branches, open pull requests, CI artifacts, mirrors, deployment caches, and operator clones.
5. Schedule a coordinated maintenance window and repository freeze.
6. Back up refs and document recovery procedures without copying secret values into the plan.

## Proposed history rewrite

1. Define structural/path-based replacement rules for the affected historical file; never paste compromised values into tickets, chat, terminal history, or reports.
2. Test the rewrite against an isolated mirror using an approved history-rewrite tool.
3. Verify build, tests, tags, branches, commit reachability, and absence of credential patterns in the rewritten mirror.
4. Obtain explicit authorization for the destructive rewrite and coordinated force push.
5. Replace affected remote refs in the maintenance window.
6. Invalidate old CI artifacts/caches and require every contributor to re-clone or safely realign local history.
7. Run repository and secret-manager scanning after the rewrite.

## Important limitation

A history rewrite reduces accidental discovery but cannot make a previously published credential trustworthy again. Rotation and invalidation are mandatory even if every known Git ref is rewritten.

Do not execute this plan during Ronda 1 without a separate explicit authorization for history rewriting and coordinated force push.
