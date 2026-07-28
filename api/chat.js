// api/chat.js
// Vercel serverless function — proxies chat requests to the Anthropic API.
//
// Security model (see the July 2026 review for the full writeup):
//   1. The browser never sends a system prompt or a token limit. It sends a
//      `mode` id and structured `identity` fields; every prompt template and
//      every max_tokens value lives here on the server.
//   2. Every request is rate-limited per IP and against a shared daily
//      budget before it touches the model, so an anonymous caller (curl,
//      a loop, a bot) can't run up an unbounded bill.
//   3. Identity fields are trimmed and length-capped before they're
//      interpolated into a prompt, since they're the one piece of
//      caller-supplied text that ends up in the system prompt.

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// ---------------------------------------------------------------------------
// Rate limiting (Upstash Redis — required because Vercel functions are
// stateless; an in-memory counter resets on cold start and won't hold across
// the fleet). Falls back to a same-instance in-memory limiter if the
// UPSTASH_* env vars aren't set yet, so a fresh deploy doesn't hard-fail —
// but that fallback does NOT protect you across cold starts or multiple
// instances. Set the env vars in Vercel before sharing this link widely.
// ---------------------------------------------------------------------------
let ipLimiter = null;
let globalLimiter = null;
let usingRedis = false;

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    const redis = Redis.fromEnv();
    ipLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(20, "10 m"), // 20 requests / IP / 10 min
      prefix: "meridian:ip",
    });
    globalLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(2000, "1 d"), // shared daily budget backstop
      prefix: "meridian:global",
    });
    usingRedis = true;
  } catch (err) {
    console.error("Upstash init failed, falling back to in-memory limiter:", err);
  }
}

// In-memory fallback: better than nothing for local dev / a not-yet-configured
// deploy, but resets on cold start and is per-instance only.
const memoryHits = new Map(); // ip -> [timestamps]
const MEM_WINDOW_MS = 10 * 60 * 1000;
const MEM_MAX_PER_IP = 20;
function memoryLimit(ip) {
  const now = Date.now();
  const hits = (memoryHits.get(ip) || []).filter((t) => now - t < MEM_WINDOW_MS);
  hits.push(now);
  memoryHits.set(ip, hits);
  return hits.length <= MEM_MAX_PER_IP;
}

// ---------------------------------------------------------------------------
// Server-owned prompts. The browser sends a `mode` id — never prompt text.
// ---------------------------------------------------------------------------
const CHAT_MODES = {
  onboarding_client: `MODE: CLIENT (self-guided onboarding)
You are speaking directly with a new CLIENT of Meridian. An onboarding roadmap is displayed at the top of their screen with these steps: 1) Account Setup, 2) Invite Your Team, 3) Data Import, 4) Integrations, 5) Configuration & Preferences, 6) Build Your First Workflow, 7) Go-Live.
Guide them through their onboarding:
- Reference the roadmap steps by name
- Help them understand what each step involves and what to tackle first
- Surface blockers early and tell them who can help
- Keep them feeling confident and oriented
Start by greeting the user warmly BY NAME, acknowledging their role, briefly noting that their onboarding roadmap is shown above, and asking which part of the roadmap they have questions about. Do not ask for their name or role again.`,

  onboarding_copilot: `MODE: MERIDIAN TEAM — ONBOARDING CO-PILOT
You are speaking with an INTERNAL Meridian team member (e.g. a CSM) who is prepping and tracking a CLIENT's onboarding. They are using you ABOUT a client, not AS the client.
- Help them see where the client is in setup and what's outstanding
- Surface likely blockers and suggest what to follow up on
- Help them prep for calls and prioritize next actions for this account
Start by greeting the team member BY NAME, acknowledging their role, referencing the client account they're working on if provided, and asking what they'd like to prep or review. Do not ask for their name or role again.`,

  onboarding_practice: `MODE: MERIDIAN TEAM — PRACTICE / TRAINING
You are helping an INTERNAL Meridian team member LEARN the onboarding flow by role-playing. They want to practice running or experiencing onboarding so they can master it.
- Offer to let them play either the client side or the CSM side
- Walk them through the flow, pausing to explain why each step matters
- Give constructive coaching as they practice
Start by greeting the team member BY NAME, acknowledging their role, and asking whether they'd like to practice as the client or as the CSM, and which scenario they want to run. Do not ask for their name or role again.`,

  onboarding_shared: `MODE: MERIDIAN TEAM — SHARED SESSION (live client + CSM)
You are facilitating a LIVE onboarding session where a Meridian CSM and their CLIENT are going through onboarding together on a call. Address both parties appropriately.
- Keep the session moving and structured for both the CSM and the client
- Surface next steps and blockers so both can see them
- Make it easy for the CSM to guide while the client follows along
Start by greeting both parties warmly, acknowledging the CSM BY NAME and welcoming the client account if provided, then set up the session by asking where they'd like to begin. Do not ask for the CSM's name or role again.`,

  training_client: `MODE: CLIENT — "What do I need to learn?"
You are speaking with a CLIENT of Meridian who wants to figure out what they (or their own team) need to learn to use the platform effectively.
- Help them identify which features and workflows matter most for their goals
- Surface the gap between what they already know and what they'll need
- Recommend a prioritized learning path and what to tackle first
Start by greeting the user warmly BY NAME, acknowledging their role, and asking what they're trying to accomplish with Meridian and where they currently feel less confident. Do not ask for their name or role again.`,

  training_team: `MODE: MERIDIAN TEAM — TRAINING CO-PILOT ("Help me identify what training to offer this client")
You are speaking with an INTERNAL Meridian team member (e.g. a CSM or enablement manager) who wants to identify what training to offer or recommend to a specific CLIENT. They are using you ABOUT a client, not AS the client.
- Help them assess where the client is likely under-adopting or struggling
- Recommend specific training, resources, or sessions to offer the client
- Prioritize what would move the client toward value fastest
Start by greeting the team member BY NAME, acknowledging their role, referencing the client account if provided, and asking what they know about the client's current usage and goals. Do not ask for their name or role again.`,
};

const PLAIN_TEXT_RULE =
  "\n\nFormatting: Respond in plain, conversational text. Do not use Markdown of any kind — no #, ##, or ### headings; no ** or __ for bold; no asterisks or dashes as bullet points; and no --- divider lines. If you need to list items, write them as short sentences or separate them with line breaks, not bullet symbols.";

function draftTicketSystem(identity) {
  return `You are drafting a Jira ticket based on a Meridian co-pilot conversation about a client. Capture the single most important blocker, action item, or follow-up from the conversation.

Return ONLY valid JSON — no markdown, no code fences, no preamble. Use exactly this shape:
{
  "title": "concise, specific ticket title",
  "type": "Task | Bug | Story",
  "priority": "Low | Medium | High | Urgent",
  "client": "the client account name",
  "currentState": "2-4 sentences describing the situation today — the problem, gap, or blocker as it exists now",
  "futureState": {
    "as": "the role who benefits, e.g. 'onboarding client' or 'CSM'",
    "need": "what they need to be able to do",
    "soThat": "the outcome or benefit they get"
  },
  "acceptanceCriteria": [
    { "actor": "User", "criterion": "an observable behavior the user can perform" },
    { "actor": "System", "criterion": "a behavior the system must exhibit" }
  ]
}
The client account is: ${identity.client || "Unknown"}. Choose type from Task, Bug, or Story as appropriate. Provide 2-4 acceptance criteria mixing User and System actors.`;
}

function summarizeSessionSystem(identity, moduleLabel) {
  return `You are summarizing a Meridian client self-service session so the client's account team (CSM) has awareness of it. The client is ${identity.name || "a client"}${identity.role ? `, role: ${identity.role}` : ""}. The session was in the "${moduleLabel}" tool.

Return ONLY valid JSON — no markdown, no code fences, no preamble. Use exactly this shape:
{
  "topics": ["short topic", "short topic"],
  "summary": "2-3 sentence summary of what the client explored and where they landed",
  "blockers": ["any blocker or risk surfaced — omit or leave empty if none"],
  "status": "Resolved | Needs follow-up | Blocker flagged"
}`;
}

// Per-mode output caps. Caller-supplied max_tokens is never honored.
const MAX_TOKENS_BY_MODE = {
  draft_ticket: 1200,
  summarize_session: 800,
  // every CHAT_MODES key falls through to the default below
};
const DEFAULT_CHAT_MAX_TOKENS = 1000;

const MODULE_LABELS = new Set(["Onboarding", "Training Needs"]);

// ---------------------------------------------------------------------------
// Input sanitizing helpers
// ---------------------------------------------------------------------------
function cleanField(v, maxLen) {
  if (typeof v !== "string") return "";
  // Strip newlines/tabs so identity text can't smuggle extra "instructions"
  // into the prompt by pretending to start a new line/section.
  return v.replace(/[\r\n\t]+/g, " ").trim().slice(0, maxLen);
}

function sanitizeIdentity(identity) {
  if (!identity || typeof identity !== "object") return {};
  return {
    name: cleanField(identity.name, 80),
    role: cleanField(identity.role, 80),
    company: cleanField(identity.company, 80),
    client: cleanField(identity.client, 80),
  };
}

function buildIdBlock(identity) {
  if (!identity.name) return "";
  let idBlock =
    `The person you are speaking with is ${identity.name}` +
    (identity.role ? `, whose role is: ${identity.role}` : "") + `.`;
  if (identity.company) idBlock += ` They are from the company: ${identity.company}.`;
  if (identity.client) idBlock += ` The client account this session is about is: ${identity.client}.`;
  idBlock += ` Greet them by name and tailor the conversation accordingly.\n\n`;
  return idBlock;
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const cleaned = [];
  for (const m of messages.slice(-40)) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    if (typeof m.content !== "string") continue;
    cleaned.push({ role: m.role, content: m.content.slice(0, 6000) });
  }
  return cleaned.length ? cleaned : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // --- Rate limit before spending a cent on inference ---------------------
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";

  if (usingRedis) {
    const [ipRes, globalRes] = await Promise.all([
      ipLimiter.limit(ip),
      globalLimiter.limit("all"),
    ]);
    if (!ipRes.success) {
      return res.status(429).json({ error: "Too many requests. Please wait a bit and try again." });
    }
    if (!globalRes.success) {
      return res.status(429).json({ error: "Demo is at capacity for today. Please check back tomorrow." });
    }
  } else {
    if (!memoryLimit(ip)) {
      return res.status(429).json({ error: "Too many requests. Please wait a bit and try again." });
    }
    // No global backstop without Redis — logged so it's visible in Vercel's
    // function logs that this deploy isn't fully protected yet.
    console.warn("UPSTASH_REDIS_REST_URL/TOKEN not set — running with in-memory rate limiting only.");
  }

  // --- Validate & build the request, entirely server-side -----------------
  const { messages: rawMessages, mode, identity: rawIdentity, moduleLabel: rawModuleLabel } = req.body || {};

  const messages = sanitizeMessages(rawMessages);
  if (!messages) {
    return res.status(400).json({ error: "Missing or invalid messages" });
  }

  const identity = sanitizeIdentity(rawIdentity);
  let system;
  let maxTokens;

  if (Object.prototype.hasOwnProperty.call(CHAT_MODES, mode)) {
    system = buildIdBlock(identity) + CHAT_MODES[mode] + PLAIN_TEXT_RULE;
    maxTokens = DEFAULT_CHAT_MAX_TOKENS;
  } else if (mode === "draft_ticket") {
    system = draftTicketSystem(identity);
    maxTokens = MAX_TOKENS_BY_MODE.draft_ticket;
  } else if (mode === "summarize_session") {
    const moduleLabel = MODULE_LABELS.has(rawModuleLabel) ? rawModuleLabel : "Meridian";
    system = summarizeSessionSystem(identity, moduleLabel);
    maxTokens = MAX_TOKENS_BY_MODE.summarize_session;
  } else {
    return res.status(400).json({ error: "Unknown mode" });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY, // lives only on Vercel's server
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: maxTokens, // server-decided, caller can never override
        system,
        messages,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error("Anthropic API error:", response.status, error);
      return res.status(response.status).json({ error: "Something went wrong." }); // don't leak upstream detail
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";
    return res.status(200).json({ text });
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}