# Mass LinkedIn Profile Scraper for Bulk URLs

**Process large LinkedIn URL files with concurrent, resumable runs and every source field preserved.**

Designed for bulk profile lists. Paste URLs, upload CSV, set concurrency, and optionally provide a `resumeId`. Re-running with the same ID skips URLs already completed.

**Mawsool LinkedIn data suite:** use **Current Company Checker** for a cheaper freshness audit, **Job Change Detector** for recurring monitoring, or **Profile Details from URL** for smaller interactive batches.

## Can it handle millions of LinkedIn URLs?

The Actor accepts up to **1,000,000 unique URLs per run**. Completion depends on your Apify timeout, spending limit, plan, and chosen concurrency. Start with 1,000 URLs, measure throughput, then scale.

## What data is returned?

The same complete source payload as LinkedIn Profile Details: profile identity, about, current company, experience when available, education, courses, languages, certifications, publications, patents, organizations, activity, followers, connections, and all other API fields.

This is not a guaranteed complete employment timeline. Experience dates can be empty; email and phone are not included.

## Pricing

Same data, same price as the standard Actor: **$1.80 / 1,000** on FREE, with automatic paid-plan discounts down to $0.80 / 1,000.

## Operational controls

- 1–100 concurrent requests.
- `maxUrls` cost cap.
- `resumeId` persists one completion marker per URL.
- Stops when the run spending limit is reached.

## FAQ

### When do I use the mass profile Actor?

Use it for lists up to 1,000,000 profile URLs. The price per profile is the same as Profile Details, $1.80 per 1,000. A stopped run continues finished URLs on the next start.

## Where to run it

Run the published Actor on Apify, or start from [mawsool.tech](https://mawsool.tech). This repository does not include the lookup address.
