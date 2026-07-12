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
    |  POST /api/chat   (no API key in the browser)
    v
Vercel Serverless Function (api/chat.js)
    |
    |  adds ANTHROPIC_API_KEY from environment
    v
Anthropic API
    |
    v
Response back to the browser
```

The API key lives only in Vercel's environment variables. It never reaches the browser.

---

## Local Development

### Prerequisites
- Node.js 18+
- An Anthropic API key (https://console.anthropic.com/)

### Setup

```bash
git clone https://github.com/YOUR_USERNAME/meridian-enablement.git
cd meridian-enablement
npm install
echo "ANTHROPIC_API_KEY=your_key_here" > .env.local
npm install -g vercel
vercel dev
```

Visit http://localhost:3000

> Use `vercel dev` (not `npm start`) locally so the `/api/chat` serverless function runs alongside the React app.

---

## Deploy to Vercel

1. Push this repo to GitHub.
2. Import it at https://vercel.com/new
3. Add an environment variable: `ANTHROPIC_API_KEY = your_key_here`
4. Deploy. Vercel auto-detects React + serverless functions.

Your app goes live at `https://<your-project>.vercel.app`.

---

## Project Structure

```
meridian-enablement/
├── api/
│   └── chat.js          # Serverless proxy — keeps the API key server-side
├── public/
│   └── index.html
├── src/
│   ├── App.js           # The full application
│   ├── index.js         # React entry point
│   └── index.css        # Global styles
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
