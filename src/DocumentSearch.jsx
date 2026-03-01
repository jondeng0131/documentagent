import { useState, useRef, useCallback } from "react";

// ─── Helpers ────────────────────────────────────────────────────────────────

// Fetch with timeout — prevents API calls hanging forever
async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error("Request timed out after " + timeoutMs / 1000 + "s");
    throw e;
  }
}

// Load a script from CDN once, return promise
function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      // Already loading — wait for it
      existing.addEventListener("load", () => resolve(window[globalName]));
      existing.addEventListener("error", reject);
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve(window[globalName]);
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function loadPdfJs() {
  const lib = await loadScript(
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    "pdfjsLib"
  );
  if (lib && !lib.GlobalWorkerOptions.workerSrc) {
    lib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  return lib;
}

async function loadMammoth() {
  return loadScript(
    "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js",
    "mammoth"
  );
}

async function extractFromPDF(file) {
  // Try PDF.js first
  try {
    const pdfjsLib = await loadPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(" ");
      fullText += `[Page ${i}]\n${pageText}\n\n`;
    }
    if (fullText.trim().length > 100) return fullText.trim();
  } catch (e) {
    console.warn("PDF.js failed, trying text fallback:", e.message);
  }

  // Fallback: read as raw text and extract ASCII
  try {
    const text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
    const readable = text.replace(/[^\x20-\x7E\n\r\t]/g, " ")
      .replace(/\s+/g, " ")
      .split(" ")
      .filter(w => w.length > 2 && /[a-zA-Z]/.test(w))
      .join(" ");
    if (readable.length > 100) return readable;
  } catch (e) {
    console.warn("Text fallback failed:", e.message);
  }

  return `[PDF document: ${file.name}. Content extraction unavailable — validate based on filename only.]`;
}

async function extractFromDOCX(file) {
  try {
    const mammoth = await loadMammoth();
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    if (result && result.value && result.value.trim().length > 10) {
      return result.value.trim();
    }
  } catch (e) {
    console.warn("Mammoth DOCX failed:", e.message);
  }
  // Fallback: read as raw text
  try {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result || "");
      reader.onerror = reject;
      reader.readAsText(file);
    });
  } catch {
    return `[DOCX document: ${file.name}. Content extraction unavailable.]`;
  }
}

function extractFromCSV(text) {
  // Convert CSV rows into readable key:value pairs
  const lines = text.trim().split("\n");
  if (lines.length === 0) return text;
  const headers = lines[0].split(",").map(h => h.trim().replace(/"/g, ""));
  const rows = lines.slice(1).map(line => {
    const values = line.split(",").map(v => v.trim().replace(/"/g, ""));
    return headers.map((h, i) => `${h}: ${values[i] || ""}`).join(" | ");
  });
  return `Headers: ${headers.join(", ")}\n\n${rows.join("\n")}`;
}

async function extractTextFromFile(file) {
  const name = file.name.toLowerCase();

  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    return await extractFromPDF(file);
  }

  if (name.endsWith(".docx") || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return await extractFromDOCX(file);
  }

  // CSV, TXT, MD, JSON — all plain text
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      resolve(name.endsWith(".csv") ? extractFromCSV(text) : text);
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

function highlightKeywords(text, query) {
  if (!query || !text) return text;
  const words = query.split(/\s+/).filter(w => w.length > 2);
  let result = text;
  words.forEach(word => {
    const re = new RegExp(`(${word})`, "gi");
    result = result.replace(re, `<mark>$1</mark>`);
  });
  return result;
}

// ─── Insurance Validation ───────────────────────────────────────────────────

async function validateInsuranceDocument(name, content) {
  const nameLower = name.toLowerCase();

  // Fast-path: always accept PHR files without calling AI
  const phrKeywords = ["phr", "health record", "medical record", "patient record", "clinical", "visit summary", "discharge", "lab result", "medication"];
  if (phrKeywords.some(k => nameLower.includes(k))) {
    return { is_insurance: true, reason: "PHR file accepted for doctor history analysis", document_type: "PHR Medical Record" };
  }

  // Fast-path: always accept obvious insurance files
  const insuranceKeywords = ["cigna", "aetna", "humana", "united", "anthem", "bcbs", "bluecross", "kaiser", "insurance", "coverage", "benefits", "policy", "sbc", "eob", "deductible", "premium", "copay", "claim"];
  if (insuranceKeywords.some(k => nameLower.includes(k))) {
    return { is_insurance: true, reason: "Insurance document detected from filename", document_type: "Insurance Document" };
  }

  const preview = content.slice(0, 3000);
  const contentFailed = content.includes("Content extraction unavailable");

  const response = await fetchWithTimeout("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 200,
      system: `You are a document classifier for a health insurance + PHR analysis tool. Determine if the file should be accepted.

ACCEPT if the file is ANY of:
1. Insurance documents — health plans, SBC, EOB, coverage summaries, policies, claims, deductibles, copays, benefits, dental, vision, life, property, workers comp, endorsements, declarations, premium schedules, etc.
2. PHR (Personal Health Records) — ANY medical record, patient health record, clinical notes, visit summaries, lab results, medication lists, doctor notes, discharge summaries. PHRs are ALWAYS accepted even if they contain zero insurance data — they are used to extract doctor visit history.
3. Any file with "PHR", "health record", "medical record", "patient record", "visit", "clinical" in the filename.

REJECT only: recipes, resumes, spreadsheets, legal contracts, or files completely unrelated to health or insurance.

IMPORTANT: The filename "${name}" contains "phr" — this is a PHR file and must be ACCEPTED.

Return ONLY valid JSON: { "is_insurance": true | false, "reason": "one sentence explanation", "document_type": "Health Insurance SBC | PHR Medical Record | EOB | Policy | PHR with Insurance Data | Not Health Related" }`,
      messages: [{ role: "user", content: `Filename: "${name}"\nContent extraction ${contentFailed ? "FAILED — use filename only" : "succeeded"}.\n\nContent preview:\n${preview}\n\nIs this insurance-related? Return JSON only.` }],
    }),
  });
  const data = await response.json();
  const raw = data.content?.[0]?.text || "{}";
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── API Call ───────────────────────────────────────────────────────────────

async function searchDocuments(query, documents) {
  const docContext = documents.map((d, i) =>
    `=== DOCUMENT ${i + 1}: ${d.name} ===\n${d.content}`
  ).join("\n\n");

  const systemPrompt = `You are a precise insurance document search engine. Your ONLY job is to find information from the provided insurance documents.

STRICT RULES:
1. NEVER invent, infer, or extrapolate information not explicitly present in the documents
2. NEVER use your general knowledge — only the document content
3. These documents are insurance-related only — all answers must relate to insurance content
4. If the information is not in the documents, you MUST return unknown state
5. Always assess confidence based on how directly the documents answer the query
6. Confidence scoring:
   - 0.9-1.0: Direct, explicit, verbatim answer found in the insurance document
   - 0.7-0.89: Answer clearly implied or paraphrased in the insurance document
   - 0.5-0.69: Partial or tangentially related insurance information found
   - Below 0.5: Very weak match, likely not relevant
   - 0.0: Nothing found — return unknown

Return ONLY valid JSON in this exact format:
{
  "state": "found" | "partial" | "unknown",
  "confidence": 0.0 to 1.0,
  "answer": "The answer text drawn ONLY from the documents. Empty string if unknown.",
  "sources": ["Document name and relevant excerpt where the answer was found"],
  "keywords_matched": ["list of keywords from the query that matched"],
  "reason_if_unknown": "Why the information could not be found. Only if state is unknown.",
  "needs_more_info": "What additional information would help answer this query. Only if unknown."
}`;

  const userMessage = `DOCUMENTS:\n${docContext}\n\nUSER QUERY: "${query}"\n\nSearch both by keyword matching AND contextual/semantic meaning. Return JSON only.`;

  const response = await fetchWithTimeout("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  const data = await response.json();
  const raw = data.content?.[0]?.text || "{}";
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── Components ─────────────────────────────────────────────────────────────

const ConfidenceMeter = ({ score }) => {
  const pct = Math.round(score * 100);
  const color = score >= 0.7 ? "#4ade80" : score >= 0.5 ? "#fb923c" : "#f87171";
  const label = score >= 0.9 ? "HIGH" : score >= 0.7 ? "GOOD" : score >= 0.5 ? "LOW" : "VERY LOW";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ flex: 1, height: 4, background: "#1e293b", borderRadius: 99, overflow: "hidden" }}>
        <div style={{
          width: `${pct}%`, height: "100%", background: color,
          borderRadius: 99, transition: "width 0.8s cubic-bezier(.4,0,.2,1)",
          boxShadow: `0 0 8px ${color}80`
        }} />
      </div>
      <span style={{ fontSize: 11, color, fontWeight: 700, minWidth: 80, letterSpacing: "0.06em" }}>
        {pct}% {label}
      </span>
    </div>
  );
};

const FileChip = ({ file, onRemove }) => (
  <div style={{
    display: "flex", alignItems: "center", gap: 8,
    background: "#0f172a", border: "1px solid #1e293b",
    borderRadius: 6, padding: "6px 10px", fontSize: 12,
  }}>
    <span style={{ fontSize: 14 }}>
      {file.name.endsWith(".pdf") ? "📄" : file.name.endsWith(".csv") ? "📊" : file.name.endsWith(".docx") ? "📝" : "🗒️"}
    </span>
    <span style={{ color: "#f1f5f9", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      {file.name}
    </span>
    <span style={{ fontSize: 10, color: "#475569" }}>
      {(file.size / 1024).toFixed(0)}kb
    </span>
    <button onClick={onRemove} style={{
      background: "none", border: "none", color: "#475569",
      cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0,
      marginLeft: 4,
    }}>×</button>
  </div>
);

// ─── Main App ───────────────────────────────────────────────────────────────

export default function App() {
  const [step, setStep] = useState("upload");
  const [documents, setDocuments] = useState([]);
  const [files, setFiles] = useState([]);
  const [rejectedFiles, setRejectedFiles] = useState([]);
  const [validating, setValidating] = useState(false);
  const [validationProgress, setValidationProgress] = useState([]);
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [collapsedItems, setCollapsedItems] = useState({});
  const toggleCollapse = (id) => setCollapsedItems(prev => ({ ...prev, [id]: !prev[id] }));
  const [clarifications, setClarifications] = useState({});
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [recommendations, setRecommendations] = useState(null);
  const [recsLoading, setRecsLoading] = useState(false);
  const [bottomHeight, setBottomHeight] = useState(50);
  const [activeTab, setActiveTab] = useState("search");
  const fileInputRef = useRef();
  const dragRef = useRef(null);
  const resultsRef = useRef(null);

  const handleDragRef = useRef(null);
  const stopDragRef = useRef(null);

  const handleDrag = useCallback((e) => {
    const vh = window.innerHeight;
    const newPct = Math.round(((vh - e.clientY) / vh) * 100);
    if (newPct >= 20 && newPct <= 80) setBottomHeight(newPct);
  }, []);

  const stopDrag = useCallback(() => {
    window.removeEventListener("mousemove", handleDragRef.current);
    window.removeEventListener("mouseup", stopDragRef.current);
  }, []);

  const startDrag = useCallback(() => {
    handleDragRef.current = handleDrag;
    stopDragRef.current = stopDrag;
    window.addEventListener("mousemove", handleDragRef.current);
    window.addEventListener("mouseup", stopDragRef.current);
  }, [handleDrag, stopDrag]);

  const handleFiles = useCallback(async (fileList) => {
    const newFiles = Array.from(fileList);
    setValidating(true);
    setValidationProgress([]);

    const results = await Promise.all(newFiles.map(async (f) => {
      const content = await extractTextFromFile(f);
      setValidationProgress(prev => [...prev, { name: f.name, status: "checking" }]);
      try {
        const validation = await validateInsuranceDocument(f.name, content);
        setValidationProgress(prev => prev.map(p =>
          p.name === f.name ? { ...p, status: validation.is_insurance ? "accepted" : "rejected", ...validation } : p
        ));
        return { file: f, content, size: f.size, name: f.name, validation };
      } catch {
        setValidationProgress(prev => prev.map(p =>
          p.name === f.name ? { ...p, status: "rejected", reason: "Validation failed", is_insurance: false } : p
        ));
        return { file: f, content, size: f.size, name: f.name, validation: { is_insurance: false, reason: "Validation failed", document_type: "Unknown" } };
      }
    }));

    const accepted = results.filter(r => r.validation.is_insurance);
    const rejected = results.filter(r => !r.validation.is_insurance);

    setFiles(prev => [...prev, ...accepted.map(r => r.file)]);
    setDocuments(prev => [...prev, ...accepted.map(r => ({
      name: r.name, content: r.content, size: r.size,
      documentType: r.validation.document_type,
    }))]);
    setRejectedFiles(prev => [...prev, ...rejected.map(r => ({
      name: r.name, reason: r.validation.reason, documentType: r.validation.document_type,
    }))]);
    setValidating(false);
  }, []);

  const removeFile = (i) => {
    setFiles(prev => prev.filter((_, idx) => idx !== i));
    setDocuments(prev => prev.filter((_, idx) => idx !== i));
  };

  const handleSearch = async (q = query) => {
    if (!q.trim() || documents.length === 0) return;
    setLoading(true);
    try {
      const result = await searchDocuments(q, documents);
      setHistory(prev => {
        // collapse all existing items
        const newCollapsed = {};
        prev.forEach(h => { newCollapsed[h.id] = true; });
        setCollapsedItems(newCollapsed);
        return [{
          id: Date.now(), query: q,
          result, timestamp: new Date().toLocaleTimeString()
        }, ...prev];
      });
      setQuery("");
      setClarification("");
    } catch (e) {
      setHistory(prev => [{
        id: Date.now(), query: q,
        result: { state: "unknown", confidence: 0, answer: "", reason_if_unknown: "Search failed: " + e.message },
        timestamp: new Date().toLocaleTimeString()
      }, ...prev]);
    }
    setLoading(false);
  };

  const handleClarification = async (item) => {
    const text = clarifications[item.id] || "";
    if (!text.trim()) return;
    const combined = `${item.query} — Additional context: ${text}`;
    setClarifications(prev => ({ ...prev, [item.id]: "" }));
    await handleSearch(combined);
  };

  // ── Upload Step ────────────────────────────────────────────────────────────
  if (step === "upload") {
    return (
      <div style={{
     minHeight: "100vh",
    background: "#060b14",
    color: "#ffffff", // 
    fontFamily: "'DM Mono', 'Fira Code', monospace",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
      }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@600;700;800&display=swap');
          * { box-sizing: border-box; }
          ::-webkit-scrollbar { width: 4px; }
          ::-webkit-scrollbar-thumb { background: #1e293b; }
          .drop-zone { transition: all 0.2s; }
          .drop-zone:hover { border-color: #3b82f6 !important; background: #0f172a !important; }
          .file-input-hidden { display: none; }
        `}</style>

        <div style={{ maxWidth: 560, width: "100%" }}>
          {/* Header */}
          <div style={{ marginBottom: 40 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6", boxShadow: "0 0 12px #3b82f6" }} />
              <span style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.14em", fontFamily: "'DM Mono', monospace" }}>
                DOCUMENT INTELLIGENCE — v1.0
              </span>
            </div>
            <h1 style={{
              fontSize: 36, fontFamily: "'Syne', sans-serif", fontWeight: 800,
              color: "#f8fafc", letterSpacing: "-0.02em", lineHeight: 1.1, marginBottom: 10
            }}>
              Upload your<br />
              <span style={{ color: "#3b82f6" }}>documents.</span>
            </h1>
            <p style={{ fontSize: 13, color: "#64748b", lineHeight: 1.7, fontFamily: "'DM Mono', monospace" }}>
              Accepts insurance documents & PHR records with insurance data.<br />
              Policies, claims, SBC, EOB, coverage summaries, PHR with member ID / benefits / claims history.<br />
              Supports <span style={{ color: "#f1f5f9" }}>.pdf .docx .csv .txt .md</span> — unrelated documents will be rejected.
            </p>
          </div>

          {/* Drop Zone */}
          <div
            className="drop-zone"
            style={{
              border: `2px dashed ${dragging ? "#3b82f6" : "#1e293b"}`,
              borderRadius: 12,
              padding: "40px 32px",
              textAlign: "center",
              cursor: "pointer",
              background: dragging ? "#0f172a" : "#080d17",
              marginBottom: 20,
              transition: "all 0.2s",
            }}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
          >
            <div style={{ fontSize: 32, marginBottom: 12 }}>⬆</div>
            <div style={{ fontSize: 13, color: "#f1f5f9", marginBottom: 4 }}>
              Drag & drop files here or <span style={{ color: "#3b82f6" }}>click to browse</span>
            </div>
            <div style={{ fontSize: 11, color: "#334155" }}>.pdf .docx .csv .txt .md supported</div>
            <input ref={fileInputRef} type="file" multiple accept=".pdf,.docx,.csv,.txt,.md,.json"
              className="file-input-hidden"
              onChange={(e) => handleFiles(e.target.files)} />
          </div>

          {/* Validation progress */}
          {validating && (
            <div style={{ marginBottom: 16, background: "#080d17", border: "1px solid #1e293b", borderRadius: 8, padding: "14px 16px" }}>
              <div style={{ fontSize: 10, color: "#3b82f6", letterSpacing: "0.1em", marginBottom: 10 }}>
                VALIDATING DOCUMENTS — INSURANCE CHECK
              </div>
              {validationProgress.map((p, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, fontSize: 12 }}>
                  <span style={{ fontSize: 14 }}>
                    {p.status === "checking" ? "⏳" : p.status === "accepted" ? "✅" : "❌"}
                  </span>
                  <span style={{ color: "#f1f5f9", flex: 1 }}>{p.name}</span>
                  <span style={{
                    fontSize: 10, color: p.status === "accepted" ? "#4ade80" : p.status === "rejected" ? "#f87171" : "#64748b",
                    letterSpacing: "0.06em",
                  }}>
                    {p.status === "checking" ? "CHECKING..." : p.status === "accepted" ? p.document_type?.toUpperCase() || "ACCEPTED" : "NOT INSURANCE"}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Rejected files */}
          {rejectedFiles.length > 0 && (
            <div style={{ marginBottom: 16, background: "#1c0b0b", border: "1px solid #7f1d1d", borderRadius: 8, padding: "14px 16px" }}>
              <div style={{ fontSize: 10, color: "#f87171", letterSpacing: "0.1em", marginBottom: 10 }}>
                {rejectedFiles.length} DOCUMENT{rejectedFiles.length > 1 ? "S" : ""} REJECTED — NO INSURANCE DATA FOUND
              </div>
              {rejectedFiles.map((r, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                    <span style={{ fontSize: 12 }}>❌</span>
                    <span style={{ fontSize: 12, color: "#fca5a5" }}>{r.name}</span>
                    <span style={{ fontSize: 10, color: "#7f1d1d", background: "#450a0a", padding: "1px 6px", borderRadius: 3 }}>
                      {r.documentType || "Unknown Type"}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: "#64748b", paddingLeft: 24 }}>{r.reason}</div>
                </div>
              ))}
            </div>
          )}

          {/* File list */}
          {files.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em", marginBottom: 10 }}>
                {files.length} DOCUMENT{files.length > 1 ? "S" : ""} LOADED
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {files.map((f, i) => (
                  <FileChip key={i} file={f} onRemove={() => removeFile(i)} />
                ))}
              </div>
            </div>
          )}

          {/* CTA */}
          <button
            disabled={files.length === 0 || validating}
            onClick={() => setStep("search")}
            style={{
              width: "100%", padding: "14px 24px",
              background: files.length > 0 && !validating ? "#3b82f6" : "#0f172a",
              border: `1px solid ${files.length > 0 && !validating ? "#3b82f6" : "#1e293b"}`,
              borderRadius: 8, color: files.length > 0 && !validating ? "#fff" : "#334155",
              fontSize: 13, fontWeight: 600, fontFamily: "'DM Mono', monospace",
              cursor: files.length > 0 && !validating ? "pointer" : "not-allowed",
              letterSpacing: "0.06em", transition: "all 0.2s",
              boxShadow: files.length > 0 && !validating ? "0 0 24px #3b82f630" : "none",
            }}>
            {validating ? "VALIDATING DOCUMENTS..." : files.length === 0 ? "UPLOAD INSURANCE DOCUMENTS TO CONTINUE" : `SEARCH ${files.length} INSURANCE DOCUMENT${files.length > 1 ? "S" : ""} →`}
          </button>
        </div>
      </div>
    );
  }

  // ── Search Step ───────────────────────────────────────────────────────────

  // Phase 1: Extract doctors + frequencies + patient address from PHR
  const extractDoctorsFromPHR = async (docContext) => {
    const response = await fetchWithTimeout("/api/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: `You are a medical records analyst. Extract every doctor/provider mentioned in the PHR documents, counting how many times each appears across all visits/encounters in a single year or the most recent 12 months of data available. Also extract the patient's address/location if present.

STRICT RULES:
- Only extract doctors explicitly named in the documents
- Count each distinct visit/encounter/mention as one occurrence
- Identify specialty from context clues (e.g. "cardiology follow-up" → Cardiologist)
- If no PHR data found, return empty doctors array

Return ONLY valid JSON:
{
  "has_phr": true | false,
  "insurance_provider": "e.g. Cigna, Aetna — extracted from insurance doc, or null",
  "plan_name": "e.g. CDHP HDHP OAP — or null",
  "patient_address": "Full address if found in PHR e.g. '123 Main St, Miami, FL 33101', or null",
  "patient_city": "City only if found, or null",
  "patient_state": "State abbreviation if found, or null",
  "patient_zip": "ZIP code if found, or null",
  "doctors": [
    {
      "name": "Dr. Full Name",
      "specialty": "e.g. Cardiologist, PCP, Endocrinologist",
      "visit_count": 3,
      "last_seen": "approximate date or year if available",
      "conditions_treated": ["e.g. hypertension", "diabetes"],
      "doctor_address": "Doctor's office address if mentioned in PHR, or null"
    }
  ]
}`,
        messages: [{ role: "user", content: `DOCUMENTS:\n${docContext}\n\nExtract all doctors from PHR data with visit frequency and patient location. Return JSON only.` }],
      }),
    });
    const data = await response.json();
    const raw = data.content?.[0]?.text || "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    try { return JSON.parse(clean); } catch { return { has_phr: false, doctors: [] }; }
  };

  // Get location: PHR address first, fallback to browser geolocation
  const resolveLocation = async (phrData) => {
    // Use PHR address if found
    if (phrData.patient_city && phrData.patient_state) {
      return `${phrData.patient_city}, ${phrData.patient_state}${phrData.patient_zip ? " " + phrData.patient_zip : ""}`;
    }
    if (phrData.patient_address) return phrData.patient_address;

    // Fallback: browser geolocation → reverse geocode
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve("unknown location"); return; }
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            const res = await fetch(
              `https://nominatim.openstreetmap.org/reverse?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}&format=json`
            );
            const geo = await res.json();
            const city = geo.address?.city || geo.address?.town || geo.address?.village || "";
            const state = geo.address?.state || "";
            const zip = geo.address?.postcode || "";
            resolve(`${city}, ${state} ${zip}`.trim() || "unknown location");
          } catch { resolve("unknown location"); }
        },
        () => resolve("unknown location"),
        { timeout: 5000 }
      );
    });
  };

  // Insurance provider directory registry
  const INSURANCE_DIRECTORIES = {
    cigna:   { name: "Cigna",         url: "https://sarhcpdir.cigna.com/web/public/consumer/directory/search?consumerCode=HDC014", searchParam: "providerName" },
    humana:  { name: "Humana",        url: "https://finder.humana.com/", searchParam: "name" },
    uhc:     { name: "UnitedHealthcare", url: "https://www.uhc.com/find-a-doctor", searchParam: "name" },
    bcbs:    { name: "Blue Cross Blue Shield", url: "https://provider.bcbs.com/app/public/#/one/city=&state=&postalCode=&country=&insurerCode=BCBSA_I&brandCode=BCBSANDHF&alphaPrefix=&bcbsaProductId", searchParam: "name" },
  };

  const resolveDirectory = (insuranceProvider) => {
    if (!insuranceProvider) return null;
    const lower = insuranceProvider.toLowerCase();
    if (lower.includes("cigna")) return INSURANCE_DIRECTORIES.cigna;
    if (lower.includes("humana")) return INSURANCE_DIRECTORIES.humana;
    if (lower.includes("united") || lower.includes("uhc") || lower.includes("unitedhealthcare")) return INSURANCE_DIRECTORIES.uhc;
    if (lower.includes("blue cross") || lower.includes("bcbs") || lower.includes("anthem")) return INSURANCE_DIRECTORIES.bcbs;
    return null;
  };

  // Phase 2: Verify each doctor using official directory + web search + location
  const verifyDoctorInsurance = async (doctor, insuranceProvider, planName, location) => {
    if (!doctor.name || doctor.name === "null") {
      return { ...doctor, insurance_status: "No doctor name", accepts_insurance: null, status_label: "No doctor name" };
    }

    const directory = resolveDirectory(insuranceProvider);
    const locationStr = location || "unknown location";

    // Build explicit search instructions based on which insurer
    const directoryInstructions = directory ? `
MANDATORY SEARCH STEPS — follow in this exact order:

STEP 1: Search the official ${directory.name} provider directory:
- Search query: site:${new URL(directory.url).hostname} "${doctor.name}"
- OR search: "${doctor.name}" "${insuranceProvider}" provider directory ${locationStr}

STEP 2: Search the official directory URL directly:
- URL to search: ${directory.url}
- Search for the doctor by name: "${doctor.name}" and location: "${locationStr}"

STEP 3: If steps 1-2 are inconclusive, search:
- "${doctor.name}" ${doctor.specialty} ${locationStr} accepts ${insuranceProvider} 2025
- "${doctor.name}" ${insuranceProvider} in-network ${locationStr}

OFFICIAL DIRECTORY URL FOR PATIENT REFERENCE: ${directory.url}
` : `
SEARCH STEPS:
STEP 1: Search "${doctor.name}" ${doctor.specialty} ${locationStr} accepts ${insuranceProvider} in-network 2025 2026
STEP 2: Search "${doctor.name}" ${insuranceProvider} provider directory ${locationStr}
`;

    const response = await fetchWithTimeout("/api/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: `You are verifying whether a specific doctor accepts a specific health insurance plan. You MUST use the web_search tool to find current information. Do not guess or assume — only report what you actually find in search results.

${directoryInstructions}

After searching, return ONLY valid JSON (no other text):
{
  "accepts_insurance": true | false | null,
  "confidence": "High | Medium | Low | Unknown",
  "status_label": "Accepts ${insuranceProvider} | Does not accept ${insuranceProvider} | Likely in-network | Likely out-of-network | Could not verify",
  "evidence": "Exact quote or finding from search results — what specifically did you find?",
  "source_url": "The URL where you found this information, or null",
  "directory_url": "${directory?.url || ""}",
  "recommendation": "One specific action for the patient, e.g. 'Call the office at XXX to confirm before booking' or 'Search ${directory?.name || insuranceProvider} directory at [url] to confirm'"
}`,
        messages: [{
          role: "user",
          content: `Verify insurance acceptance for:
Doctor: ${doctor.name}
Specialty: ${doctor.specialty}
Insurance: ${insuranceProvider || "unknown"} ${planName || ""}
Patient location: ${locationStr}
${doctor.doctor_address ? `Doctor office address: ${doctor.doctor_address}` : ""}

Use web_search to check the official directory and confirm if this doctor accepts this insurance. Return JSON only.`
        }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    const data = await response.json();
    const textBlock = data.content?.filter(b => b.type === "text").pop();
    const raw = textBlock?.text || "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    try {
      const result = JSON.parse(clean);
      return { ...doctor, ...result, official_directory: directory };
    } catch {
      return { ...doctor, accepts_insurance: null, confidence: "Unknown", status_label: "Could not verify", evidence: "Verification failed", official_directory: directory };
    }
  };

  // Phase 3: Generate final appointment recommendations
  const buildFinalRecommendations = async (docContext, verifiedDoctors) => {
    const doctorSummary = verifiedDoctors.map(d =>
      `- ${d.name} (${d.specialty}): seen ${d.visit_count}x, treats [${(d.conditions_treated || []).join(", ")}], insurance status: ${d.status_label || "unknown"}, confidence: ${d.confidence || "unknown"}`
    ).join("\n");

    const response = await fetchWithTimeout("/api/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        system: `You are a health benefits advisor. Generate personalized appointment recommendations for this year based on:
1. Doctor visit frequency from PHR — doctors seen most often should be prioritized for follow-up
2. Medical conditions being treated — ongoing conditions need regular monitoring
3. Insurance coverage details — what is covered, at what cost
4. Insurance verification results for each doctor

RULES:
- Rank recommendations by doctor visit frequency (most frequent = highest priority)
- Only recommend doctors explicitly found in PHR
- Use exact insurance coverage figures from the documents
- Never invent medical information

Return ONLY valid JSON:
{
  "patient_summary": "2-3 sentences about patient health history from PHR",
  "plan_summary": "2-3 sentences about insurance coverage",
  "deductible_status": "deductible info or null",
  "important_alerts": ["any urgent care gaps or alerts"],
  "recommendations": [
    {
      "appointment_type": "e.g. Primary Care Annual Visit",
      "doctor_name": "Dr. Full Name",
      "specialty": "e.g. Primary Care Physician",
      "visit_frequency": 4,
      "frequency_label": "e.g. Seen 4 times in the past year — most frequent provider",
      "conditions_treated": ["e.g. hypertension"],
      "reason": "Why you should see this doctor this year",
      "urgency": "Routine | Soon | Urgent",
      "insurance_status": "Accepts Cigna | Does not accept Cigna | Could not verify",
      "insurance_confidence": "High | Medium | Low | Unknown",
      "insurance_evidence": "What was found during verification",
      "insurance_recommendation": "Action item for patient",
      "coverage": {
        "covered": true | false,
        "cost_share": "e.g. 20% coinsurance after $2,000 deductible",
        "requires_preauth": true | false,
        "notes": "coverage notes"
      }
    }
  ]
}`,
        messages: [{ role: "user", content: `DOCUMENTS:\n${docContext}\n\nVERIFIED DOCTORS FROM PHR:\n${doctorSummary}\n\nBuild appointment recommendations ranked by visit frequency. Return JSON only.` }],
      }),
    });
    const data = await response.json();
    const raw = data.content?.[0]?.text || "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    try { return JSON.parse(clean); } catch { return { error: "Could not build recommendations." }; }
  };

  const generateRecommendations = async () => {
    setRecsLoading(true);
    setActiveTab("recommendations");
    setRecommendations({ phase: "extracting", message: "Step 1 of 3 — Extracting doctors and visit history from PHR..." });

    const docContext = documents.map((d, i) =>
      `=== DOCUMENT ${i + 1}: ${d.name} (${d.documentType || "Insurance Doc"}) ===\n${d.content}`
    ).join("\n\n");

    try {
      // Phase 1: extract doctors + frequencies + patient address
      const phrData = await extractDoctorsFromPHR(docContext);

      // Resolve location: PHR address → browser geolocation fallback
      const location = await resolveLocation(phrData);

      if (!phrData.has_phr || !phrData.doctors?.length) {
        setRecommendations({ phase: "verifying", message: "Step 2 of 3 — No PHR data found, building coverage-based recommendations..." });
        const fallback = await buildFinalRecommendations(docContext, []);
        setRecommendations({ ...fallback, has_phr: false, has_insurance: true, patient_location: location });
        setRecsLoading(false);
        return;
      }

      const sortedDoctors = [...phrData.doctors].sort((a, b) => (b.visit_count || 0) - (a.visit_count || 0));
      const directory = resolveDirectory(phrData.insurance_provider);

      setRecommendations({
        phase: "verifying",
        message: `Step 2 of 3 — Checking ${sortedDoctors.length} doctor${sortedDoctors.length > 1 ? "s" : ""} against ${phrData.insurance_provider || "your insurance"} directory${location !== "unknown location" ? ` near ${location}` : ""}...`,
        doctors_found: sortedDoctors,
        active_directory: directory,
      });

      // Phase 2: verify doctors with max 2 concurrent to prevent API overload
      const concurrentVerify = async (doctors, concurrency = 2) => {
        const results = [];
        for (let i = 0; i < doctors.length; i += concurrency) {
          const batch = doctors.slice(i, i + concurrency);
          const batchResults = await Promise.all(
            batch.map(d => verifyDoctorInsurance(d, phrData.insurance_provider, phrData.plan_name, location))
          );
          results.push(...batchResults);
          // Update UI as each batch finishes
          setRecommendations(prev => ({ ...prev, doctors_found: [...results, ...doctors.slice(i + concurrency)] }));
        }
        return results;
      };

      const verifiedDoctors = await concurrentVerify(sortedDoctors);

      setRecommendations({
        phase: "building",
        message: "Step 3 of 3 — Building personalized recommendations...",
        doctors_found: verifiedDoctors,
        active_directory: directory,
      });

      // Phase 3: build final recommendations
      const final = await buildFinalRecommendations(docContext, verifiedDoctors);
      setRecommendations({
        ...final,
        has_phr: true,
        has_insurance: true,
        patient_location: location,
        active_directory: directory,
        insurance_provider: phrData.insurance_provider,
      });

    } catch (e) {
      setRecommendations({ error: "Analysis failed: " + e.message });
    }
    setRecsLoading(false);
  };

  const urgencyColor = (u) => u === "Urgent" ? "#f87171" : u === "Soon" ? "#fb923c" : "#4ade80";

  return (
    <div style={{
       height: "100vh",
      background: "#060b14",
      color: "#ffffff", // ✅ Option 1 global bright text
      overflow: "hidden",
      fontFamily: "'DM Mono', 'Fira Code', monospace",
      display: "grid",
      gridTemplateColumns: sidebarOpen ? "240px 1fr" : "0px 1fr",
      transition: "grid-template-columns 0.25s ease",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@600;700;800&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }
        mark { background: #1d4ed840; color: #93c5fd; border-radius: 2px; padding: 0 2px; }
        .search-input:focus { border-color: #3b82f6 !important; outline: none; box-shadow: 0 0 0 2px #3b82f620; }
        .result-card { animation: slideIn 0.3s ease; }
        @keyframes slideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .add-doc-btn:hover { border-color: #3b82f6 !important; color: #3b82f6 !important; }
        .tab-btn { transition: all 0.15s; }
        .tab-btn:hover { background: #0f172a !important; }
        .rec-card { animation: slideIn 0.3s ease; }
        .drag-handle:hover { background: #3b82f6 !important; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>

      {/* ── Sidebar ── */}
      <div style={{
        borderRight: "1px solid #0d1520", padding: sidebarOpen ? "20px 16px" : "0",
        display: "flex", flexDirection: "column", gap: 16,
        overflowY: sidebarOpen ? "auto" : "hidden",
        overflowX: "hidden",
        height: "100vh",
        width: sidebarOpen ? "240px" : "0px",
        transition: "width 0.25s ease, padding 0.25s ease",
        flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.12em", marginBottom: 3 }}>DOCUMENT INTELLIGENCE</div>
          <div style={{ fontSize: 13, fontFamily: "'Syne', sans-serif", fontWeight: 700, color: "#f8fafc" }}>DocSearch</div>
        </div>

        <div>
          <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em", marginBottom: 8 }}>
            LOADED ({documents.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {documents.map((d, i) => (
              <div key={i} style={{
                background: "#080d17", border: "1px solid #0f172a",
                borderRadius: 6, padding: "7px 9px",
              }}>
                <div style={{ fontSize: 10, color: "#f1f5f9", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {d.name}
                </div>
                <div style={{ fontSize: 9, color: "#3b82f6" }}>{d.documentType || "Insurance Doc"}</div>
              </div>
            ))}
          </div>
        </div>

        <button className="add-doc-btn" onClick={() => setStep("upload")} style={{
          background: "none", border: "1px solid #1e293b", borderRadius: 6,
          padding: "7px 10px", color: "#475569", fontSize: 10,
          cursor: "pointer", fontFamily: "'DM Mono', monospace",
          letterSpacing: "0.06em", transition: "all 0.2s", textAlign: "left",
        }}>+ ADD DOCUMENTS</button>

        {/* Recommendations trigger */}
        <button onClick={generateRecommendations} disabled={recsLoading} style={{
          background: recsLoading ? "#0f172a" : "linear-gradient(135deg, #1d4ed8, #0ea5e9)",
          border: "none", borderRadius: 6, padding: "9px 10px",
          color: "#fff", fontSize: 10, cursor: recsLoading ? "not-allowed" : "pointer",
          fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em",
          boxShadow: recsLoading ? "none" : "0 0 16px #1d4ed840",
        }}>
          {recsLoading ? "⏳ ANALYZING..." : "✦ GET RECOMMENDATIONS"}
        </button>

        {history.length > 0 && (
          <div>
            <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em", marginBottom: 8 }}>
              HISTORY ({history.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {history.slice(0, 8).map(h => (
                <div key={h.id} style={{
                  fontSize: 10, color: "#e2e8f0", cursor: "pointer",
                  padding: "3px 5px", borderRadius: 4,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }} onClick={() => setQuery(h.query)} title={h.query}>
                  <span style={{
                    display: "inline-block", width: 5, height: 5, borderRadius: "50%",
                    background: h.result.state === "found" ? "#4ade80" : h.result.state === "partial" ? "#fb923c" : "#f87171",
                    marginRight: 5, verticalAlign: "middle",
                  }} />
                  {h.query}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Main panel ── */}
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", position: "relative" }}>

        {/* Collapse toggle button */}
        <button
          onClick={() => setSidebarOpen(prev => !prev)}
          title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          style={{
            position: "absolute", top: 16, left: 12, zIndex: 10,
            width: 26, height: 26, borderRadius: 6,
            background: "#0f172a", border: "1px solid #1e293b",
            color: "#64748b", cursor: "pointer", fontSize: 20,
            display: "flex", alignItems: "center", justifyContent: "center",
            transition: "all 0.15s", fontFamily: "monospace",
            lineHeight: 1,
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = "#3b82f6"; e.currentTarget.style.color = "#3b82f6"; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = "#1e293b"; e.currentTarget.style.color = "#64748b"; }}
        >
          {sidebarOpen ? "←" : "→"}
        </button>

        {/* ── TOP: Results area ── */}
        <div ref={resultsRef} style={{
          height: `${100 - bottomHeight}%`, overflowY: "auto",
          padding: "20px 28px", display: "flex", flexDirection: "column", gap: 16,
        }}>
          {/* Tabs */}
          <div style={{ display: "flex", gap: 6, borderBottom: "1px solid #0f172a", paddingBottom: 12, paddingLeft: 44, flexShrink: 0 }}>
            {["search", "recommendations"].map(tab => (
              <button key={tab} className="tab-btn" onClick={() => setActiveTab(tab)} style={{
                background: activeTab === tab ? "#0f172a" : "none",
                border: `1px solid ${activeTab === tab ? "#1e293b" : "transparent"}`,
                borderRadius: 6, padding: "5px 12px", color: activeTab === tab ? "#e2e8f0" : "#475569",
                fontSize: 10, cursor: "pointer", fontFamily: "'DM Mono', monospace",
                letterSpacing: "0.06em", textTransform: "uppercase",
              }}>
                {tab === "recommendations" && recommendations && !recsLoading
                  ? `✦ ${tab} (${recommendations.recommendations?.length || 0})`
                  : tab === "recommendations" && recsLoading ? "⏳ Analyzing..." : tab}
              </button>
            ))}
          </div>

          {/* ── SEARCH RESULTS TAB ── */}
          {activeTab === "search" && (
            <>
              {history.length === 0 && !loading && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {/* Explanation banner */}
                  <div style={{
                    background: "linear-gradient(135deg, #0a1628, #0d1f35)",
                    border: "1px solid #1e3a5f", borderRadius: 10, padding: "20px 24px",
                  }}>
                    <div style={{ fontSize: 11, color: "#3b82f6", letterSpacing: "0.1em", marginBottom: 8 }}>WHAT THIS TOOL DOES</div>
                    <div style={{ fontSize: 13, color: "#f1f5f9", lineHeight: 1.8, marginBottom: 12 }}>
                      This document search helps you identify <strong style={{ color: "#7dd3fc" }}>which doctors and medical services are covered</strong> under your insurance plan. Upload your insurance documents and PHR records to:
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      {[
                        { icon: "🩺", text: "Find out if your existing doctors are in-network" },
                        { icon: "📋", text: "Check what procedures and specialists are covered" },
                        { icon: "💊", text: "Look up prescription drug coverage and costs" },
                        { icon: "✦", text: "Get AI recommendations based on your PHR history" },
                      ].map((item, i) => (
                        <div key={i} style={{
                          display: "flex", gap: 10, alignItems: "flex-start",
                          background: "#060b14", borderRadius: 6, padding: "10px 12px",
                          border: "1px solid #1e293b",
                        }}>
                          <span style={{ fontSize: 16, flexShrink: 0 }}>{item.icon}</span>
                          <span style={{ fontSize: 11, color: "#e2e8f0", lineHeight: 1.6 }}>{item.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Uploaded documents summary */}
                  <div>
                    <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em", marginBottom: 10 }}>
                      LOADED DOCUMENTS — {documents.length} READY TO SEARCH
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
                      {documents.map((d, i) => (
                        <div key={i} style={{
                          background: "#080d17", border: "1px solid #1e293b",
                          borderRadius: 8, padding: "12px 14px",
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                            <span style={{ fontSize: 16 }}>
                              {d.name.endsWith(".pdf") ? "📄" : d.name.endsWith(".docx") ? "📝" : d.name.endsWith(".csv") ? "📊" : "🗒️"}
                            </span>
                            <div style={{ overflow: "hidden" }}>
                              <div style={{ fontSize: 11, color: "#f1f5f9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {d.name}
                              </div>
                              <div style={{ fontSize: 9, color: "#3b82f6", marginTop: 1 }}>{d.documentType || "Insurance Doc"}</div>
                            </div>
                          </div>
                          <div style={{ fontSize: 10, color: "#64748b" }}>
                            {d.content.length.toLocaleString()} characters extracted
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ textAlign: "center", padding: "16px 0" }}>
                    <div style={{ fontSize: 11, color: "#475569" }}>
                      Type a question below ↓ or click <span style={{ color: "#3b82f6" }}>✦ GET RECOMMENDATIONS</span> in the sidebar
                    </div>
                  </div>
                </div>
              )}
              {history.map((item, idx) => {
                const { result } = item;
                const isFound = result.state === "found";
                const isPartial = result.state === "partial";
                const isUnknown = result.state === "unknown";
                const lowConfidence = result.confidence > 0 && result.confidence < 0.7;
                const borderColor = isFound ? "#1d4ed860" : isPartial ? "#92400e60" : "#7f1d1d60";
                const accentColor = isFound ? "#3b82f6" : isPartial ? "#fb923c" : "#f87171";
                const stateLabel = isFound ? "FOUND" : isPartial ? "PARTIAL" : "UNKNOWN";
                const isNewest = idx === 0;
                const isCollapsed = collapsedItems[item.id] ?? false;

                return (
                  <div key={item.id} className="result-card" style={{
                    background: "#080d17", border: `1px solid ${borderColor}`,
                    borderRadius: 10, overflow: "hidden", flexShrink: 0,
                    opacity: isCollapsed ? 0.7 : 1,
                    transition: "opacity 0.2s",
                  }}>
                    {/* Header — always visible */}
                    <div style={{
                      padding: "10px 16px", borderBottom: isCollapsed ? "none" : `1px solid ${borderColor}`,
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      background: `${accentColor}08`,
                      cursor: "pointer",
                    }} onClick={() => toggleCollapse(item.id)}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                        {/* Collapse toggle */}
                        <div style={{
                          width: 20, height: 20, borderRadius: 4, flexShrink: 0,
                          background: "#0f172a", border: "1px solid #1e293b",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 9, color: "#64748b", fontFamily: "monospace",
                          transition: "all 0.15s",
                        }}>
                          {isCollapsed ? "→" : "←"}
                        </div>
                        <span style={{
                          fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
                          padding: "2px 7px", borderRadius: 4, flexShrink: 0,
                          background: `${accentColor}20`, color: accentColor,
                          border: `1px solid ${accentColor}40`,
                        }}>{stateLabel}</span>
                        <span style={{
                          fontSize: 11, color: isCollapsed ? "#64748b" : "#e2e8f0",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          transition: "color 0.2s",
                        }}>"{item.query}"</span>
                        {isNewest && !isCollapsed && (
                          <span style={{ fontSize: 8, color: "#3b82f6", letterSpacing: "0.08em", flexShrink: 0 }}>LATEST</span>
                        )}
                      </div>
                      <span style={{ fontSize: 9, color: "#334155", flexShrink: 0, marginLeft: 8 }}>{item.timestamp}</span>
                    </div>

                    {/* Body — only shown when expanded */}
                    {!isCollapsed && (
                      <div style={{ padding: "16px" }}>
                        {result.confidence > 0 && (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em", marginBottom: 5 }}>CONFIDENCE</div>
                            <ConfidenceMeter score={result.confidence} />
                          </div>
                        )}
                        {lowConfidence && (
                          <div style={{ background: "#431407", border: "1px solid #9a3412", borderRadius: 6, padding: "8px 12px", marginBottom: 12, fontSize: 11, color: "#fb923c", lineHeight: 1.6 }}>
                            ⚠ Confidence below 70% — verify before relying on this result.
                          </div>
                        )}
                        {(isFound || isPartial) && result.answer && (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em", marginBottom: 6 }}>
                              {isFound ? "ANSWER FROM DOCUMENTS" : "PARTIAL MATCH"}
                            </div>
                            <div style={{ background: "#0a1628", border: "1px solid #1e293b", borderRadius: 6, padding: "12px 14px", fontSize: 12, color: "#cbd5e1", lineHeight: 1.8 }}
                              dangerouslySetInnerHTML={{ __html: highlightKeywords(result.answer, item.query) }} />
                          </div>
                        )}
                        {result.sources?.length > 0 && (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em", marginBottom: 6 }}>SOURCES</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                              {result.sources.map((s, i) => (
                                <div key={i} style={{ background: "#0d1f35", border: "1px solid #1e3a5f", borderRadius: 6, padding: "7px 11px", fontSize: 11, color: "#7dd3fc", lineHeight: 1.6 }}
                                  dangerouslySetInnerHTML={{ __html: highlightKeywords(s, item.query) }} />
                              ))}
                            </div>
                          </div>
                        )}
                        {result.keywords_matched?.length > 0 && (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em", marginBottom: 5 }}>KEYWORDS MATCHED</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                              {result.keywords_matched.map((k, i) => (
                                <span key={i} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "#1d4ed820", color: "#93c5fd", border: "1px solid #1d4ed840" }}>{k}</span>
                              ))}
                            </div>
                          </div>
                        )}
                        {isUnknown && (
                          <div>
                            <div style={{ background: "#1c0b0b", border: "1px solid #7f1d1d", borderRadius: 8, padding: "14px", marginBottom: 12 }}>
                              <div style={{ fontSize: 11, color: "#fca5a5", marginBottom: 5, fontWeight: 600 }}>✕ Not found in documents</div>
                              {result.reason_if_unknown && <div style={{ fontSize: 11, color: "#f1f5f9", lineHeight: 1.6 }}>{result.reason_if_unknown}</div>}
                              {result.needs_more_info && <div style={{ fontSize: 11, color: "#64748b", marginTop: 6, lineHeight: 1.6 }}><span style={{ color: "#f87171" }}>To help: </span>{result.needs_more_info}</div>}
                            </div>
                            <div style={{ display: "flex", gap: 8 }}>
                              <input type="text" placeholder="Add context and retry..."
                                value={clarifications[item.id] || ""}
                                onChange={e => setClarifications(prev => ({ ...prev, [item.id]: e.target.value }))}
                                onKeyDown={e => e.key === "Enter" && handleClarification(item)}
                                style={{ flex: 1, background: "#080d17", border: "1px solid #1e293b", borderRadius: 6, padding: "9px 12px", color: "#e2e8f0", fontSize: 11, fontFamily: "'DM Mono', monospace" }} />
                              <button
                                onClick={() => handleClarification(item)}
                                disabled={!(clarifications[item.id] || "").trim() || loading}
                                style={{
                                  padding: "9px 16px",
                                  background: (clarifications[item.id] || "").trim() ? "linear-gradient(135deg, #1d4ed8, #3b82f6)" : "#1c1917",
                                  border: "none", borderRadius: 6,
                                  color: "#fff", fontSize: 10,
                                  cursor: (clarifications[item.id] || "").trim() && !loading ? "pointer" : "not-allowed",
                                  fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em",
                                  transition: "all 0.2s",
                                  boxShadow: (clarifications[item.id] || "").trim() ? "0 0 12px #1d4ed840" : "none",
                                }}>
                                RETRY →
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {/* ── RECOMMENDATIONS TAB ── */}
          {activeTab === "recommendations" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

              {/* ── LOADING: 3-phase progress ── */}
              {recsLoading && recommendations?.phase && (
                <div style={{ background: "#080d17", border: "1px solid #1e293b", borderRadius: 10, padding: "24px 28px" }}>
                  <div style={{ fontSize: 10, color: "#3b82f6", letterSpacing: "0.12em", marginBottom: 20 }}>ANALYSIS IN PROGRESS</div>

                  {/* Step indicators */}
                  {[
                    { key: "extracting", label: "Extract doctors & visit frequency from PHR" },
                    { key: "verifying",  label: "Verify each doctor accepts your insurance (web search)" },
                    { key: "building",   label: "Build ranked appointment recommendations" },
                  ].map((step, idx) => {
                    const phases = ["extracting", "verifying", "building"];
                    const currentIdx = phases.indexOf(recommendations.phase);
                    const done = idx < currentIdx;
                    const active = idx === currentIdx;
                    return (
                      <div key={step.key} style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
                        <div style={{
                          width: 22, height: 22, borderRadius: "50%", flexShrink: 0, marginTop: 1,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          background: done ? "#0c2010" : active ? "#0a1628" : "#0a0f1a",
                          border: `1px solid ${done ? "#166534" : active ? "#1d4ed8" : "#1e293b"}`,
                          fontSize: 10,
                          animation: active ? "pulse 1.5s infinite" : "none",
                        }}>
                          {done ? <span style={{ color: "#4ade80" }}>✓</span> : active ? <span style={{ color: "#3b82f6" }}>◌</span> : <span style={{ color: "#334155" }}>{idx + 1}</span>}
                        </div>
                        <div>
                          <div style={{ fontSize: 11, color: done ? "#4ade80" : active ? "#e2e8f0" : "#475569", marginBottom: 3 }}>
                            {step.label}
                          </div>
                          {active && (
                            <div style={{ fontSize: 10, color: "#475569", lineHeight: 1.6 }}>{recommendations.message}</div>
                          )}
                          {/* Show found doctors during verify phase */}
                          {active && recommendations.doctors_found?.length > 0 && (
                            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                              {recommendations.active_directory && (
                                <div style={{ fontSize: 9, color: "#3b82f6", marginBottom: 4 }}>
                                  📂 Checking: {recommendations.active_directory.name} Directory
                                </div>
                              )}
                              {recommendations.doctors_found.map((d, di) => (
                                <div key={di} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10 }}>
                                  <span style={{ color: "#334155" }}>#{di + 1}</span>
                                  <span style={{ color: "#7dd3fc" }}>{d.name}</span>
                                  <span style={{ color: "#475569" }}>·</span>
                                  <span style={{ color: "#64748b" }}>{d.specialty}</span>
                                  <span style={{ color: "#475569" }}>·</span>
                                  <span style={{ color: "#fb923c" }}>{d.visit_count}x visits</span>
                                  {d.status_label && <span style={{
                                    fontSize: 9, padding: "1px 6px", borderRadius: 3,
                                    background: d.accepts_insurance === true ? "#0c2010" : d.accepts_insurance === false ? "#1c0b0b" : "#1c1400",
                                    color: d.accepts_insurance === true ? "#4ade80" : d.accepts_insurance === false ? "#f87171" : "#fb923c",
                                    border: `1px solid ${d.accepts_insurance === true ? "#166534" : d.accepts_insurance === false ? "#7f1d1d" : "#78350f"}`,
                                  }}>{d.status_label}</span>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── ERROR ── */}
              {recommendations?.error && (
                <div style={{ background: "#1c0b0b", border: "1px solid #7f1d1d", borderRadius: 8, padding: "16px", fontSize: 12, color: "#fca5a5" }}>
                  {recommendations.error}
                </div>
              )}

              {/* ── EMPTY ── */}
              {!recommendations && !recsLoading && (
                <div style={{ textAlign: "center", marginTop: 60 }}>
                  <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.15 }}>✦</div>
                  <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.8 }}>
                    Click <span style={{ color: "#3b82f6" }}>✦ GET RECOMMENDATIONS</span> in the sidebar.<br />
                    We'll scan your PHR for doctors, rank them by visit frequency,<br />
                    then verify each one still accepts your insurance.
                  </div>
                </div>
              )}

              {/* ── RESULTS ── */}
              {recommendations && !recsLoading && !recommendations.error && !recommendations.phase && (
                <>
                  {/* Status banners */}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 140, background: recommendations.has_phr ? "#0c2010" : "#1c0b0b", border: `1px solid ${recommendations.has_phr ? "#166534" : "#7f1d1d"}`, borderRadius: 6, padding: "8px 12px", fontSize: 10, color: recommendations.has_phr ? "#4ade80" : "#f87171" }}>
                      {recommendations.has_phr ? "✓ PHR DATA FOUND" : "✕ NO PHR DATA"}
                    </div>
                    <div style={{ flex: 1, minWidth: 140, background: recommendations.has_insurance ? "#0a1628" : "#1c0b0b", border: `1px solid ${recommendations.has_insurance ? "#1e3a5f" : "#7f1d1d"}`, borderRadius: 6, padding: "8px 12px", fontSize: 10, color: recommendations.has_insurance ? "#7dd3fc" : "#f87171" }}>
                      {recommendations.has_insurance ? "✓ INSURANCE DATA FOUND" : "✕ NO INSURANCE DATA"}
                    </div>
                    {recommendations.patient_location && (
                      <div style={{ flex: 1, minWidth: 140, background: "#0a0f1a", border: "1px solid #1e293b", borderRadius: 6, padding: "8px 12px", fontSize: 10, color: "#94a3b8" }}>
                        📍 {recommendations.patient_location}
                      </div>
                    )}
                  </div>

                  {/* Official directory banner */}
                  {recommendations.active_directory && (
                    <div style={{ background: "#0a1020", border: "1px solid #1e3a5f", borderRadius: 8, padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 9, color: "#3b82f6", letterSpacing: "0.1em", marginBottom: 4 }}>OFFICIAL PROVIDER DIRECTORY USED</div>
                        <div style={{ fontSize: 11, color: "#e2e8f0" }}>{recommendations.active_directory.name} Provider Directory</div>
                        <div style={{ fontSize: 9, color: "#475569", marginTop: 2, wordBreak: "break-all" }}>{recommendations.active_directory.url.slice(0, 60)}…</div>
                      </div>
                      <a href={recommendations.active_directory.url} target="_blank" rel="noreferrer"
                        style={{ flexShrink: 0, padding: "8px 14px", background: "linear-gradient(135deg,#1d4ed8,#3b82f6)", borderRadius: 6, color: "#fff", fontSize: 10, textDecoration: "none", fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>
                        OPEN DIRECTORY ↗
                      </a>
                    </div>
                  )}

                  {/* Patient summary */}
                  {recommendations.patient_summary && (
                    <div style={{ background: "#080d17", border: "1px solid #1e293b", borderRadius: 8, padding: "14px 16px" }}>
                      <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em", marginBottom: 6 }}>PATIENT CONTEXT</div>
                      <div style={{ fontSize: 12, color: "#f1f5f9", lineHeight: 1.8 }}>{recommendations.patient_summary}</div>
                    </div>
                  )}

                  {/* Plan summary */}
                  {recommendations.plan_summary && (
                    <div style={{ background: "#080d17", border: "1px solid #1e3a5f", borderRadius: 8, padding: "14px 16px" }}>
                      <div style={{ fontSize: 9, color: "#3b82f6", letterSpacing: "0.1em", marginBottom: 6 }}>INSURANCE PLAN</div>
                      <div style={{ fontSize: 12, color: "#f1f5f9", lineHeight: 1.8 }}>{recommendations.plan_summary}</div>
                      {recommendations.deductible_status && (
                        <div style={{ marginTop: 8, fontSize: 11, color: "#e2e8f0" }}>
                          <span style={{ color: "#64748b" }}>Deductible: </span>{recommendations.deductible_status}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Alerts */}
                  {recommendations.important_alerts?.length > 0 && (
                    <div style={{ background: "#1c0f02", border: "1px solid #78350f", borderRadius: 8, padding: "12px 14px" }}>
                      <div style={{ fontSize: 9, color: "#fb923c", letterSpacing: "0.1em", marginBottom: 8 }}>⚠ IMPORTANT ALERTS</div>
                      {recommendations.important_alerts.map((a, i) => (
                        <div key={i} style={{ fontSize: 11, color: "#fed7aa", lineHeight: 1.7, marginBottom: 4 }}>• {a}</div>
                      ))}
                    </div>
                  )}

                  {/* Cards header */}
                  <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em", marginTop: 4 }}>
                    RECOMMENDED DOCTORS THIS YEAR — RANKED BY VISIT FREQUENCY ({recommendations.recommendations?.length || 0})
                  </div>

                  {recommendations.recommendations?.map((rec, i) => {
                    const ins = rec.insurance_status || "";
                    const insAccepted = ins.toLowerCase().includes("accept") && !ins.toLowerCase().includes("not");
                    const insRejected = ins.toLowerCase().includes("does not") || ins.toLowerCase().includes("not accept");
                    const insColor = insAccepted ? "#4ade80" : insRejected ? "#f87171" : "#fb923c";
                    const insBg = insAccepted ? "#0c2010" : insRejected ? "#1c0b0b" : "#1c1400";
                    const insBorder = insAccepted ? "#166534" : insRejected ? "#7f1d1d" : "#78350f";
                    const insIcon = insAccepted ? "✓" : insRejected ? "✕" : "?";

                    return (
                      <div key={i} className="rec-card" style={{
                        background: "#080d17", border: "1px solid #1e293b",
                        borderRadius: 10, overflow: "hidden",
                      }}>
                        {/* Header row */}
                        <div style={{
                          padding: "12px 16px", borderBottom: "1px solid #0f172a",
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          background: "#0a1020",
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            {/* Rank badge */}
                            <div style={{
                              width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
                              background: i === 0 ? "#1c1400" : i === 1 ? "#0f172a" : "#0a0f1a",
                              border: `1px solid ${i === 0 ? "#78350f" : i === 1 ? "#334155" : "#1e293b"}`,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 10, fontWeight: 700,
                              color: i === 0 ? "#fb923c" : i === 1 ? "#94a3b8" : "#475569",
                            }}>#{i + 1}</div>
                            <div>
                              <div style={{ fontSize: 13, color: "#f1f5f9", fontFamily: "'Syne', sans-serif", fontWeight: 700 }}>
                                {rec.doctor_name || rec.appointment_type}
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                                <span style={{ fontSize: 10, color: "#7dd3fc" }}>{rec.specialty || rec.doctor_type}</span>
                                {rec.visit_frequency > 0 && (
                                  <>
                                    <span style={{ color: "#334155" }}>·</span>
                                    <span style={{ fontSize: 10, color: "#fb923c" }}>
                                      {rec.visit_frequency}x visits this year
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                          <span style={{
                            fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
                            padding: "3px 8px", borderRadius: 4,
                            background: `${urgencyColor(rec.urgency)}20`,
                            color: urgencyColor(rec.urgency),
                            border: `1px solid ${urgencyColor(rec.urgency)}40`,
                          }}>{rec.urgency?.toUpperCase()}</span>
                        </div>

                        {/* Frequency bar */}
                        {rec.frequency_label && (
                          <div style={{ padding: "8px 16px", background: "#060b14", borderBottom: "1px solid #0f172a", fontSize: 10, color: "#64748b" }}>
                            📊 {rec.frequency_label}
                          </div>
                        )}

                        {/* Body — 3 columns */}
                        <div style={{ padding: "14px 16px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>

                          {/* Col 1: Why */}
                          <div>
                            <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em", marginBottom: 6 }}>WHY SEE THEM</div>
                            <div style={{ fontSize: 11, color: "#e2e8f0", lineHeight: 1.7 }}>{rec.reason}</div>
                            {rec.conditions_treated?.length > 0 && (
                              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>
                                {rec.conditions_treated.map((c, ci) => (
                                  <span key={ci} style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "#0f172a", color: "#94a3b8", border: "1px solid #1e293b" }}>{c}</span>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Col 2: Insurance acceptance */}
                          <div style={{ background: insBg, border: `1px solid ${insBorder}`, borderRadius: 8, padding: "10px 12px" }}>
                            <div style={{ fontSize: 9, color: insColor, letterSpacing: "0.1em", marginBottom: 6 }}>
                              {insIcon} ACCEPTS YOUR INSURANCE
                            </div>
                            <div style={{ fontSize: 11, color: "#e2e8f0", fontWeight: 600, marginBottom: 4 }}>
                              {rec.insurance_status || "Could not verify"}
                            </div>
                            <div style={{ fontSize: 9, color: "#64748b", marginBottom: 4 }}>
                              Confidence: <span style={{ color: insColor }}>{rec.insurance_confidence || "Unknown"}</span>
                            </div>
                            {rec.insurance_evidence && (
                              <div style={{ fontSize: 9, color: "#64748b", lineHeight: 1.5, marginBottom: 4 }}>
                                {rec.insurance_evidence}
                              </div>
                            )}
                            {rec.insurance_recommendation && (
                              <div style={{ fontSize: 9, color: "#fb923c", lineHeight: 1.5, marginTop: 4, paddingTop: 4, borderTop: `1px solid ${insBorder}` }}>
                                💡 {rec.insurance_recommendation}
                              </div>
                            )}
                            {/* Manual verify button */}
                            {(rec.official_directory || recommendations.active_directory) && (
                              <a
                                href={(rec.official_directory || recommendations.active_directory).url}
                                target="_blank" rel="noreferrer"
                                style={{
                                  display: "block", marginTop: 8, padding: "5px 0", textAlign: "center",
                                  background: "#060b14", border: "1px solid #1e3a5f", borderRadius: 5,
                                  color: "#7dd3fc", fontSize: 9, textDecoration: "none",
                                  fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em",
                                }}>
                                VERIFY IN DIRECTORY ↗
                              </a>
                            )}
                          </div>

                          {/* Col 3: Coverage cost */}
                          <div style={{
                            background: rec.coverage?.covered ? "#0a1628" : "#1c0b0b",
                            border: `1px solid ${rec.coverage?.covered ? "#1e3a5f" : "#7f1d1d"}`,
                            borderRadius: 8, padding: "10px 12px",
                          }}>
                            <div style={{ fontSize: 9, color: rec.coverage?.covered ? "#3b82f6" : "#f87171", letterSpacing: "0.1em", marginBottom: 6 }}>
                              {rec.coverage?.covered ? "✓ COVERED BY PLAN" : "✕ NOT COVERED"}
                            </div>
                            {rec.coverage?.cost_share && (
                              <div style={{ fontSize: 12, color: "#e2e8f0", fontWeight: 700, marginBottom: 4 }}>{rec.coverage.cost_share}</div>
                            )}
                            {rec.coverage?.requires_preauth && (
                              <div style={{ fontSize: 9, color: "#fb923c", marginBottom: 4 }}>⚠ Pre-auth required</div>
                            )}
                            {rec.coverage?.notes && (
                              <div style={{ fontSize: 9, color: "#94a3b8", lineHeight: 1.5 }}>{rec.coverage.notes}</div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </div>

        {/* ── DRAG HANDLE ── */}
        <div
          ref={dragRef}
          className="drag-handle"
          onMouseDown={startDrag}
          style={{
            height: 4, background: "#0f172a", cursor: "row-resize",
            transition: "background 0.2s", flexShrink: 0,
          }}
        />

        {/* ── BOTTOM: Search panel ── */}
        <div style={{
          height: `${bottomHeight}%`, background: "#080d17",
          borderTop: "1px solid #0f172a", display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}>
          {/* Hint text */}
          <div style={{ padding: "10px 24px 0", flexShrink: 0 }}>
            <div style={{ fontSize: 10, color: "#3b82f6", letterSpacing: "0.06em", lineHeight: 1.6 }}>
              💡 This document search helps you identify which doctors and medical services are covered under your insurance plan — and whether your existing providers are still in-network.
            </div>
          </div>

          {/* Textarea */}
          <div style={{ padding: "10px 24px 0", flexShrink: 0 }}>
            <div style={{ position: "relative" }}>
              <textarea
                className="search-input"
                value={query}
                onChange={e => {
                  const words = e.target.value.trim().split(/\s+/).filter(Boolean);
                  if (words.length <= 300) setQuery(e.target.value);
                }}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSearch();
                  }
                }}
                placeholder="Ask anything about your coverage, doctors, or benefits...&#10;e.g. 'Is Dr. Smith covered under my plan?' or 'What specialist visits are covered?'&#10;Press Enter to search · Shift+Enter for new line · Up to 300 words"
                rows={4}
                style={{
                  width: "100%", background: "#060b14", border: "1px solid #1e293b",
                  borderRadius: 8, padding: "12px 14px 28px 14px", color: "#f1f5f9",
                  fontSize: 12, fontFamily: "'DM Mono', monospace",
                  transition: "border-color 0.2s, box-shadow 0.2s",
                  resize: "vertical", minHeight: 90, maxHeight: 200,
                  lineHeight: 1.7,
                }}
              />
              <div style={{
                position: "absolute", bottom: 8, right: 10,
                fontSize: 9, color: (() => {
                  const w = query.trim().split(/\s+/).filter(Boolean).length;
                  return w > 270 ? "#f87171" : w > 200 ? "#fb923c" : "#475569";
                })(),
                letterSpacing: "0.06em", pointerEvents: "none",
              }}>
                {query.trim().split(/\s+/).filter(Boolean).length} / 300
              </div>
            </div>
          </div>

          {/* Search button row — BELOW textarea */}
          <div style={{ padding: "8px 24px 8px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
            <button
              onClick={() => handleSearch()}
              disabled={loading || !query.trim()}
              style={{
                padding: "10px 24px",
                background: loading ? "#0f172a" : "linear-gradient(135deg, #1d4ed8, #3b82f6)",
                border: "none", borderRadius: 8, color: "#fff",
                fontSize: 11, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer",
                fontFamily: "'DM Mono', monospace", letterSpacing: "0.08em",
                transition: "all 0.2s",
                boxShadow: loading ? "none" : "0 0 16px #1d4ed840",
              }}>
              {loading ? "⏳ SEARCHING..." : "SEARCH →"}
            </button>
            {loading && (
              <div style={{ fontSize: 10, color: "#f1f5f9", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ animation: "pulse 1s infinite" }}>◌</span>
                Scanning {documents.length} document{documents.length > 1 ? "s" : ""}...
              </div>
            )}
          </div>

          {/* Quick suggestion pills */}
          <div style={{ padding: "4px 24px 10px", display: "flex", gap: 6, flexWrap: "wrap", overflowY: "auto", flex: 1 }}>
            <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em", width: "100%", marginBottom: 4 }}>
              QUICK SEARCHES
            </div>
            {[
              "What is my deductible?",
              "Is my doctor covered?",
              "Do I need pre-authorization?",
              "What is my out-of-pocket maximum?",
              "What specialists are covered?",
              "What is my co-insurance rate?",
              "Are prescription drugs covered?",
              "What mental health services are covered?",
            ].map((s, i) => (
              <button key={i} onClick={() => { setQuery(s); setActiveTab("search"); }}
                style={{
                  background: "#0a0f1a", border: "1px solid #1e293b", borderRadius: 20,
                  padding: "5px 12px", color: "#f1f5f9", fontSize: 10, cursor: "pointer",
                  fontFamily: "'DM Mono', monospace", transition: "all 0.15s",
                }}
                onMouseEnter={e => { e.target.style.borderColor = "#3b82f6"; e.target.style.color = "#e2e8f0"; }}
                onMouseLeave={e => { e.target.style.borderColor = "#1e293b"; e.target.style.color = "#94a3b8"; }}>
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}


