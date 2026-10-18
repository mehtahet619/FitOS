# FitOS post-launch growth setup

## Current architecture

- Frontend: static HTML, CSS, and vanilla JavaScript in `frontend/`, deployed as the Render static site `adaptive-fit-web`.
- API: Express + TypeScript in `backend/`, deployed as Render web service `adaptive-fit-api`.
- Database: existing configured MySQL/TiDB-compatible database, migrated by `npm run migrate:mysql:prod` before API startup.
- Public canonical origin configured in Render: `https://adaptive-fit-web.onrender.com`. Change `PUBLIC_SITE_URL` only after the actual custom domain is configured and DNS/TLS are verified.
- Public crawl targets: homepage, `/terms`, and `/privacy`. Authenticated application screens should not be indexed.

## Analytics implementation

Optional Google Analytics 4 and Microsoft Clarity scripts are not loaded until a visitor accepts analytics. The frontend sends a small allowlist of events without event parameters or request data: `sign_up`, `login`, `workout_plan_created`, `workout_generated`, and `equipment_analysis_completed`. Do not add email, user IDs, workout contents, request bodies, passwords, OTPs, or tokens to analytics.

Set these optional environment variables on the Render **static site** service `adaptive-fit-web`:

- `GA4_MEASUREMENT_ID`: a GA4 web measurement ID like `G-XXXXXXXXXX`.
- `CLARITY_PROJECT_ID`: the project ID from Microsoft Clarity.

The values are public measurement IDs, not secrets. The build injects them into `frontend/config.js`; the scripts remain inactive until consent. After changing either value, trigger a frontend deployment.

## Google Search Console

1. Open [Google Search Console](https://search.google.com/search-console/).
2. Add a URL-prefix property for the exact canonical URL, currently `https://adaptive-fit-web.onrender.com/`. If a custom domain becomes canonical, add and verify that origin too.
3. Use the HTML tag verification method if DNS access is unavailable. Add the verification meta tag to `frontend/index.html` only after receiving the real token; never invent one.
4. Open **Sitemaps** and submit `sitemap.xml`.
5. Use **URL inspection** on the homepage and legal pages, request indexing, and check the Page indexing and Core Web Vitals reports.
6. Keep authenticated app pages out of the sitemap. They return `X-Robots-Tag: noindex, nofollow` from the static host configuration.

## Google Analytics 4

1. Open [Google Analytics](https://analytics.google.com/), create or select the FitOS GA4 property.
2. Go to **Admin → Data streams → Web**, create/select the stream for the exact canonical origin, and copy the Measurement ID.
3. Add the ID as Render static-site environment variable `GA4_MEASUREMENT_ID`, then deploy.
4. Accept analytics in a fresh browser session. In GA4 open **Reports → Realtime** and verify one page view and the expected event after performing a successful test action. Reject analytics and verify no further events are sent.
5. To link Search Console: in GA4 go to **Admin → Product links → Search Console Links → Link**. Select the verified Search Console property, then the matching web stream, and submit. This requires GA4 Editor access and Search Console verified-owner access. Verify the link appears in Product links afterwards.

## Microsoft Clarity

1. Open [Microsoft Clarity](https://clarity.microsoft.com/), create a web project for the canonical FitOS origin, and go to **Settings → Setup** to copy the Project ID.
2. Add it to Render as `CLARITY_PROJECT_ID` and deploy.
3. In Clarity project settings enable the consent mode option where available. The site sends Clarity Consent API v2 signals after the visitor chooses accept/reject. The app screens other than the public landing screen are marked for masking; inputs are masked by Clarity by default.
4. Accept consent on the deployed site, then use Clarity's installation verification / live recordings to verify activity. Do not inspect or share recordings containing personal account details.

## Bing Webmaster Tools

1. Open [Bing Webmaster Tools](https://www.bing.com/webmasters/).
2. Add the canonical site and verify ownership. If offered, import the verified Search Console property rather than creating conflicting records.
3. Submit `https://adaptive-fit-web.onrender.com/sitemap.xml`.
4. Review URL inspection, indexing, crawl errors, and search performance after Bing has crawled the site. There is no evidence in this repository that the property has already been verified.

## Uptime monitoring

Create three HTTP(S) monitors in [UptimeRobot](https://uptimerobot.com/), using its current free plan if suitable:

1. Frontend: `https://adaptive-fit-web.onrender.com/` — expect HTTP 200.
2. API liveness: `https://adaptive-fit-api.onrender.com/health` — expect HTTP 200 and JSON status `ok`.
3. API/database readiness: `https://adaptive-fit-api.onrender.com/health/ready` — expect HTTP 200 and JSON status `ready`; HTTP 503 means the API cannot query its database.

Use a 5-minute interval (the provider currently documents that interval for its free plan) and configure an email alert contact in the monitoring dashboard. Test the notification path using the provider's test-alert feature before treating monitoring as active. Do not put API keys or credentials in monitor URLs.

## Performance measurement

Run PageSpeed Insights against the deployed public homepage for mobile and desktop: [PageSpeed Insights](https://pagespeed.web.dev/). Save the report date and URLs. Use field Core Web Vitals (CrUX) when available; a lab Lighthouse run is diagnostic, not proof of passing the 75th-percentile field targets. Targets: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1.

The repository alone cannot establish real visitor p75 Core Web Vitals, API latency under production load, or current Search Console indexing. Record measured values only after running the tools.

## Business listings and social profiles

FitOS is currently represented as an online fitness software product in this repository. Do not create Bing Places or Apple Business Connect local listings without a real eligible public business location. Apple Business Connect is not an App Store listing; review App Store Connect separately if a native iOS app is released.

The public homepage already has Open Graph / Twitter metadata and structured Organization/WebSite data. Only add links to social profiles that the FitOS operator confirms are authentic. Use campaign-specific UTM parameters on outbound campaign links, not on canonical URLs.

## Pre-launch verification checklist

- [ ] Add actual GA4 and/or Clarity IDs to Render; otherwise no analytics scripts or consent banner appear.
- [ ] Redeploy the frontend after environment-variable changes.
- [ ] Verify consent accept/reject and later preference changes in a clean browser.
- [ ] Confirm one GA4 event per successful test action and no event parameters containing user data.
- [ ] Verify the sitemap is accepted by Search Console and Bing Webmaster Tools.
- [ ] Test all three uptime monitors and their email notification path.
- [ ] Run PageSpeed Insights and record measured results.
- [ ] Review the Privacy Policy with the actual data controller/contact and retention/deletion practices before broad public launch.
