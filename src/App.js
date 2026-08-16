import { useState, useRef, useEffect } from "react";

// Calls our Vercel serverless proxy at /api/chat. The proxy attaches the
// Anthropic API key server-side — it is never exposed in the browser.
// We send a `mode` id, not prompt text: every system prompt and max_tokens
// value is owned by the server, so a caller hitting this endpoint directly
// (curl, a script) can't supply its own instructions or an unbounded token
// budget. See api/chat.js for the server-side prompt templates.
//
// A 30s client-side timeout backstops the server-side one: if the function
// ever hangs instead of erroring, the UI fails fast with a retryable error
// instead of spinning forever.
async function callAPI(messages, mode, identity, moduleLabel) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, mode, identity, moduleLabel }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Request failed: ${response.status}`);
    }
    const data = await response.json();
    return data.text || "";
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Request timed out");
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

const MESSAGE_CAP = 10;
function getMsgCount() {
  try { return parseInt(localStorage.getItem("meridian_msg_count") || "0", 10) || 0; }
  catch (e) { return 0; }
}
function bumpMsgCount() {
  try { const n = getMsgCount() + 1; localStorage.setItem("meridian_msg_count", String(n)); return n; }
  catch (e) { return 0; }
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

// Chat mode ids. The actual prompt text for each of these lives server-side
// in api/chat.js — the browser only ever sends the id, never instructions.
const MODE = {
  ONBOARDING_CLIENT: "onboarding_client",
  ONBOARDING_COPILOT: "onboarding_copilot",
  ONBOARDING_PRACTICE: "onboarding_practice",
  ONBOARDING_SHARED: "onboarding_shared",
  TRAINING_CLIENT: "training_client",
  TRAINING_TEAM: "training_team",
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

async function callClaude(messages, mode, identity) {
  const outbound = messages.length > 0 ? messages : [{ role: "user", content: "Please begin the session." }];
  const text = await callAPI(outbound, mode, identity);
  return text || "Sorry, I couldn't generate a response.";
}

// Asks the model to draft a Jira ticket from the conversation. Returns a parsed
// object or throws. The agent DRAFTS only — a human submits.
async function draftTicket(messages, identity) {
  const draftMessages = [
    ...messages,
    { role: "user", content: "Draft a Jira ticket capturing the key blocker or action item from our conversation. Return JSON only." },
  ];

  let text = await callAPI(draftMessages, "draft_ticket", identity);
  text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  return JSON.parse(text);
}

// Generates a session summary for the Meridian Team activity feed after a
// client session. Returns a parsed object or throws.
async function summarizeSession(messages, identity, moduleLabel) {
  const summaryMessages = [
    ...messages,
    { role: "user", content: "Summarize this session for my account team. Return JSON only." },
  ];

  let text = await callAPI(summaryMessages, "summarize_session", identity, moduleLabel);
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
// Client Activity feed. Manages its own asset + submit state. The user can edit
// the draft (title, current state, future state, acceptance criteria) before
// sending it, keeping a human fully in control of what goes to review.
function TicketModal({ ticket, error, onClose }) {
  const [assetLink, setAssetLink] = useState("");
  const [assetFiles, setAssetFiles] = useState([]);
  const [submitted, setSubmitted] = useState(false);
  const [editing, setEditing] = useState(false);
  const [originalFuture, setOriginalFuture] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const fileInputRef = useRef(null);

  // Editable working copy of the draft, seeded from the agent's draft.
  const [draft, setDraft] = useState(null);
  useEffect(() => {
    if (!ticket) { setDraft(null); return; }
    const fs = ticket.futureState;
    const futureStateText = (fs && typeof fs === "object")
      ? `As a ${fs.as}, I need to ${fs.need}, so that I can ${fs.soThat}.`
      : (fs || "");
    const criteria = Array.isArray(ticket.acceptanceCriteria)
      ? ticket.acceptanceCriteria.map((c) => (typeof c === "object"
          ? { actor: c.actor || "User", criterion: c.criterion || "" }
          : { actor: "", criterion: String(c) }))
      : [];
    setDraft({
      title: ticket.title || "",
      currentState: ticket.currentState || "",
      futureStateText,
      acceptanceCriteria: criteria,
      labels: Array.isArray(ticket.labels) ? ticket.labels.slice() : [],
    });
    setOriginalFuture(futureStateText);
  }, [ticket]);

  function handleFilePick(e) {
    const files = Array.from(e.target.files || []);
    if (files.length) setAssetFiles((prev) => [...prev, ...files.map((f) => f.name)]);
    e.target.value = "";
  }

  const inputStyle = {
    width: "100%", background: COLORS.navyMid, border: `1px solid ${COLORS.amber}`,
    borderRadius: 8, padding: "9px 12px", color: COLORS.white, fontFamily: "'DM Sans', sans-serif",
    fontSize: 13, outline: "none", lineHeight: 1.5, resize: "vertical",
  };
  const labelStyle = { color: COLORS.slate, fontSize: 10, fontFamily: "'DM Mono', monospace", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 };

  function updateCriterion(i, val) {
    setDraft((d) => ({ ...d, acceptanceCriteria: d.acceptanceCriteria.map((c, j) => j === i ? { ...c, criterion: val } : c) }));
  }
  function removeCriterion(i) {
    setDraft((d) => ({ ...d, acceptanceCriteria: d.acceptanceCriteria.filter((_, j) => j !== i) }));
  }
  function addCriterion() {
    setDraft((d) => ({ ...d, acceptanceCriteria: [...d.acceptanceCriteria, { actor: "Proposed", criterion: "" }] }));
  }
  function removeLabel(i) {
    setDraft((d) => ({ ...d, labels: d.labels.filter((_, j) => j !== i) }));
  }
  function addLabel() {
    const v = labelInput.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!v) return;
    setDraft((d) => d.labels.includes(v) ? d : ({ ...d, labels: [...d.labels, v] }));
    setLabelInput("");
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
            {submitted ? "Draft Sent to Jira" : (editing ? "Edit Draft" : "Draft Jira Ticket")}
          </span>
          <button onClick={onClose} style={{ background: "transparent", border: "none",
            color: COLORS.slate, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: 18 }}>
          {error && (
            <div style={{ color: "#E8594A", fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>{error}</div>
          )}

          {ticket && draft && !submitted && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, maxHeight: "62vh", overflowY: "auto" }}>
              <div>
                <div style={labelStyle}>Title</div>
                {editing ? (
                  <input value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} style={inputStyle} />
                ) : (
                  <div style={{ color: COLORS.white, fontSize: 15, fontWeight: 600, fontFamily: "'DM Sans', sans-serif" }}>{draft.title}</div>
                )}
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {[{ k: "Type", v: ticket.type }, { k: "Priority", v: ticket.priority }, { k: "Client", v: ticket.client }].map((fld) => (
                  <div key={fld.k} style={{ background: COLORS.navyMid, borderRadius: 8, padding: "6px 10px" }}>
                    <div style={{ color: COLORS.slate, fontSize: 9, fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", textTransform: "uppercase" }}>{fld.k}</div>
                    <div style={{ color: COLORS.white, fontSize: 13, fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}>{fld.v}</div>
                  </div>
                ))}
              </div>
              {(editing || draft.labels.length > 0) && (
                <div>
                  <div style={labelStyle}>Labels</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    {draft.labels.map((lb, i) => (
                      <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: COLORS.navyMid, color: COLORS.slateLight, borderRadius: 6, padding: "3px 9px", fontSize: 11, fontFamily: "'DM Mono', monospace" }}>
                        {lb}
                        {editing && (
                          <button onClick={() => removeLabel(i)} style={{ background: "transparent", border: "none", color: COLORS.slate, cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
                        )}
                      </span>
                    ))}
                    {editing && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <input
                          value={labelInput}
                          onChange={(e) => setLabelInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLabel(); } }}
                          placeholder="add label"
                          style={{ background: COLORS.navyMid, border: `1px solid ${COLORS.amber}`, borderRadius: 6, padding: "3px 8px", color: COLORS.white, fontFamily: "'DM Mono', monospace", fontSize: 11, outline: "none", width: 90 }}
                        />
                        <button onClick={addLabel} style={{ background: "transparent", border: "none", color: COLORS.amber, cursor: "pointer", fontSize: 11, fontFamily: "'DM Mono', monospace", fontWeight: 700 }}>+ Add</button>
                      </span>
                    )}
                  </div>
                </div>
              )}
              <div>
                <div style={labelStyle}>Current State</div>
                {editing ? (
                  <textarea value={draft.currentState} onChange={(e) => setDraft((d) => ({ ...d, currentState: e.target.value }))} rows={3} style={inputStyle} />
                ) : (
                  <div style={{ color: COLORS.offwhite, fontSize: 13, lineHeight: 1.55, fontFamily: "'DM Sans', sans-serif" }}>{draft.currentState}</div>
                )}
              </div>
              <div>
                <div style={labelStyle}>Future State</div>
                {editing ? (
                  <textarea value={draft.futureStateText} onChange={(e) => setDraft((d) => ({ ...d, futureStateText: e.target.value }))} rows={3} style={inputStyle} />
                ) : (
                  <div style={{ background: COLORS.navyMid, borderRadius: 8, padding: "10px 12px", fontSize: 13, lineHeight: 1.6, fontFamily: "'DM Sans', sans-serif", color: COLORS.offwhite }}>
                    {draft.futureStateText}
                  </div>
                )}
              </div>
              <div>
                <div style={labelStyle}>Assets</div>
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
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <div style={{ color: COLORS.slate, fontSize: 10, fontFamily: "'DM Mono', monospace", letterSpacing: "0.08em", textTransform: "uppercase" }}>Acceptance Criteria</div>
                  {editing && (
                    <button onClick={addCriterion} style={{ background: "transparent", border: "none", color: COLORS.amber, cursor: "pointer", fontSize: 11, fontFamily: "'DM Mono', monospace", fontWeight: 700 }}>+ Add</button>
                  )}
                </div>
                {editing && draft.futureStateText.trim() !== originalFuture.trim() && (
                  <div style={{ background: "rgba(232,168,56,0.12)", border: `1px solid rgba(232,168,56,0.35)`, borderRadius: 8, padding: "8px 11px", marginBottom: 8, color: COLORS.amber, fontSize: 11, fontFamily: "'DM Sans', sans-serif", lineHeight: 1.45 }}>
                    You edited the Future State. Review the criteria below, some may no longer match the revised story, and confirm User and System coverage.
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {draft.acceptanceCriteria.map((c, i) => {
                    const actor = c.actor;
                    return (
                      <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        {actor && (
                          <span style={{ flexShrink: 0, background: actor.toLowerCase().startsWith("sys") ? "rgba(61,190,138,0.16)" : actor.toLowerCase().startsWith("prop") ? "rgba(106,128,153,0.18)" : "rgba(232,168,56,0.16)", color: actor.toLowerCase().startsWith("sys") ? COLORS.green : actor.toLowerCase().startsWith("prop") ? COLORS.slateLight : COLORS.amber, borderRadius: 5, padding: "2px 7px", fontSize: 10, fontFamily: "'DM Mono', monospace", fontWeight: 700, marginTop: editing ? 8 : 1, textTransform: "uppercase" }}>{actor}</span>
                        )}
                        {editing ? (
                          <div style={{ display: "flex", gap: 6, flex: 1, alignItems: "flex-start" }}>
                            <textarea value={c.criterion} onChange={(e) => updateCriterion(i, e.target.value)} rows={2} style={{ ...inputStyle, fontSize: 12 }} />
                            <button onClick={() => removeCriterion(i)} style={{ background: "transparent", border: "none", color: COLORS.slate, cursor: "pointer", fontSize: 16, flexShrink: 0, marginTop: 6 }}>×</button>
                          </div>
                        ) : (
                          <span style={{ color: COLORS.offwhite, fontSize: 13, lineHeight: 1.5, fontFamily: "'DM Sans', sans-serif" }}>{c.criterion}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {editing && (
                  <div style={{ color: COLORS.slate, fontSize: 11, fontFamily: "'DM Sans', sans-serif", marginTop: 8, lineHeight: 1.45 }}>
                    {/* Tabs */}
Added criteria are marked Proposed. Adding or removing criteria can affect User and System coverage, so the PM and dev team confirm the final set at review.
                  </div>
                )}
              </div>
              {editing ? (
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button onClick={() => setEditing(false)} style={{ flex: 1, background: COLORS.amber, color: COLORS.navy, border: "none", borderRadius: 9, padding: "11px 16px", fontFamily: "'DM Mono', monospace", fontSize: 13, fontWeight: 700, cursor: "pointer", letterSpacing: "0.03em" }}>
                    Save changes
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button onClick={() => setSubmitted(true)} style={{ flex: 1, background: COLORS.amber, color: COLORS.navy, border: "none", borderRadius: 9, padding: "11px 16px", fontFamily: "'DM Mono', monospace", fontSize: 13, fontWeight: 700, cursor: "pointer", letterSpacing: "0.03em" }}>
                    Send draft to Jira →
                  </button>
                  <button onClick={() => setEditing(true)} style={{ background: "transparent", color: COLORS.amber, border: `1px solid ${COLORS.amber}`, borderRadius: 9, padding: "11px 16px", fontFamily: "'DM Mono', monospace", fontSize: 13, cursor: "pointer" }}>
                    Edit
                  </button>
                  <button onClick={onClose} style={{ background: "transparent", color: COLORS.slate, border: `1px solid ${COLORS.navyMid}`, borderRadius: 9, padding: "11px 16px", fontFamily: "'DM Mono', monospace", fontSize: 13, cursor: "pointer" }}>
                    Discard
                  </button>
                </div>
              )}
              <div style={{ color: COLORS.slate, fontSize: 11, fontFamily: "'DM Sans', sans-serif", textAlign: "center", lineHeight: 1.4 }}>
                {editing
                  ? "Refine any field, the agent drafts, but you decide what goes to review."
                  : "In production the app posts this draft to Jira via API in a review status; a product manager reviews and approves it in Jira before it becomes active."}
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
function ChatInterface({ mode, placeholder, startLabel, internal, clientFieldLabel, canDraftTicket, template, onShareSummary, moduleLabel, companyField }) {
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
  const [capReached, setCapReached] = useState(getMsgCount() >= MESSAGE_CAP);
  const [error, setError] = useState(null);
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

  const missingFields = [];
  if (!name.trim()) missingFields.push("name");
  if (!role.trim()) missingFields.push("role");
  if (companyField && !company.trim()) missingFields.push(companyField.toLowerCase());
  if (isInternal && !client.trim()) missingFields.push((clientFieldLabel || "client account").toLowerCase());
  const missingText =
    missingFields.length === 0 ? "" :
    missingFields.length === 1 ? missingFields[0] :
    missingFields.slice(0, -1).join(", ") + " and " + missingFields[missingFields.length - 1];

  async function startConversation() {
    if (!formValid) return;
    setStarted(true);
    setLoading(true);
    setError(null);
    try {
      const reply = await callClaude([], mode, identity);
      setMessages([{ role: "assistant", content: reply }]);
    } catch (e) {
      setError("Couldn't reach Meridian. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;
    if (getMsgCount() >= MESSAGE_CAP) { setCapReached(true); return; }
    bumpMsgCount();
    const userMsg = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    setError(null);
    try {
      const reply = await callClaude(newMessages, mode, identity);
      setMessages([...newMessages, { role: "assistant", content: reply }]);
    } catch (e) {
      setError("Couldn't reach Meridian. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // Retries the last attempt, whether it was the initial greeting (messages
  // still empty) or a follow-up (messages already includes the user's turn) —
  // callClaude handles the empty case the same way startConversation does.
  async function retryLast() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const reply = await callClaude(messages, mode, identity);
      setMessages(messages.length > 0 ? [...messages, { role: "assistant", content: reply }] : [{ role: "assistant", content: reply }]);
    } catch (e) {
      setError("Couldn't reach Meridian. Please try again.");
    } finally {
      setLoading(false);
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
            ? "In production, your name, role, and client account are populated automatically from HubSpot."
            : "In production, your name, role, and company name are populated automatically from HubSpot."}
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

        {!formValid && (
          <div style={{
            marginTop: 12,
            color: COLORS.slate,
            fontSize: 12,
            fontFamily: "'DM Sans', sans-serif",
            textAlign: "center",
          }}>
            Enter your {missingText} to begin.
          </div>
        )}
        <div style={{
          marginTop: 14,
          color: COLORS.slate,
          fontSize: 11,
          fontFamily: "'DM Sans', sans-serif",
          textAlign: "center",
          opacity: 0.85,
        }}>
          This is a demo. Your name and messages are in no way stored or saved.
        </div>
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
        {error && !loading && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              background: "rgba(232,89,74,0.12)",
              border: `1px solid ${COLORS.red}`,
              borderRadius: 10,
              padding: "10px 14px",
              marginBottom: 16,
            }}
          >
            <span style={{ color: COLORS.red, fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>{error}</span>
            <button
              onClick={retryLast}
              style={{
                background: "transparent",
                border: `1px solid ${COLORS.red}`,
                borderRadius: 6,
                padding: "5px 12px",
                color: COLORS.red,
                cursor: "pointer",
                fontSize: 12,
                fontFamily: "'DM Mono', monospace",
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              Try again
            </button>
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

      {/* Input or cap banner */}
      {capReached ? (
        <div style={{ padding: "16px 20px", borderTop: `1px solid ${COLORS.navyMid}`, textAlign: "center" }}>
          <div style={{ color: COLORS.white, fontSize: 14, fontWeight: 600, fontFamily: "'DM Sans', sans-serif", marginBottom: 6 }}>
            You've reached the demo limit.
          </div>
          <div style={{ color: COLORS.slate, fontSize: 13, fontFamily: "'DM Sans', sans-serif", marginBottom: 12 }}>
            Thanks for exploring Meridian! I'd love to hear your thoughts.
          </div>
          <a href="https://www.linkedin.com/in/tom-porto/" target="_blank" rel="noopener noreferrer"
            style={{ display: "inline-block", background: COLORS.amber, color: COLORS.navy, textDecoration: "none", borderRadius: 9, padding: "10px 18px", fontFamily: "'DM Mono', monospace", fontSize: 13, fontWeight: 700, letterSpacing: "0.03em" }}>
            Connect with me on LinkedIn
          </a>
        </div>
      ) : (
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
      )}
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
      mode: MODE.ONBOARDING_CLIENT,
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
      mode: MODE.TRAINING_CLIENT,
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
      id: "copilot",
      label: "Onboarding Co-pilot",
      mode: MODE.ONBOARDING_COPILOT,
      internal: true,
      canDraftTicket: true,
      clientField: "Client name / account",
      startLabel: "Onboarding Co-pilot",
      desc: "Prep and track a client's onboarding — next steps, likely blockers, and follow-ups.",
    },
    {
      id: "training-copilot",
      label: "Training Co-pilot",
      mode: MODE.TRAINING_TEAM,
      internal: true,
      canDraftTicket: true,
      clientField: "Client name / account",
      startLabel: "Training Co-pilot",
      desc: "Identify what training to offer this client based on their usage and goals.",
    },
    {
      id: "activity",
      label: "Client Activity",
      type: "feed",
      desc: "See summaries of recent client self-service sessions, shared by clients with their account team.",
    },
    {
      id: "practice",
      label: "Practice",
      mode: MODE.ONBOARDING_PRACTICE,
      internal: true,
      clientField: "Scenario / client",
      startLabel: "Onboarding Practice",
      desc: "Role-play the onboarding flow — as the client or the CSM — to master the process.",
    },
    {
      id: "shared",
      label: "Shared Session",
      mode: MODE.ONBOARDING_SHARED,
      internal: true,
      clientField: "Client name / account",
      startLabel: "Shared Onboarding Session",
      desc: "Facilitate a live onboarding call with the client and CSM together.",
    },
  ],
};

function ActivityFeed({ activities, teamMember, setTeamMember, onMarkHandled }) {
  const [ticket, setTicket] = useState(null);
  const [ticketError, setTicketError] = useState(null);
  const [draftingId, setDraftingId] = useState(null);
  const [outreachFor, setOutreachFor] = useState(null);
  const [nameError, setNameError] = useState(false);

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
    const slug = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const labels = [];
    (a.topics || []).forEach((t) => { const x = slug(t); if (x && !labels.includes(x)) labels.push(x); });
    const st = (a.status || "").toLowerCase();
    if (st.includes("block")) labels.push("blocker");
    else if (st.includes("follow")) labels.push("needs-follow-up");
    try {
      const draft = await draftTicket(synth, identity);
      setTicket({ ...draft, labels });
    } catch (e) {
      setTicketError("Couldn't draft the ticket from this session. Please try again.");
      setTicket({ title: "Draft unavailable", type: "Task", priority: "Medium", client: a.company || a.client, currentState: a.summary, futureState: "", acceptanceCriteria: [], labels });
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

  // Computed rollup of the feed so far (no AI call, just tallies).
  const summary = (() => {
    const total = activities.length;
    const clients = new Set(activities.map((a) => a.company || a.client).filter(Boolean)).size;
    const flagged = activities.filter((a) => needsTicket(a.status)).length;
    const blockers = activities.filter((a) => (a.status || "").toLowerCase().includes("block")).length;
    const moduleCounts = {};
    activities.forEach((a) => { if (a.module) moduleCounts[a.module] = (moduleCounts[a.module] || 0) + 1; });
    let topModule = null, topN = 0;
    Object.keys(moduleCounts).forEach((m) => { if (moduleCounts[m] > topN) { topN = moduleCounts[m]; topModule = m; } });
    return { total, clients, flagged, blockers, topModule };
  })();

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

      <div style={{
        background: COLORS.navyLight, border: `1px solid ${nameError ? "#E8594A" : COLORS.navyMid}`, borderRadius: 10,
        padding: "10px 14px", marginBottom: 18, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      }}>
        <span style={{ color: COLORS.slate, fontSize: 10, fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", textTransform: "uppercase", flexShrink: 0 }}>Acting as</span>
        <input
          value={teamMember}
          onChange={(e) => { setTeamMember(e.target.value); if (e.target.value.trim()) setNameError(false); }}
          placeholder="your name"
          style={{ flex: 1, minWidth: 120, background: COLORS.navyMid, border: "none", borderRadius: 6, padding: "6px 10px", color: COLORS.white, fontFamily: "'DM Sans', sans-serif", fontSize: 13, outline: "none" }}
        />
        <span style={{ color: COLORS.slate, fontSize: 11, fontFamily: "'DM Sans', sans-serif", flexBasis: "100%", lineHeight: 1.4 }}>
          {nameError ? "Enter your name so actions can be attributed." : "In production this is your authenticated HubSpot identity, so every action is automatically attributed."}
        </span>
      </div>

      {activities.length > 0 && (
        <div style={{
          background: COLORS.navyLight, border: `1px solid ${COLORS.navyMid}`, borderRadius: 10,
          padding: "12px 14px", marginBottom: 18,
        }}>
          <div style={{ color: COLORS.slate, fontSize: 10, fontFamily: "'DM Mono', monospace", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>Activity Summary</div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
            {[
              { n: summary.total, label: summary.total === 1 ? "session" : "sessions" },
              { n: summary.clients, label: summary.clients === 1 ? "client" : "clients" },
              { n: summary.flagged, label: "flagged", accent: summary.flagged > 0 },
              { n: summary.blockers, label: summary.blockers === 1 ? "blocker" : "blockers", accent: summary.blockers > 0 },
            ].map((s, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ color: s.accent ? COLORS.amber : COLORS.white, fontSize: 20, fontWeight: 700, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>{s.n}</span>
                <span style={{ color: COLORS.slate, fontSize: 11, fontFamily: "'DM Sans', sans-serif", marginTop: 3 }}>{s.label}</span>
              </div>
            ))}
          </div>
          {summary.topModule && (
            <div style={{ color: COLORS.slate, fontSize: 11, fontFamily: "'DM Sans', sans-serif", marginTop: 10, lineHeight: 1.4 }}>
              Most active area: <span style={{ color: COLORS.slateLight, fontWeight: 600 }}>{summary.topModule}</span>{summary.flagged > 0 ? `. ${summary.flagged} ${summary.flagged === 1 ? "session needs" : "sessions need"} follow-up.` : "."}
            </div>
          )}
        </div>
      )}

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

function AboutModal({ onClose }) {
  const Section = ({ label, children }) => (
    <div style={{ marginBottom: 18 }}>
      <div style={{ color: COLORS.amber, fontSize: 10, fontFamily: "'DM Mono', monospace", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
      <div style={{ color: COLORS.offwhite, fontSize: 14, lineHeight: 1.6, fontFamily: "'DM Sans', sans-serif" }}>{children}</div>
    </div>
  );
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(6,12,20,0.75)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 520, maxHeight: "85vh", overflowY: "auto", background: COLORS.navyLight, border: `1px solid ${COLORS.navyMid}`, borderRadius: 16, boxShadow: "0 24px 70px rgba(0,0,0,0.55)" }}>
        <div style={{ padding: "18px 22px", borderBottom: `1px solid ${COLORS.navyMid}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 18, fontWeight: 700, color: COLORS.amber, letterSpacing: "0.06em" }}>MERIDIAN</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: COLORS.slate, letterSpacing: "0.1em", textTransform: "uppercase" }}>Enablement Intelligence</span>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: COLORS.slate, cursor: "pointer", fontSize: 20, lineHeight: 1 }}>&times;</button>
        </div>
        <div style={{ padding: 22 }}>
          <Section label="What this is">
            This is a working demo I built. Meridian is a fictional SaaS company (a company that provides software as a service). This demo uses an AI assistant for client enablement: helping customers get up and running on Meridian's software, and helping the Meridian team support them. Customers get guided onboarding (help getting set up) and work out what they need to learn. The Meridian team gets help supporting customers, tracking client activity, and turning a conversation into a follow-up task (a Jira ticket, Jira being a tool many teams use to track work). Meridian is fictional, but the work patterns are real and transferable. For the purposes of this demo, nothing you type is saved after your visit.
          </Section>
          <Section label="Why I built it">
            I believe the fastest way to learn what's worth building is to build something real and put it in front of people. Business analysts call this 'build to elicit'. Rather than only describing how I approach problems, I wanted to show it. I did enough analysis to know who the users are and what's worth building, then designed, built, and shipped this app. Every reaction to the app is a form of elicitation that sharpens the thinking.
          </Section>
          <Section label="A note on governance">
            Any action with a real consequence, like drafting a Jira ticket, is proposed by the agent and approved by a human. The human-in-the-loop step is deliberate governance while the agent earns trust, with a path to more autonomy over time.
          </Section>
          <Section label="Who built it">
            I'm a client enablement and business analysis professional. I built this app as I conduct a job search for my next role. If you'd like to know more about how I work and approach problems, or you're hiring in healthcare, education, or New York City government in business analysis, client enablement, or product operations, I'd love to connect!
          </Section>
          <a href="https://www.linkedin.com/in/tom-porto/" target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", background: COLORS.amber, color: COLORS.navy, textDecoration: "none", borderRadius: 9, padding: "11px 20px", fontFamily: "'DM Mono', monospace", fontSize: 13, fontWeight: 700, letterSpacing: "0.03em", marginTop: 4 }}>
            Connect with me on LinkedIn &rarr;
          </a>
          <div style={{ color: COLORS.slate, fontSize: 11, fontFamily: "'DM Sans', sans-serif", marginTop: 16, lineHeight: 1.5 }}>
            Meridian is a fictional company used for portfolio demonstration purposes only.
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [viewAs, setViewAs] = useState("client");
  const [tabId, setTabId] = useState(TAB_CONFIG.client[0].id);
  const [activities, setActivities] = useState([]);
  const [seenCount, setSeenCount] = useState(0);
  const [teamMember, setTeamMember] = useState("");
  const [aboutOpen, setAboutOpen] = useState(false);

  const tabs = TAB_CONFIG[viewAs];
  const activeTab = tabs.find((t) => t.id === tabId) || tabs[0];

  function switchView(persona) {
    setViewAs(persona);
    setTabId(TAB_CONFIG[persona][0].id);
  }

  function addActivity(entry) {
    setActivities((prev) => [{ ...entry, id: Date.now() }, ...prev]);
  }

  function markHandled(id, handled) {
    setActivities((prev) => prev.map((a) => a.id === id ? { ...a, handled } : a));
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

      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
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
                onClick={() => setAboutOpen(true)}
                title="About this project"
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 20,
                  fontWeight: 700,
                  color: COLORS.amber,
                  letterSpacing: "0.06em",
                  cursor: "pointer",
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
              <button
                onClick={() => setAboutOpen(true)}
                style={{
                  background: "transparent",
                  border: `1px solid ${COLORS.navyMid}`,
                  borderRadius: 6,
                  padding: "3px 10px",
                  color: COLORS.slateLight,
                  cursor: "pointer",
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 10,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                }}
              >
                About
              </button>
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
                View as:
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
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 14, paddingTop: 14, borderTop: `1px solid ${COLORS.navyMid}` }}>
            {tabs.map((t) => {
              const on = t.id === activeTab.id;
              return (
                <button
                  key={t.id}
                  onClick={() => {
                    setTabId(t.id);
                    if (t.type === "feed") setSeenCount(activities.length);
                  }}
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
                  {t.type === "feed" && (activities.length - seenCount) > 0 && (
                    <span style={{
                      background: COLORS.amber, color: COLORS.navy, borderRadius: 999,
                      minWidth: 18, height: 18, padding: "0 5px", fontSize: 10, fontWeight: 700,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      fontFamily: "'DM Mono', monospace",
                    }}>
                      {activities.length - seenCount}
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
            <ActivityFeed activities={activities} teamMember={teamMember} setTeamMember={setTeamMember} onMarkHandled={markHandled} />
          ) : (
            <ChatInterface
              key={`${viewAs}-${activeTab.id}`}
              mode={activeTab.mode}
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