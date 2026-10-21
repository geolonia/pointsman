# Examples by use case

Pointsman is one engine. These folders show what it does today for a few
kinds of work. Each topic lists the example profiles, facts and clients
that belong to it, and how to try them.

| Topic | What Pointsman decides | Pieces |
|---|---|---|
| [Disaster response](disaster-response/) | Check reported road closures before they are published; alert when people on foot are cut off from an evacuation site | 3 profiles, flood / shelter / detour facts, FIWARE bridge |
| [DevOps](devops/) | Is a slow deploy stuck, or still making progress? | 1 profile, deploy watch action |
| [Developer workflow](developer-workflow/) | Which team gets a new issue, and is it urgent? | 1 profile, issue triage action |

The profiles themselves stay in [profiles/](profiles/), one flat folder.
The build, the validator, the tests and config repositories read that folder,
and links to the files stay the same. A topic folder only explains and links.

These are examples. Real profiles live in your own private config
repository; see [docs/deployment.md](../docs/deployment.md).
