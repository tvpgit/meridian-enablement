# Meridian — Enablement Intelligence

A live AI-powered demo showing how agentic workflows reduce friction in client onboarding and training. Built as a portfolio piece for field enablement and product management interviews.

Meridian is a fictional company used for demonstration purposes only.

---

## What It Does

Two personas, gated by a "View as" toggle:

**Client** sees two tools:
- **Onboarding** — a visual seven-step roadmap plus a guided assistant that answers questions on any step
- **Training Needs** — "What do I need to learn?" — identifies gaps and a prioritized learning path

**Meridian Team** sees the internal layer:
- **Client Activity** — a feed of client-shared session summaries, with flagged blockers and one-click Jira ticket drafting
- **Onboarding Co-pilot** — prep and track a client's onboarding
- **Practice** — role-play the onboarding flow
- **Shared Session** — facilitate a live client call
- **Training Co-pilot** — recommend targeted training for a client

Clients can share a session summary with their team; blockers surface in the activity feed; and co-pilots (or flagged feed cards) can draft a structured Jira ticket that a PM approves in Jira.

---

## Architecture

```
Browser (React)
    |
    |  POST /api/chat   { messages, mode, identity }
    |  no API key, no system prompt, no token limit in this request
    v
Vercel Serverless Function (api/chat.js)
    |
    |  rate-limits the request first (per-IP + a shared daily cap, via Upstash Redis)
    |  looks up the system prompt server-side from `mode` (a short id like "onboarding_client")
    |  clamps max_tokens server-side, caller can't override it
    |  adds ANTHROPIC_API_KEY from environment
    v
Anthropic API
    |
    v
Response back to the browser

```

The API key lives only in Vercel's environment variables and never reaches the browser. As of a July 2026 security review, the browser also never supplies the system prompt or a token limit; both are owned by the server and selected by a mode id. Every request is rate-limited (per-IP and a shared daily budget) via Upstash Redis before it reaches the model.

This closes a real gap the review found: earlier, the proxy accepted a caller-supplied prompt and token limit with no rate limit, so it could be called directly with a script, bypassing the in-app usage cap and running inference on the account's own budget with no ceiling. Without the Upstash environment variables set, the app still runs, but falls back to a weaker in-memory rate limiter that doesn't hold across multiple serverless instances, fine for local development, not for a production deploy.

---

## Local Development

### Prerequisites
- Node.js 18+
- An Anthropic API key (https://console.anthropic.com/)
- An Upstash Redis database, free tier (https://upstash.com) — optional locally, required for real rate limiting in production

### Setup

```bash
git clone https://github.com/YOUR_USERNAME/meridian-enablement.git
cd meridian-enablement
npm install
echo "ANTHROPIC_API_KEY=your_key_here" >> .env.local
echo "UPSTASH_REDIS_REST_URL=your_upstash_url" >> .env.local
echo "UPSTASH_REDIS_REST_TOKEN=your_upstash_token" >> .env.local
npm install -g vercel
vercel dev
```

Visit http://localhost:3000

> Use `vercel dev` (not `npm start`) locally so the `/api/chat` serverless function runs alongside the React app. If you skip the Upstash variables, rate limiting still works locally via the in-memory fallback.

---

## Deploy to Vercel

1. Push this repo to GitHub.
2. Import it at https://vercel.com/new
3. Add an environment variable: `ANTHROPIC_API_KEY = your_key_here` `UPSTASH_REDIS_REST_URL = your_upstash_url` `UPSTASH_REDIS_REST_TOKEN = your_upstash_token`
4. Deploy. Vercel auto-detects React + serverless functions.

Your app goes live at `https://<your-project>.vercel.app`. If you add the Upstash variables after your first deploy, redeploy once more, Vercel only picks up new environment variables on the next build.

---

## Project Structure

```
meridian-enablement/
├── api/
│   └── chat.js          # Serverless proxy — owns the API key, the prompts, and rate limiting
├── public/
│   └── index.html
├── src/
│   ├── App.js            # The full application
│   ├── index.js           # React entry point
│   └── index.css          # Global styles
├── package.json
├── vercel.json
└── README.md
```

---

## Path to Production

This is a proof of concept. A production deployment would:

1. **Integrate context sources** — HubSpot drives identity and the client account (replacing the manual "View as" toggle and fields); ticketing and product-usage data feed context.
2. **Build the output layer** — post drafted Jira tickets to a review status via the Jira API; auto-generate onboarding checklists and learning paths; route summaries to the LMS or Slack.
3. **Close the feedback loop** — measure time-to-value, feature adoption, and blocker-capture rate, then refine.

Throughout, the agent informs and proposes; humans decide and approve. Any action with a real side effect keeps a human in the loop.

Already shipped, ahead of this roadmap: a July 2026 security review found the API proxy had no rate limiting, so it landed before the phases above. Server-owned prompts, per-IP and daily rate limiting, and baseline security headers are live now. What's left for full production: authentication (SSO), request logging and monitoring, and per-tenant data isolation.
