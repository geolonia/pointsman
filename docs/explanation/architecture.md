---
title: How Pointsman is built
description: The engine, fact modules, connectors and adapters, and why they are separate.
sidebar: { order: 20 }
---

Pointsman is one engine with parts around it. Each deployment chooses the
parts it needs, so a city's road-closure service and a team's pull-request
checks run the same engine with different modules.

## The parts

<svg class="diagram" viewBox="0 0 460 396" role="img" aria-label="The parts of Pointsman: other systems talk to connectors; connectors use the engine through its API; the engine asks fact modules for facts and runs on a platform through adapters." xmlns="http://www.w3.org/2000/svg">
<!-- Grid: viewBox 460 wide; boxes 210 x 64; column centres 115, 230, 345; rows every 100 from y 16. Drawn by a script with the same shapes in each language. -->
<title>The parts of Pointsman: other systems talk to connectors; connectors use the engine through its API; the engine asks fact modules for facts and runs on a platform through adapters.</title>
<defs><marker id="roles-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0L10 5L0 10z"/></marker></defs>
<path class="line" d="M230 82 V114" marker-end="url(#roles-arrow)" marker-start="url(#roles-arrow)"/>
<path class="line" d="M230 182 V214" marker-end="url(#roles-arrow)" marker-start="url(#roles-arrow)"/>
<path class="line" d="M230 280 V298 H115 V314" marker-end="url(#roles-arrow)"/>
<path class="line" d="M230 298 H345 V314" marker-end="url(#roles-arrow)"/>
<rect class="box" x="125" y="16" width="210" height="64" rx="8"/>
<text class="title" x="230" y="40" text-anchor="middle">Other systems</text>
<text class="small" x="230" y="58" text-anchor="middle">For example a FIWARE</text>
<text class="small" x="230" y="73" text-anchor="middle">platform or GitHub</text>
<rect class="box" x="125" y="116" width="210" height="64" rx="8"/>
<text class="title" x="230" y="140" text-anchor="middle">Connectors</text>
<text class="small" x="230" y="158" text-anchor="middle">Bring cases in and</text>
<text class="small" x="230" y="173" text-anchor="middle">carry results out</text>
<rect class="box go" x="125" y="216" width="210" height="64" rx="8"/>
<text class="title" x="230" y="240" text-anchor="middle">Engine</text>
<text class="small" x="230" y="258" text-anchor="middle">Questions, rules</text>
<text class="small" x="230" y="273" text-anchor="middle">and the decision log</text>
<rect class="box" x="10" y="316" width="210" height="64" rx="8"/>
<text class="title" x="115" y="340" text-anchor="middle">Fact modules</text>
<text class="small" x="115" y="358" text-anchor="middle">Look up facts, for</text>
<text class="small" x="115" y="373" text-anchor="middle">example flood zones</text>
<rect class="box" x="240" y="316" width="210" height="64" rx="8"/>
<text class="title" x="345" y="340" text-anchor="middle">Adapters</text>
<text class="small" x="345" y="358" text-anchor="middle">Run the engine on a</text>
<text class="small" x="345" y="373" text-anchor="middle">platform: log, models</text>
</svg>

- **Engine.** Takes a case, asks the AI model the profile's questions, gets
  the facts, applies the rules and writes the decision log. It knows nothing
  about where the facts come from or which system sent the case.
- **Fact modules** look up facts. Modules are packages in this repository,
  built into the engine (not published on npm). For example flood zones and shelters
  (`@pointsman/facts-gsi`), the way around a closed road
  (`@pointsman/facts-valhalla`), the state of a pull request
  (`@pointsman/github`) or its AI reviews (`@pointsman/coderabbit`). Some
  facts read the engine's own decision log, read-only and only the asking
  client's decisions. See [Fact modules](../modules.md).
- **Connectors** connect another system: they bring its cases in and carry
  the results back, for example to a FIWARE platform (`@pointsman/fiware`)
  or to a pull request as a check on it (`@pointsman/github`). They ask the
  engine through the same public API as any other client, with their own
  token. The GitHub connector can instead make an internal call when it
  runs in the same Cloudflare account: no token, but the same checks.
  Anyone who can deploy code to that account can make such a call, so it
  decides as one fixed client with a fixed list of profiles; see
  [internal calls](../adapters.md#internal-calls) and
  [Connectors](../connectors.md).
- **Adapters** connect the engine to the platform it runs on: where the
  decision log and the profiles are stored, which AI service answers, how
  requests come in, and how a connector in another Worker calls the engine.
  Today that is Cloudflare Workers, Cloudflare's service for running code
  on its servers. See
  [Adapters](../adapters.md).

One package can have more than one role: `@pointsman/github` looks up facts
and is a connector.

## Why the parts are separate

- **Small engine.** A new data source or a new system is a new module, not a
  change to the engine. The engine stays the same for every deployment.
- **Each deployment chooses.** A deployment lists its modules, and can pin
  their versions. Every decision records the versions of the engine and of
  the modules that answered its facts.
- **No lock-in.** The engine core uses no Cloudflare-specific code; a check
  of its types and imports covers this. Another platform needs other adapters, but the
  profiles and their rules stay the same.

Which modules and connectors exist, with their fact types, actions and
settings, is listed in [Fact types](../reference/fact-types.md) and
[Connectors](../reference/connectors.md).
