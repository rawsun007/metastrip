# Keeping the site up

MetaStrip is a static site on a Vercel Hobby plan. Nothing runs on a server, so
there is no database to fall over and no function to time out. The only way
this site goes dark is running out of free tier, which happens two ways:

| Limit | Hobby allowance | What spends it |
|---|---|---|
| Edge requests | 1,000,000 / month | every file every visitor asks for |
| Fast data transfer | 100 GB / month | the bytes those files weigh |

Both are per month and both are spent by traffic you did not ask for, which is
why a bot sweep or someone posting the link somewhere busy costs the same as
real users.

## What the code already does about it

A cold first visit costs **about 5 requests and 332 KB**. It used to be about
20 requests and 576 KB.

- **One script, not sixteen.** `js/` is concatenated into `js/bundle.js` by
  `build.mjs`. Fifteen requests saved per visit, which is most of the win.
- **Assets are immutable and cached for a year.** The bundle is version
  stamped in the tag, so a release changes the URL rather than needing a
  revalidation round trip.
- **HTML is cached at the edge** with `s-maxage=86400` and
  `stale-while-revalidate`, so a spike is served from the CDN instead of
  hitting the origin.
- **The service worker is cache-first for assets.** A returning visitor costs
  roughly one request and no asset bytes at all.
- **The portrait was 302 KB for a 210 px circle.** It is 47 KB now.

That takes the ceiling from around 50,000 visits a month to around 200,000
before requests run out.

## What you have to click, and when

None of this is in the repo. It lives in the Vercel dashboard.

### Turn on now, leave on

**Bot Protection.** Project → Firewall → Bot Protection. Free on every plan,
one click, no configuration. Heuristics that separate browser traffic from
scripted traffic. This is the thing that quietly eats most sweeps.

**Usage alerts.** Account → Usage → set a notification threshold at 50 percent
and 80 percent. You want to know on the day, not when the site stops.

### Turn on during an attack, turn off after

**Attack Challenge Mode.** Project → Firewall → Attack Challenge Mode.

This is the important one, for a reason that is easy to miss: **requests
blocked by Attack Challenge Mode do not count toward your usage.** Every
visitor gets a browser challenge before the site loads, known good crawlers
pass through, and the flood stops spending your allowance.

It is free on every plan including Hobby. Turn it off once traffic looks normal,
because a challenge in front of a privacy tool is friction for real people.

### Know the shape of the failure

If you do run out on Hobby, deployments pause. Already-deployed static content
generally keeps serving, so the site does not necessarily vanish, but you cannot
ship a fix until the window resets, and the reset is 30 days from when you hit
the limit rather than the first of the month.

## If it happens again

1. Vercel → Project → Firewall, turn on **Attack Challenge Mode**. Blocked
   requests stop counting immediately.
2. Look at Firewall → traffic, filter by path and by user agent. A sweep is
   usually one path, one agent, one region.
3. If it is one path, add a **deny rule** for it. If it is one country or one
   ASN and you have no real users there, deny that.
4. Leave it running for an hour after the graph flattens, then turn Attack
   Challenge Mode off and keep Bot Protection on.

## The two structural fixes

Everything above is mitigation. These actually change the exposure.

**Put a custom domain behind Cloudflare.** This is the real answer and it is
free. Buy a domain, point it at Cloudflare, proxy it to Vercel. Cloudflare
caches the static files at its edge and serves them without Vercel ever seeing
the request, so a flood costs you nothing. This is not possible on a
`*.vercel.app` subdomain, which is the main argument for buying the domain.

**Know which plan you are allowed to be on.** Vercel's Hobby plan is
non-commercial use only. MetaStrip takes no money and sells nothing, so it
qualifies today. If that ever changes, so does the plan.

## Rebuilding after a code change

```bash
node build.mjs     # regenerates js/bundle.js
node tests/run.mjs # fails if the bundle is stale
```

The bundle is committed so the site works on any static server with no build
step. The test compares it against its sources, so a forgotten rebuild is a red
test rather than a bug in production.
