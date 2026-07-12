import { useState, useRef, useEffect } from "react";

// Calls our Vercel serverless proxy at /api/chat. The proxy attaches the
// Anthropic API key server-side — it is never exposed in the browser.
async function callAPI(messages, system, maxTokens) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, system, max_tokens: maxTokens }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  const data = await response.json();
  return data.text || "";
}

const COLORS = {
  navy: "#0D1B2A",
  navyLight: "#132236",
  navyMid: "#1A2F47",
  amber: "#E8A838",
  amberDim: "#C4902F",
  slate: "#8899AA",
  slateLight: "#AAB8C4",
  white: "#F0F4F8",
  offwhite: "#D8E2EC",
  green: "#3DBE8A",
  red: "#E8594A",
};

const SYSTEM_ONBOARDING = `You are Meridian's Client Onboarding Assistant. Meridian is a mid-market SaaS platform for operations and workflow management.

Your job is to guide a new client through onboarding in a warm, structured, efficient way. You help them:
- Understand what they need to set up first
- Identify blockers early
- Feel confident about their progress

Ask focused questions one or two at a time. Keep responses concise — 2-4 short paragraphs max. Use plain language. When appropriate, summarize next steps clearly. If they mention a blocker or confusion, flag it and suggest who can help.

Start by greeting the user warmly BY NAME, acknowledging their role, and asking what brings them to Meridian and what their primary use case is. Since you already know who they are, do not ask for their name or role again.`;

// Onboarding sub-mode instructions. Appended to the base identity block.
const ONBOARDING_MODES = {
  client: `MODE: CLIENT (self-guided onboarding)
You are speaking directly with a new CLIENT of Meridian. An onboarding roadmap is displayed at the top of their screen with these steps: 1) Account Setup, 2) Invite Your Team, 3) Data Import, 4) Integrations, 5) Configuration & Preferences, 6) Build Your First Workflow, 7) Go-Live.
Guide them through their onboarding:
- Reference the roadmap steps by name
- Help them understand what each step involves and what to tackle first
- Surface blockers early and tell them who can help
- Keep them feeling confident and oriented
Start by greeting the user warmly BY NAME, acknowledging their role, briefly noting that their onboarding roadmap is shown above, and asking which part of the roadmap they have questions about. Do not ask for their name or role again.`,

  copilot: `MODE: MERIDIAN TEAM — ONBOARDING CO-PILOT
You are speaking with an INTERNAL Meridian team member (e.g. a CSM) who is prepping and tracking a CLIENT's onboarding. They are using you ABOUT a client, not AS the client.
- Help them see where the client is in setup and what's outstanding
- Surface likely blockers and suggest what to follow up on
- Help them prep for calls and prioritize next actions for this account
Start by greeting the team member BY NAME, acknowledging their role, referencing the client account they're working on if provided, and asking what they'd like to prep or review. Do not ask for their name or role again.`,

  practice: `MODE: MERIDIAN TEAM — PRACTICE / TRAINING
You are helping an INTERNAL Meridian team member LEARN the onboarding flow by role-playing. They want to practice running or experiencing onboarding so they can master it.
- Offer to let them play either the client side or the CSM side
- Walk them through the flow, pausing to explain why each step matters
- Give constructive coaching as they practice
Start by greeting the team member BY NAME, acknowledging their role, and asking whether they'd like to practice as the client or as the CSM, and which scenario they want to run. Do not ask for their name or role again.`,

  shared: `MODE: MERIDIAN TEAM — SHARED SESSION (live client + CSM)
You are facilitating a LIVE onboarding session where a Meridian CSM and their CLIENT are going through onboarding together on a call. Address both parties appropriately.
- Keep the session moving and structured for both the CSM and the client
- Surface next steps and blockers so both can see them
- Make it easy for the CSM to guide while the client follows along
Start by greeting both parties warmly, acknowledging the CSM BY NAME and welcoming the client account if provided, then set up the session by asking where they'd like to begin. Do not ask for the CSM's name or role again.`,
};

const SYSTEM_TRAINING = `You are Meridian's Training Needs Identifier. Your job is to help an enablement manager or team lead identify knowledge gaps and training priorities for their team.

You conduct a structured discovery conversation. Ask about:
- The team's role and key responsibilities
- Which Meridian features or workflows they use most
- Where they struggle or ask for help most often
- Recent changes (new hires, new features, process changes)
- How training has been delivered before and what worked

Ask 1-2 questions at a time. Be conversational but purposeful. After gathering enough context (usually 4-6 exchanges), offer to summarize the top training needs and a suggested prioritization. Keep responses concise and practical.

Start by greeting the user BY NAME, acknowledging their role, and asking which team they're looking to assess. Since you already know who they are, do not ask for their name or role again.`;

// Training Needs sub-mode instructions, mirroring the onboarding structure.
const TRAINING_MODES = {
  client: `MODE: CLIENT — "What do I need to learn?"
You are speaking with a CLIENT of Meridian who wants to figure out what they (or their own team) need to learn to use the platform effectively.
- Help them identify which features and workflows matter most for their goals
- Surface the gap between what they already know and what they'll need
- Recommend a prioritized learning path and what to tackle first
Start by greeting the user warmly BY NAME, acknowledging their role, and asking what they're trying to accomplish with Meridian and where they currently feel less confident. Do not ask for their name or role again.`,

  team: `MODE: MERIDIAN TEAM — TRAINING CO-PILOT ("Help me identify what training to offer this client")
You are speaking with an INTERNAL Meridian team member (e.g. a CSM or enablement manager) who wants to identify what training to offer or recommend to a specific CLIENT. They are using you ABOUT a client, not AS the client.
- Help them assess where the client is likely under-adopting or struggling
- Recommend specific training, resources, or sessions to offer the client
- Prioritize what would move the client toward value fastest
Start by greeting the team member BY NAME, acknowledging their role, referencing the client account if provided, and asking what they know about the client's current usage and goals. Do not ask for their name or role again.`,
};

// Standard client onboarding roadmap, shown as a visual card in client onboarding.
const ONBOARDING_TEMPLATE = [
  { step: "Account Setup", detail: "Configure your workspace and organization settings" },
  { step: "Invite Your Team", detail: "Add users and assign roles and permissions" },
  { step: "Data Import", detail: "Bring your existing data into Meridian" },
  { step: "Integrations", detail: "Connect the tools you already use" },
  { step: "Configuration & Preferences", detail: "Tailor settings to your workflows" },
  { step: "Build Your First Workflow", detail: "Create and test a working process" },
  { step: "Go-Live", detail: "Launch to your team and start running" },
];

async function callClaude(messages, systemPrompt, identity) {
  let fullSystem = systemPrompt;
  if (identity && identity.name) {
    let idBlock =
      `The person you are speaking with is ${identity.name}` +
      (identity.role ? `, whose role is: ${identity.role}` : "") + `.`;
    if (identity.company) {
      idBlock += ` They are from the company: ${identity.company}.`;
    }
    if (identity.client) {
      idBlock += ` The client account this session is about is: ${identity.client}.`;
    }
    idBlock += ` Greet them by name and tailor the conversation accordingly.\n\n`;
    fullSystem = idBlock + systemPrompt;
  }
  const outbound = messages.length > 0 ? messages : [{ role: "user", content: "Please begin the session." }];
  const text = await callAPI(outbound, fullSystem, 1000);
  return text || "Sorry, I couldn't generate a response.";
}

// Asks the model to draft a Jira ticket from the conversation. Returns a parsed
// object or throws. The agent DRAFTS only — a human submits.
async function draftTicket(messages, identity) {
  const sys = `You are drafting a Jira ticket based on a Meridian co-pilot conversation about a client. Capture the single most important blocker, action item, or follow-up from the conversation.

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

  const draftMessages = [
    ...messages,
    { role: "user", content: "Draft a Jira ticket capturing the key blocker or action item from our conversation. Return JSON only." },
  ];

  let text = await callAPI(draftMessages, sys, 1200);
  text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  return JSON.parse(text);
}

// Generates a session summary for the Meridian Team activity feed after a
// client session. Returns a parsed object or throws.
async function summarizeSession(messages, identity, moduleLabel) {
  const sys = `You are summarizing a Meridian client self-service session so the client's account team (CSM) has awareness of it. The client is ${identity.name || "a client"}${identity.role ? `, role: ${identity.role}` : ""}. The session was in the "${moduleLabel}" tool.

Return ONLY valid JSON — no markdown, no code fences, no preamble. Use exactly this shape:
{
  "topics": ["short topic", "short topic"],
  "summary": "2-3 sentence summary of what the client explored and where they landed",
  "blockers": ["any blocker or risk surfaced — omit or leave empty if none"],
  "status": "Resolved | Needs follow-up | Blocker flagged"
}`;

  const summaryMessages = [
    ...messages,
    { role: "user", content: "Summarize this session for my account team. Return JSON only." },
  ];

  let text = await callAPI(summaryMessages, sys, 800);
  text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  return JSON.parse(text);
}

function TypingIndicator() {
  return (
    <div style={{ display: "flex", gap: 5, alignItems: "center", padding: "12px 16px" }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: COLORS.amber,
            animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

function ChatMessage({ msg }) {
  const isUser = msg.role === "user";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        marginBottom: 16,
        animation: "fadeSlideIn 0.3s ease forwards",
      }}
    >
      {!isUser && (
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: `linear-gradient(135deg, ${COLORS.amber}, ${COLORS.amberDim})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            fontWeight: 700,
            color: COLORS.navy,
            marginRight: 10,
            flexShrink: 0,
            fontFamily: "'DM Mono', monospace",
          }}
        >
          M
        </div>
      )}
      <div
        style={{
          maxWidth: "75%",
          padding: "12px 16px",
          borderRadius: isUser ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
          background: isUser ? COLORS.amber : COLORS.navyMid,
          color: isUser ? COLORS.navy : COLORS.white,
          fontSize: 14,
          lineHeight: 1.6,
          fontFamily: "'DM Sans', sans-serif",
          whiteSpace: "pre-wrap",
          boxShadow: isUser
            ? `0 2px 12px rgba(232,168,56,0.2)`
            : `0 2px 12px rgba(0,0,0,0.3)`,
        }}
      >
        {msg.content}
      </div>
    </div>
  );
}

// Shared, self-contained ticket draft modal. Used by the co-pilot chat and the
// Client Activity feed. Manages its own asset + submit state.
function TicketModal({ ticket, error, onClose }) {
  const [assetLink, setAssetLink] = useState("");
  const [assetFiles, setAssetFiles] = useState([]);
  const [submitted, setSubmitted] = useState(false);
  const fileInputRef = useRef(null);

  function handleFilePick(e) {
    const files = Array.from(e.target.files || []);
    if (files.length) setAssetFiles((prev) => [...prev, ...files.map((f) => f.name)]);
    e.target.value = "";
  }

  return (
    <div
      style={{ position: "absolute", inset: 0, zIndex: 20, background: "rgba(6,12,20,0.72)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 440, background: COLORS.navyLight,
          border: `1px solid ${COLORS.navyMid}`, borderRadius: 14,
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)", overflow: "hidden", animation: "fadeSlideIn 0.25s ease" }}
      >
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${COLORS.navyMid}`,
          display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, fontWeight: 700,
            color: COLORS.amber, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            {submitted ? "Draft Sent to Jira" : "Draft Jira Ticket"}
          </span>
          <button onClick={onClose} style={{ background: "transparent", border: "none",
            color: COLORS.slate, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: 18 }}>
          {error && (
            <div style={{ color: "#E8594A", fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>{error}</div>
          )}

          {ticket && !submitted && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, maxHeight: "62vh", overflowY: "auto" }}>
              <div>
                <div style={{ color: COLORS.slate, fontSize: 10, fontFamily: "'DM Mono', monospace", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>Title</div>
                <div style={{ color: COLORS.white, fontSize: 15, fontWeight: 600, fontFamily: "'DM Sans', sans-serif" }}>{ticket.title}</div>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {[{ k: "Type", v: ticket.type }, { k: "Priority", v: ticket.priority }, { k: "Client", v: ticket.client }].map((f) => (
                  <div key={f.k} style={{ background: COLORS.navyMid, borderRadius: 8, padding: "6px 10px" }}>
                    <div style={{ color: COLORS.slate, fontSize: 9, fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", textTransform: "uppercase" }}>{f.k}</div>
                    <div style={{ color: COLORS.white, fontSize: 13, fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}>{f.v}</div>
                  </div>
                ))}
              </div>
              <div>
                <div style={{ color: COLORS.slate, fontSize: 10, fontFamily: "'DM Mono', monospace", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>Current State</div>
                <div style={{ color: COLORS.offwhite, fontSize: 13, lineHeight: 1.55, fontFamily: "'DM Sans', sans-serif" }}>{ticket.currentState}</div>
              </div>
              <div>
                <div style={{ color: COLORS.slate, fontSize: 10, fontFamily: "'DM Mono', monospace", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>Future State</div>
                <div style={{ background: COLORS.navyMid, borderRadius: 8, padding: "10px 12px", fontSize: 13, lineHeight: 1.6, fontFamily: "'DM Sans', sans-serif", color: COLORS.offwhite }}>
                  {ticket.futureState && typeof ticket.futureState === "object" ? (
                    <span>
                      <b style={{ color: COLORS.amber }}>As a</b> {ticket.futureState.as},{" "}
                      <b style={{ color: COLORS.amber }}>I need to</b> {ticket.futureState.need},{" "}
                      <b style={{ color: COLORS.amber }}>so that I can</b> {ticket.futureState.soThat}.
                    </span>
                  ) : (<span>{ticket.futureState}</span>)}
                </div>
              </div>
              <div>
                <div style={{ color: COLORS.slate, fontSize: 10, fontFamily: "'DM Mono', monospace", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Assets</div>
                <input
                  value={assetLink}
                  onChange={(e) => setAssetLink(e.target.value)}
                  placeholder="Paste a link (doc, Loom, dashboard)…"
                  style={{ width: "100%", background: COLORS.navyMid, border: `1px solid ${COLORS.navyMid}`,
                    borderRadius: 8, padding: "9px 12px", color: COLORS.white, fontFamily: "'DM Sans', sans-serif",
                    fontSize: 13, outline: "none", marginBottom: 8 }}
                  onFocus={(e) => (e.target.style.borderColor = COLORS.amber)}
                  onBlur={(e) => (e.target.style.borderColor = COLORS.navyMid)}
                />
                <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={handleFilePick} />
                <button
                  onClick={() => fileInputRef.current && fileInputRef.current.click()}
                  style={{ background: "transparent", border: `1px dashed ${COLORS.slate}`, borderRadius: 8,
                    padding: "8px 12px", color: COLORS.slateLight, cursor: "pointer", fontSize: 12,
                    fontFamily: "'DM Mono', monospace", width: "100%" }}
                >
                  ↑ Attach files / screenshots
                </button>
                {assetFiles.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
                    {assetFiles.map((f, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: COLORS.navyMid, borderRadius: 6, padding: "5px 10px" }}>
                        <span style={{ color: COLORS.offwhite, fontSize: 12, fontFamily: "'DM Sans', sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📎 {f}</span>
                        <button onClick={() => setAssetFiles((prev) => prev.filter((_, j) => j !== i))} style={{ background: "transparent", border: "none", color: COLORS.slate, cursor: "pointer", fontSize: 14, flexShrink: 0, marginLeft: 8 }}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div style={{ color: COLORS.slate, fontSize: 10, fontFamily: "'DM Mono', monospace", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Acceptance Criteria</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {Array.isArray(ticket.acceptanceCriteria) && ticket.acceptanceCriteria.map((c, i) => {
                    const actor = typeof c === "object" ? c.actor : null;
                    const text = typeof c === "object" ? c.criterion : c;
                    return (
                      <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        {actor && (
                          <span style={{ flexShrink: 0, background: actor.toLowerCase().startsWith("sys") ? "rgba(61,190,138,0.16)" : "rgba(232,168,56,0.16)", color: actor.toLowerCase().startsWith("sys") ? COLORS.green : COLORS.amber, borderRadius: 5, padding: "2px 7px", fontSize: 10, fontFamily: "'DM Mono', monospace", fontWeight: 700, marginTop: 1 }}>{actor}</span>
                        )}
                        <span style={{ color: COLORS.offwhite, fontSize: 13, lineHeight: 1.5, fontFamily: "'DM Sans', sans-serif" }}>{text}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button onClick={() => setSubmitted(true)} style={{ flex: 1, background: COLORS.amber, color: COLORS.navy, border: "none", borderRadius: 9, padding: "11px 16px", fontFamily: "'DM Mono', monospace", fontSize: 13, fontWeight: 700, cursor: "pointer", letterSpacing: "0.03em" }}>
                  Send draft to Jira →
                </button>
                <button onClick={onClose} style={{ background: "transparent", color: COLORS.slate, border: `1px solid ${COLORS.navyMid}`, borderRadius: 9, padding: "11px 16px", fontFamily: "'DM Mono', monospace", fontSize: 13, cursor: "pointer" }}>
                  Discard
                </button>
              </div>
              <div style={{ color: COLORS.slate, fontSize: 11, fontFamily: "'DM Sans', sans-serif", textAlign: "center", lineHeight: 1.4 }}>
                In production the app posts this draft to Jira via API in a review status; a product manager reviews and approves it in Jira before it becomes active.
              </div>
            </div>
          )}

          {ticket && submitted && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center", textAlign: "center", padding: "8px 0" }}>
              <div style={{ width: 48, height: 48, borderRadius: "50%", background: "rgba(61,190,138,0.16)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, color: COLORS.green }}>✓</div>
              <div style={{ color: COLORS.white, fontSize: 15, fontWeight: 600, fontFamily: "'DM Sans', sans-serif" }}>Draft sent to Jira for “{ticket.client}”</div>
              <div style={{ color: COLORS.slate, fontSize: 12, fontFamily: "'DM Sans', sans-serif", lineHeight: 1.5 }}>
                In the demo this is simulated. In production, the app posts this draft to Jira via API in a review status{(assetLink || assetFiles.length > 0) ? ", with your assets attached" : ""}. A product manager reviews and approves it in Jira before it becomes active.
              </div>
              <button onClick={onClose} style={{ background: COLORS.navyMid, color: COLORS.white, border: "none", borderRadius: 9, padding: "10px 22px", fontFamily: "'DM Mono', monospace", fontSize: 13, fontWeight: 600, cursor: "pointer", marginTop: 4 }}>Done</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatInterface({ systemPrompt, placeholder, startLabel, internal, clientFieldLabel, canDraftTicket, template, onShareSummary, moduleLabel, companyField }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [company, setCompany] = useState("");
  const [client, setClient] = useState("");
  const [ticket, setTicket] = useState(null);
  const [ticketLoading, setTicketLoading] = useState(false);
  const [ticketError, setTicketError] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const isInternal = !!internal;
  const identity = {
    name: name.trim(),
    role: role.trim(),
    company: company.trim(),
    client: isInternal ? client.trim() : "",
  };

  // All visible fields are required: name, role, company (if shown), and client (internal).
  const formValid = !!name.trim() && !!role.trim()
    && (!companyField || !!company.trim())
    && (!isInternal || !!client.trim());

  const activePrompt = systemPrompt;

  async function startConversation() {
    if (!formValid) return;
    setStarted(true);
    setLoading(true);
    const reply = await callClaude([], activePrompt, identity);
    setMessages([{ role: "assistant", content: reply }]);
    setLoading(false);
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;
    const userMsg = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    const reply = await callClaude(newMessages, activePrompt, identity);
    setMessages([...newMessages, { role: "assistant", content: reply }]);
    setLoading(false);
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  async function handleDraftTicket() {
    if (ticketLoading || messages.length === 0) return;
    setTicketLoading(true);
    setTicketError(null);
    try {
      const draft = await draftTicket(messages, identity);
      setTicket(draft);
    } catch (e) {
      setTicketError("Couldn't draft the ticket. Try again once there's more in the conversation.");
      setTicket(null);
    } finally {
      setTicketLoading(false);
    }
  }

  function closeTicket() {
    setTicket(null);
    setTicketError(null);
  }

  async function handleShareSummary() {
    if (sharing || shared || messages.length === 0 || !onShareSummary) return;
    setSharing(true);
    let entry;
    try {
      const s = await summarizeSession(messages, identity, moduleLabel || "Session");
      entry = {
        client: identity.name,
        role: identity.role,
        company: identity.company,
        module: moduleLabel || "Session",
        summary: s.summary,
        topics: Array.isArray(s.topics) ? s.topics : [],
        blockers: Array.isArray(s.blockers) ? s.blockers.filter(Boolean) : [],
        status: s.status || "Needs follow-up",
      };
    } catch (e) {
      // Fallback so the feed still populates in the demo sandbox
      entry = {
        client: identity.name,
        role: identity.role,
        company: identity.company,
        module: moduleLabel || "Session",
        summary: "Client shared a session. Summary will generate once connected to the backend.",
        topics: [],
        blockers: [],
        status: "Shared",
      };
    }
    onShareSummary(entry);
    setSharing(false);
    setShared(true);
  }

  function reset() {
    setMessages([]);
    setStarted(false);
    setInput("");
    setName("");
    setRole("");
    setCompany("");
    setClient("");
    setTicket(null);
    setTicketError(null);
    setSharing(false);
    setShared(false);
  }

  if (!started) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          gap: 20,
          padding: 40,
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: "50%",
            background: `linear-gradient(135deg, ${COLORS.amber}, ${COLORS.amberDim})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 26,
            fontWeight: 800,
            color: COLORS.navy,
            fontFamily: "'DM Mono', monospace",
            boxShadow: `0 0 40px rgba(232,168,56,0.25)`,
          }}
        >
          M
        </div>
        <div>
          <div
            style={{
              color: COLORS.white,
              fontSize: 18,
              fontWeight: 600,
              marginBottom: 8,
              fontFamily: "'DM Mono', monospace",
            }}
          >
            {startLabel}
          </div>
        </div>

        {/* Identity capture */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 320 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") startConversation(); }}
            placeholder="Your name"
            style={{
              background: COLORS.navyMid,
              border: `1px solid ${COLORS.navyLight}`,
              borderRadius: 10,
              padding: "12px 14px",
              color: COLORS.white,
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 14,
              outline: "none",
              textAlign: "center",
              transition: "border-color 0.2s",
            }}
            onFocus={(e) => (e.target.style.borderColor = COLORS.amber)}
            onBlur={(e) => (e.target.style.borderColor = COLORS.navyLight)}
          />
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") startConversation(); }}
            placeholder="Your role"
            style={{
              background: COLORS.navyMid,
              border: `1px solid ${COLORS.navyLight}`,
              borderRadius: 10,
              padding: "12px 14px",
              color: COLORS.white,
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 14,
              outline: "none",
              textAlign: "center",
              transition: "border-color 0.2s",
            }}
            onFocus={(e) => (e.target.style.borderColor = COLORS.amber)}
            onBlur={(e) => (e.target.style.borderColor = COLORS.navyLight)}
          />
          {companyField && (
            <input
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") startConversation(); }}
              placeholder={companyField}
              style={{
                background: COLORS.navyMid,
                border: `1px solid ${COLORS.navyLight}`,
                borderRadius: 10,
                padding: "12px 14px",
                color: COLORS.white,
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 14,
                outline: "none",
                textAlign: "center",
                transition: "border-color 0.2s",
              }}
              onFocus={(e) => (e.target.style.borderColor = COLORS.amber)}
              onBlur={(e) => (e.target.style.borderColor = COLORS.navyLight)}
            />
          )}
          {isInternal && (
            <input
              value={client}
              onChange={(e) => setClient(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") startConversation(); }}
              placeholder={clientFieldLabel || "Client name / account"}
              style={{
                background: COLORS.navyMid,
                border: `1px solid ${COLORS.navyLight}`,
                borderRadius: 10,
                padding: "12px 14px",
                color: COLORS.white,
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 14,
                outline: "none",
                textAlign: "center",
                transition: "border-color 0.2s",
              }}
              onFocus={(e) => (e.target.style.borderColor = COLORS.amber)}
              onBlur={(e) => (e.target.style.borderColor = COLORS.navyLight)}
            />
          )}
        </div>

        <div style={{
          color: COLORS.slate, fontSize: 11, fontFamily: "'DM Sans', sans-serif",
          maxWidth: 320, textAlign: "center", lineHeight: 1.4, marginTop: -6,
        }}>
          {isInternal
            ? "In production, this is populated automatically from HubSpot."
            : "In production, your details are populated automatically from HubSpot."}
        </div>

        <button
          onClick={startConversation}
          disabled={!formValid}
          style={{
            background: formValid ? COLORS.amber : COLORS.navyMid,
            color: formValid ? COLORS.navy : COLORS.slate,
            border: "none",
            borderRadius: 10,
            padding: "12px 28px",
            fontFamily: "'DM Mono', monospace",
            fontSize: 14,
            fontWeight: 700,
            cursor: formValid ? "pointer" : "default",
            letterSpacing: "0.04em",
            transition: "all 0.2s",
          }}
          onMouseEnter={(e) => { if (formValid) e.target.style.background = COLORS.amberDim; }}
          onMouseLeave={(e) => { if (formValid) e.target.style.background = COLORS.amber; }}
        >
          BEGIN SESSION →
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      {/* Ticket draft overlay */}
      {(ticket || ticketError) && (
        <TicketModal ticket={ticket} error={ticketError} onClose={closeTicket} />
      )}

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "24px 20px 16px",
          scrollbarWidth: "thin",
          scrollbarColor: `${COLORS.navyMid} transparent`,
        }}
      >
        {template && (
          <div
            style={{
              background: COLORS.navyLight,
              border: `1px solid ${COLORS.navyMid}`,
              borderRadius: 12,
              padding: "16px 18px",
              marginBottom: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, fontWeight: 700, color: COLORS.amber, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                Your Onboarding Roadmap
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {template.map((t, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <div style={{
                    flexShrink: 0, width: 24, height: 24, borderRadius: "50%",
                    background: COLORS.navyMid, border: `1px solid ${COLORS.slate}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12, fontWeight: 700, color: COLORS.amber, fontFamily: "'DM Mono', monospace",
                  }}>
                    {i + 1}
                  </div>
                  <div>
                    <div style={{ color: COLORS.white, fontSize: 13, fontWeight: 600, fontFamily: "'DM Sans', sans-serif" }}>{t.step}</div>
                    <div style={{ color: COLORS.slate, fontSize: 12, fontFamily: "'DM Sans', sans-serif", lineHeight: 1.4 }}>{t.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatMessage key={i} msg={msg} />
        ))}
        {loading && (
          <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: `linear-gradient(135deg, ${COLORS.amber}, ${COLORS.amberDim})`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                fontWeight: 700,
                color: COLORS.navy,
                marginRight: 10,
                fontFamily: "'DM Mono', monospace",
              }}
            >
              M
            </div>
            <div
              style={{
                background: COLORS.navyMid,
                borderRadius: "18px 18px 18px 4px",
                boxShadow: `0 2px 12px rgba(0,0,0,0.3)`,
              }}
            >
              <TypingIndicator />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Draft Jira ticket action (co-pilot modes only) */}
      {canDraftTicket && messages.length > 0 && (
        <div
          style={{
            padding: "8px 16px",
            borderTop: `1px solid ${COLORS.navyMid}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: COLORS.navyLight,
          }}
        >
          <button
            onClick={handleDraftTicket}
            disabled={ticketLoading}
            style={{
              background: "transparent",
              border: `1px solid ${COLORS.amber}`,
              borderRadius: 8,
              padding: "7px 14px",
              color: COLORS.amber,
              cursor: ticketLoading ? "default" : "pointer",
              fontSize: 12,
              fontFamily: "'DM Mono', monospace",
              fontWeight: 600,
              letterSpacing: "0.03em",
              transition: "all 0.2s",
              opacity: ticketLoading ? 0.6 : 1,
            }}
          >
            {ticketLoading ? "Drafting…" : "⊕ Draft Jira ticket"}
          </button>
          <span style={{ color: COLORS.slate, fontSize: 11, fontFamily: "'DM Sans', sans-serif" }}>
            If your interaction here with the agent requires a Jira ticket, the agent drafts it and the app sends it to Jira — a product manager reviews and approves it in Jira.
          </span>
        </div>
      )}

      {/* Share session with team (client modes only) */}
      {onShareSummary && messages.length > 0 && (
        <div
          style={{
            padding: "8px 16px",
            borderTop: `1px solid ${COLORS.navyMid}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: COLORS.navyLight,
          }}
        >
          {!shared ? (
            <>
              <button
                onClick={handleShareSummary}
                disabled={sharing}
                style={{
                  background: "transparent",
                  border: `1px solid ${COLORS.amber}`,
                  borderRadius: 8,
                  padding: "7px 14px",
                  color: COLORS.amber,
                  cursor: sharing ? "default" : "pointer",
                  fontSize: 12,
                  fontFamily: "'DM Mono', monospace",
                  fontWeight: 600,
                  letterSpacing: "0.03em",
                  transition: "all 0.2s",
                  opacity: sharing ? 0.6 : 1,
                }}
              >
                {sharing ? "Sharing…" : "⇧ Share session with my team"}
              </button>
              <span style={{ color: COLORS.slate, fontSize: 11, fontFamily: "'DM Sans', sans-serif" }}>
                Your onboarding team can see a summary of this session.
              </span>
            </>
          ) : (
            <span style={{ color: COLORS.green, fontSize: 12, fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}>
              ✓ Shared with your team — they'll see a summary in their Client Activity feed.
            </span>
          )}
        </div>
      )}

      {/* Input */}
      <div
        style={{
          padding: "12px 16px",
          borderTop: `1px solid ${COLORS.navyMid}`,
          display: "flex",
          gap: 10,
          alignItems: "flex-end",
        }}
      >
        <button
          onClick={reset}
          title="Reset conversation"
          style={{
            background: "transparent",
            border: `1px solid ${COLORS.navyMid}`,
            borderRadius: 8,
            padding: "10px 12px",
            color: COLORS.slate,
            cursor: "pointer",
            fontSize: 13,
            fontFamily: "'DM Mono', monospace",
            flexShrink: 0,
            transition: "all 0.2s",
          }}
          onMouseEnter={(e) => { e.target.style.borderColor = COLORS.amber; e.target.style.color = COLORS.amber; }}
          onMouseLeave={(e) => { e.target.style.borderColor = COLORS.navyMid; e.target.style.color = COLORS.slate; }}
        >
          ↺
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder={placeholder}
          rows={1}
          style={{
            flex: 1,
            background: COLORS.navyMid,
            border: `1px solid ${COLORS.navyLight}`,
            borderRadius: 10,
            padding: "11px 14px",
            color: COLORS.white,
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 14,
            resize: "none",
            outline: "none",
            lineHeight: 1.5,
            transition: "border-color 0.2s",
          }}
          onFocus={(e) => (e.target.style.borderColor = COLORS.amber)}
          onBlur={(e) => (e.target.style.borderColor = COLORS.navyLight)}
        />
        <button
          onClick={sendMessage}
          disabled={!input.trim() || loading}
          style={{
            background: input.trim() && !loading ? COLORS.amber : COLORS.navyMid,
            border: "none",
            borderRadius: 10,
            padding: "11px 16px",
            color: input.trim() && !loading ? COLORS.navy : COLORS.slate,
            cursor: input.trim() && !loading ? "pointer" : "default",
            fontFamily: "'DM Mono', monospace",
            fontSize: 14,
            fontWeight: 700,
            flexShrink: 0,
            transition: "all 0.2s",
          }}
        >
          →
        </button>
      </div>
    </div>
  );
}

// Tabs available to each persona. Both Onboarding and Training Needs are
// client-facing tools with an internal Meridian Team layer.
const TAB_CONFIG = {
  client: [
    {
      id: "client-onboarding",
      label: "Onboarding",
      prompt: ONBOARDING_MODES.client,
      internal: false,
      shareable: true,
      moduleLabel: "Onboarding",
      companyField: "Company name",
      template: ONBOARDING_TEMPLATE,
      startLabel: "Onboarding Assistant",
      desc: "Guide new clients through setup, surface blockers early, and accelerate time-to-value.",
    },
    {
      id: "client-training",
      label: "Training Needs",
      prompt: TRAINING_MODES.client,
      internal: false,
      shareable: true,
      moduleLabel: "Training Needs",
      companyField: "Company name",
      startLabel: "Training Needs",
      desc: "Determine what you need to learn to get the most from the platform, with a prioritized learning path.",
    },
  ],
  team: [
    {
      id: "activity",
      label: "Client Activity",
      type: "feed",
      desc: "See summaries of recent client self-service sessions, shared by clients with their account team.",
    },
    {
      id: "copilot",
      label: "Onboarding Co-pilot",
      prompt: ONBOARDING_MODES.copilot,
      internal: true,
      canDraftTicket: true,
      clientField: "Client name / account",
      startLabel: "Onboarding Co-pilot",
      desc: "Prep and track a client's onboarding — next steps, likely blockers, and follow-ups.",
    },
    {
      id: "practice",
      label: "Practice",
      prompt: ONBOARDING_MODES.practice,
      internal: true,
      clientField: "Scenario / client",
      startLabel: "Onboarding Practice",
      desc: "Role-play the onboarding flow — as the client or the CSM — to master the process.",
    },
    {
      id: "shared",
      label: "Shared Session",
      prompt: ONBOARDING_MODES.shared,
      internal: true,
      clientField: "Client name / account",
      startLabel: "Shared Onboarding Session",
      desc: "Facilitate a live onboarding call with the client and CSM together.",
    },
    {
      id: "training-copilot",
      label: "Training Co-pilot",
      prompt: TRAINING_MODES.team,
      internal: true,
      canDraftTicket: true,
      clientField: "Client name / account",
      startLabel: "Training Co-pilot",
      desc: "Identify what training to offer this client based on their usage and goals.",
    },
  ],
};

function ActivityFeed({ activities }) {
  const [ticket, setTicket] = useState(null);
  const [ticketError, setTicketError] = useState(null);
  const [draftingId, setDraftingId] = useState(null);

  function statusColor(status) {
    const s = (status || "").toLowerCase();
    if (s.includes("block")) return { bg: "rgba(232,89,74,0.16)", fg: "#E8594A" };
    if (s.includes("follow")) return { bg: "rgba(232,168,56,0.16)", fg: COLORS.amber };
    if (s.includes("resolv")) return { bg: "rgba(61,190,138,0.16)", fg: COLORS.green };
    return { bg: COLORS.navyMid, fg: COLORS.slateLight };
  }
  function needsTicket(status) {
    const s = (status || "").toLowerCase();
    return s.includes("block") || s.includes("follow");
  }
  async function draftFromActivity(a) {
    if (draftingId) return;
    setDraftingId(a.id);
    setTicketError(null);
    // Build synthetic conversation context from the session summary.
    const synth = [{
      role: "user",
      content: `Draft a Jira ticket for this client session. Client: ${a.client || "Unknown"}${a.company ? ` (${a.company})` : ""}. Module: ${a.module}. Summary: ${a.summary} Topics: ${(a.topics || []).join(", ") || "n/a"}. Blockers: ${(a.blockers || []).join("; ") || "none"}. Status: ${a.status}.`,
    }];
    const identity = { name: a.client, role: a.role, company: a.company, client: a.company || a.client };
    try {
      const draft = await draftTicket(synth, identity);
      setTicket(draft);
    } catch (e) {
      setTicketError("Couldn't draft the ticket from this session. Please try again.");
      setTicket({ title: "Draft unavailable", type: "Task", priority: "Medium", client: a.company || a.client, currentState: a.summary, futureState: "", acceptanceCriteria: [] });
    } finally {
      setDraftingId(null);
    }
  }
  function timeAgo(t) {
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return `${hrs}h ago`;
  }
  return (
    <div style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 20px" }}>
      <div style={{
        background: COLORS.navyLight, border: `1px solid ${COLORS.navyMid}`, borderRadius: 10,
        padding: "10px 14px", marginBottom: 18, color: COLORS.slate, fontSize: 12,
        fontFamily: "'DM Sans', sans-serif", lineHeight: 1.5,
      }}>
        In production, this feed is populated automatically — client sessions log to the account record via HubSpot and the backend, so the whole account team stays aware without anyone sharing manually.
      </div>

      {activities.length === 0 ? (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          textAlign: "center", padding: "48px 24px", gap: 10,
        }}>
          <div style={{ fontSize: 30 }}>📥</div>
          <div style={{ color: COLORS.white, fontSize: 15, fontWeight: 600, fontFamily: "'DM Sans', sans-serif" }}>
            No client activity yet
          </div>
          <div style={{ color: COLORS.slate, fontSize: 13, fontFamily: "'DM Sans', sans-serif", maxWidth: 320, lineHeight: 1.5 }}>
            When a client shares a session from the client view, a summary appears here for their account team.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {activities.map((a) => {
            const sc = statusColor(a.status);
            return (
              <div key={a.id} style={{
                background: COLORS.navyLight, border: `1px solid ${COLORS.navyMid}`,
                borderRadius: 12, padding: "14px 16px",
              }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 8, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ color: COLORS.white, fontSize: 14, fontWeight: 600, fontFamily: "'DM Sans', sans-serif" }}>{a.client || "Client"}</span>
                    {a.company && <span style={{ color: COLORS.amber, fontSize: 12, fontFamily: "'DM Sans', sans-serif" }}>· {a.company}</span>}
                    {a.role && <span style={{ color: COLORS.slate, fontSize: 12, fontFamily: "'DM Sans', sans-serif" }}>· {a.role}</span>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ background: COLORS.navyMid, color: COLORS.slateLight, borderRadius: 6, padding: "2px 8px", fontSize: 10, fontFamily: "'DM Mono', monospace", letterSpacing: "0.04em" }}>{a.module}</span>
                    <span style={{ color: COLORS.slate, fontSize: 11, fontFamily: "'DM Mono', monospace" }}>{timeAgo(a.id)}</span>
                  </div>
                </div>
                <div style={{ color: COLORS.offwhite, fontSize: 13, lineHeight: 1.55, fontFamily: "'DM Sans', sans-serif", marginBottom: 10 }}>{a.summary}</div>
                {a.topics && a.topics.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                    {a.topics.map((t, i) => (
                      <span key={i} style={{ background: "rgba(232,168,56,0.12)", color: COLORS.amber, borderRadius: 6, padding: "3px 8px", fontSize: 11, fontFamily: "'DM Mono', monospace" }}>{t}</span>
                    ))}
                  </div>
                )}
                {a.blockers && a.blockers.length > 0 && (
                  <div style={{ background: "rgba(232,89,74,0.10)", border: "1px solid rgba(232,89,74,0.22)", borderRadius: 8, padding: "8px 10px", marginBottom: 10 }}>
                    <div style={{ color: "#E8594A", fontSize: 10, fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 3 }}>Blocker flagged</div>
                    {a.blockers.map((b, i) => (
                      <div key={i} style={{ color: COLORS.offwhite, fontSize: 12, fontFamily: "'DM Sans', sans-serif", lineHeight: 1.45 }}>{b}</div>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ background: sc.bg, color: sc.fg, borderRadius: 6, padding: "3px 10px", fontSize: 11, fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{a.status}</span>
                  {needsTicket(a.status) && (
                    <button
                      onClick={() => draftFromActivity(a)}
                      disabled={draftingId === a.id}
                      style={{
                        background: "transparent",
                        border: `1px solid ${COLORS.amber}`,
                        borderRadius: 8,
                        padding: "6px 12px",
                        color: COLORS.amber,
                        cursor: draftingId === a.id ? "default" : "pointer",
                        fontSize: 11,
                        fontFamily: "'DM Mono', monospace",
                        fontWeight: 600,
                        letterSpacing: "0.03em",
                        opacity: draftingId === a.id ? 0.6 : 1,
                      }}
                    >
                      {draftingId === a.id ? "Drafting…" : "⊕ Draft ticket from this session"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      </div>

      {(ticket || ticketError) && (
        <TicketModal ticket={ticket} error={ticketError} onClose={() => { setTicket(null); setTicketError(null); }} />
      )}
    </div>
  );
}

export default function App() {
  const [viewAs, setViewAs] = useState("client");
  const [tabId, setTabId] = useState(TAB_CONFIG.client[0].id);
  const [activities, setActivities] = useState([]);

  const tabs = TAB_CONFIG[viewAs];
  const activeTab = tabs.find((t) => t.id === tabId) || tabs[0];

  function switchView(persona) {
    setViewAs(persona);
    setTabId(TAB_CONFIG[persona][0].id);
  }

  function addActivity(entry) {
    setActivities((prev) => [{ ...entry, id: Date.now() }, ...prev]);
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500;700&family=DM+Sans:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: ${COLORS.navy}; }
        @keyframes pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1.1); }
        }
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        textarea::placeholder { color: ${COLORS.slate}; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${COLORS.navyMid}; border-radius: 4px; }
      `}</style>

      <div
        style={{
          minHeight: "100vh",
          background: COLORS.navy,
          display: "flex",
          flexDirection: "column",
          fontFamily: "'DM Sans', sans-serif",
          animation: "fadeIn 0.4s ease",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "20px 28px 0",
            borderBottom: `1px solid ${COLORS.navyMid}`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 20,
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <span
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 20,
                  fontWeight: 700,
                  color: COLORS.amber,
                  letterSpacing: "0.06em",
                }}
              >
                MERIDIAN
              </span>
              <span
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 11,
                  color: COLORS.slate,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
              >
                Enablement Intelligence
              </span>
            </div>

            {/* View-as switcher */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 10,
                  color: COLORS.slate,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                View as
              </span>
              <div
                style={{
                  display: "flex",
                  background: COLORS.navyLight,
                  borderRadius: 8,
                  padding: 3,
                  border: `1px solid ${COLORS.navyMid}`,
                }}
              >
                {[
                  { id: "client", label: "Client" },
                  { id: "team", label: "Meridian Team" },
                ].map((v) => {
                  const on = viewAs === v.id;
                  return (
                    <button
                      key={v.id}
                      onClick={() => switchView(v.id)}
                      style={{
                        background: on ? COLORS.amber : "transparent",
                        color: on ? COLORS.navy : COLORS.slateLight,
                        border: "none",
                        borderRadius: 6,
                        padding: "6px 14px",
                        fontFamily: "'DM Mono', monospace",
                        fontSize: 11,
                        fontWeight: on ? 700 : 400,
                        letterSpacing: "0.04em",
                        cursor: "pointer",
                        transition: "all 0.15s",
                      }}
                    >
                      {v.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {tabs.map((t) => {
              const on = t.id === activeTab.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTabId(t.id)}
                  style={{
                    background: on ? COLORS.navyMid : "transparent",
                    border: "none",
                    borderBottom: on ? `2px solid ${COLORS.amber}` : "2px solid transparent",
                    padding: "10px 20px",
                    color: on ? COLORS.white : COLORS.slate,
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 12,
                    fontWeight: on ? 700 : 400,
                    letterSpacing: "0.06em",
                    cursor: "pointer",
                    textTransform: "uppercase",
                    borderRadius: "6px 6px 0 0",
                    transition: "all 0.2s",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  {t.label}
                  {t.type === "feed" && activities.length > 0 && (
                    <span style={{
                      background: COLORS.amber, color: COLORS.navy, borderRadius: 999,
                      minWidth: 18, height: 18, padding: "0 5px", fontSize: 10, fontWeight: 700,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      fontFamily: "'DM Mono', monospace",
                    }}>
                      {activities.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Tab content description */}
        <div
          style={{
            padding: "14px 28px",
            borderBottom: `1px solid ${COLORS.navyMid}`,
            background: COLORS.navyLight,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: COLORS.amber,
              flexShrink: 0,
            }}
          />
          <span style={{ color: COLORS.slateLight, fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>
            {activeTab.desc}
          </span>
        </div>

        {/* Chat / feed area */}
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {activeTab.type === "feed" ? (
            <ActivityFeed activities={activities} />
          ) : (
            <ChatInterface
              key={`${viewAs}-${activeTab.id}`}
              systemPrompt={activeTab.prompt}
              internal={activeTab.internal}
              clientFieldLabel={activeTab.clientField}
              canDraftTicket={activeTab.canDraftTicket}
              template={activeTab.template}
              companyField={activeTab.companyField}
              onShareSummary={activeTab.shareable ? addActivity : undefined}
              moduleLabel={activeTab.moduleLabel}
              placeholder="Type your response… (Enter to send)"
              startLabel={activeTab.startLabel}
            />
          )}
        </div>
      </div>
    </>
  );
}
