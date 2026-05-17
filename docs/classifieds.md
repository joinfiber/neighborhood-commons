# Classifieds — One Sustainability Mechanism

**Status:** Designed, not built. Outlined here for reference and future planning.

## What this is

A structured public-offers system, distributed through participating local publications, that could fund the Commons and route revenue to local media. It's one viable answer to "how does the Commons sustain itself long-term?" — not the only one, but the one most fully designed at this point. Other paths (grants, foundation partnerships, participant cost-sharing) remain valid; classifieds are the path that the substrate's existing primitives naturally enable.

The mechanism is deliberately retro: classifieds. Structured offers — jobs, housing, services, lost-and-found, for-sale, professional listings — published by organizations into the substrate, then distributed for a fee through participating publications. The format that funded local newspapers for a hundred and fifty years, rebuilt openly.

## Why this works

Three properties make this mechanism distinctive:

**Anti-monopolistic by construction.** Publications set their own per-ad rates and choose their own accepted categories. Billy Penn takes job listings, doesn't take lost-dog posts. The Fishtown neighborhood newsletter takes everything cheap. A trade publication takes only industry-relevant ads. Ad-buyers see a transparent menu — by zip code, publication, category, price — and pick the surfaces they want. Competition between publications keeps rates honest. No central marketplace setting prices. No single platform extracting the lion's share.

**Anti-surveillance by design.** Targeting is by app or publication affinity (a self-declared audience signal), never by individual user behavior. An ad-buyer reaches "people who read the Fishtown newsletter" or "people who use the parish app." They cannot target individuals; they cannot retarget; they cannot build behavioral profiles. The reader's only signal to advertisers is the app or publication they chose to read.

**Aligned with local media's interest.** Revenue flows from advertiser through the Commons to the participating publication, with the Commons taking a small infrastructure cut. The bulk goes to the publication carrying the ad. This restores the classifieds revenue local media lost to Craigslist and Facebook — not as a charity, but as an actual business model that the substrate enables.

## The market structure

```
[Ad buyer]
    │
    │ purchases an ad with selections:
    │  - zip codes / regions to reach
    │  - publications to appear in
    │  - category (job, housing, service, etc.)
    │  - duration (weeks)
    ▼
[Commons]
    │
    │ routes the ad to selected publications
    │ aggregates payment, takes infrastructure cut
    │ remits to publications based on placements
    ▼
[Participating publications]
    │
    │ display the ad in a dedicated classifieds section
    │ no inline placement, no algorithmic intermixing
    ▼
[Readers]
    │
    │ visit the classifieds section if they want to
    │ are never tracked, profiled, or retargeted
```

## Roles in the system

**The advertiser** — an organization with an authority over what they're offering. A plumber publishes their own service ad. A landlord publishes their own rental listing. A foster family publishes their own pet-rehoming notice. No third-party aggregation; the constrained-publishing principle extends to classifieds.

**Publications** — local outlets that have opted in to carry classifieds. Each sets their own:
- Per-ad rate (in whatever currency the Commons supports; likely USD per week)
- Accepted categories (subset of the Commons' classified categories)
- Geographic reach description (for the ad-buyer's menu)
- Content policies (their own editorial discretion)

**The Commons** — runs the infrastructure: ad submission, payment routing, placement tracking, attribution. Takes a small per-ad infrastructure fee. Does not set rates. Does not curate which publications participate beyond a minimal eligibility review.

**Readers** — encounter classifieds in the dedicated section of whichever publications they choose to read. Are anonymous to the system; no individual tracking.

## Anti-surveillance discipline

This is the part that makes the mechanism morally distinct from modern adtech. Specific commitments:

- **No tracking pixels.** Classifieds are displayed as static structured content, not as ad-network units. No third-party scripts, no retargeting infrastructure.
- **No individual targeting.** The targeting primitives are: geography (zip code, region), publication, category. There is no "show this ad to people who clicked X" capability.
- **No behavioral profiling.** The Commons holds no reader profiles. The participating publications maintain their own reader relationships, but the classifieds system does not request or use individual reader data.
- **Dedicated section, not inline.** Classifieds appear in a clearly-labeled section of each participating publication. They do not interleave with editorial content. Readers know when they're looking at ads.
- **Transparent attribution.** Every ad shows who placed it (the organization) and which publication carries it. No misdirection.

These commitments mean the system intentionally underperforms surveillance-based adtech on conversion metrics. That's a feature. The mechanism is for advertisers who want to reach an actual local audience honestly, not for advertisers chasing micro-conversion optimization.

## Sustainability math

Rough order-of-magnitude estimate:

- ~$1/ad/week per publication × ~4,000 weekly active placements ≈ ~$208K/year to the Commons
- Bulk of advertiser spending flows to publications
- $1/week per publication is probably a high anchor; rates can drop as scale grows because marginal infrastructure cost is near zero

Whether 4,000 weekly placements is achievable depends on the app-proliferation bet: that the Commons substrate lowers the barrier to building niche apps, so the ecosystem grows to dozens or hundreds of participating publications across affinity groups (parish apps, school PTA apps, hobby clubs, neighborhood newsletters). Each app is a publication; each publication is a surface; each surface can carry classifieds.

If the app proliferation arrives, the math works. If it doesn't, the Commons needs alternative funding paths or stays grant-dependent longer.

## If grants are part of the funding mix

Grant funding is one of several pathways that could support the Commons; it's not the primary identity. If grants do get pursued, a natural two-layer shape:

**Bootstrap grant.** Funds the initial substrate build-out plus the first wave of partner apps and participating publications. Once classifieds revenue (or other earned revenue) is flowing at sustainable volume, ongoing operations are self-funded. The grant is finite; the system that emerges is durable.

**Expansion grants.** Funds specific functional expansions: adding new public-fact types (civic notices, public-health alerts, jobs, professional services), expanding to new cities, building new verification methods, supporting partner ecosystems. Each expansion has its own value proposition. Operations stay self-funded; growth is funded by mission-aligned philanthropy.

This shape would replace perpetual-operating-grant dependence with grant + earned revenue. But it's optional, not load-bearing. The Commons can also sustain through:
- **Classifieds revenue alone** — at scale, the math works
- **Foundation partnerships** — a press-aligned foundation might fund the press rev-share work; a civic-tech foundation might fund expansion
- **Participant cost-sharing** — multiple apps/publications drawing on the substrate could cooperatively fund operations
- **Some combination of the above**

The Commons doesn't have to win any single funding pathway. It needs to be useful enough to participants that some combination emerges as it grows.

## The app-proliferation bet

The mechanism only works if many publications exist. The Commons makes many publications possible by removing the data-layer barrier: building a niche neighborhood app no longer requires building a neighborhood-data backend. The substrate is there; the app builds on top.

The bet is that this lowering of the bar produces a richer ecosystem over time:
- Parish apps for individual congregations
- School PTA apps
- Hobby club apps (chess clubs, knitting groups, makerspaces)
- Neighborhood-specific apps (Pennsport Pulse, Fishtown Today)
- Affinity apps (queer Philly, immigrant community apps, faith-community apps)
- Civic apps focused on government meetings and public hearings

Each app serves a self-selected audience. Each audience is an affinity. Ad-buyers reach those affinities by buying across the apps that serve them. Targeting happens by audience choice, not by surveillance.

If this proliferation happens, classifieds become a meaningful revenue stream for local media of all sizes. If it doesn't, the Commons is still a useful public-facts substrate — but the sustainability story needs a different mechanism.

## What's not in this design

Deliberately scoped out for the initial implementation:

- **Payment processing.** Will be needed when classifieds ship; outsourced to a standard provider (Stripe likely). Not a core Commons concern.
- **Ad approval workflows.** Each publication handles their own editorial review. The Commons may surface a minimal compliance check (no obvious fraud, no hate speech) but is not the editorial gatekeeper.
- **Programmatic ad-buying.** No real-time bidding, no API for bulk-buying. Advertisers submit ads via a simple form; the menu of placement options is human-readable.
- **Performance metrics.** No view counts, no click-through tracking, no conversion attribution. Publications may track their own ad performance internally; the Commons does not.
- **Multi-currency or international support.** US-focused initially, USD only. Internationalization is a future concern.

## What needs to be designed before building

When implementation work begins (post-grant), specific design questions to answer:

- The classified schema (categories, fields, content limits)
- The participating-publication schema (rate-setting, category-acceptance, payout details)
- The ad placement schema (which ads in which publications during which periods)
- The payment routing and settlement design
- The publication eligibility review process (minimal but defensible)
- The advertiser-facing menu UX
- The content policy baseline (what the Commons absolutely will not carry, beyond publication-level policies)

These are not solved here. This document is the conceptual outline. Implementation design happens at the moment the work is funded.

## How this connects to the rest of the Commons

Classifieds reuse the substrate's existing primitives:
- An advertiser is an `Organization` — with the same authority constraints as any other publisher.
- A classified is a `Type B` artifact — first-party-rooted, attributed, openly licensed within the substrate.
- A participating publication is itself an `Organization` with a `publication` tag.
- Placement happens via routing logic, not via a new primitive class.

The schema delta when classifieds ship is small: a `classifieds` table, a `participating_publications` table (or a tag + extension on organizations), a `classified_placements` table. Migration is bounded.

The verification system that anchors Type A authority also anchors classified authorship — only verified organizations can place classifieds, ensuring authority over the offer being made. This extends a discipline that already exists; it doesn't add a new one.

## License posture

Classified data is published under CC BY 4.0, the same as all other Commons data. Anyone can read and republish; the advertiser warrants they have rights to the content; takedowns work the same way they do for other content.

The paid-distribution overlay is contractual (between advertiser, Commons, and publication), not licensing-based. The CC BY license on the data itself doesn't change; what's paid for is *placement in specific surfaces*, not the data's usability.

## In summary

The Commons funds itself through classifieds — structured public offers from organizations, distributed for a fee through participating local publications, with anti-monopolistic market dynamics and anti-surveillance discipline. The mechanism routes revenue to local media, replaces perpetual grant dependence, and earns its way to long-term sustainability if the app-proliferation bet pays off.

Designed now, built when funded.
