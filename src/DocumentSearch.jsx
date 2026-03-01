import { useState, useRef, useCallback } from "react";
import * as mammoth from "mammoth";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      resolve(window.pdfjsLib);
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
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
    console.warn("PDF.js failed, trying text fallback:", e);
  }

  // Fallback: try reading as raw text (works for text-based PDFs)
  try {
    const text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
    // Extract readable ASCII text from raw PDF bytes
    const readable = text.replace(/[^\x20-\x7E\n\r\t]/g, " ")
      .replace(/\s+/g, " ")
      .split(" ")
      .filter(w => w.length > 2 && /[a-zA-Z]/.test(w))
      .join(" ");
    if (readable.length > 100) return readable;
  } catch (e) {
    console.warn("Text fallback failed:", e);
  }

  // Last resort: return filename as context so validator can use it
  return `[PDF document: ${file.name}. Content extraction unavailable — validate based on filename and document name only.]`;
}

async function extractFromDOCX(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value.trim();
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
  const preview = content.slice(0, 3000);
  const contentFailed = content.includes("Content extraction unavailable");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 200,
      system: `You are a document classifier determining if a file is insurance-related or a PHR (Personal Health Record) containing insurance data.

IMPORTANT RULES:
1. The filename is a STRONG signal — names like "cigna", "aetna", "bluecross", "humana", "united", "anthem", "kaiser", "insurance", "coverage", "benefits", "policy", "claim", "deductible", "premium", "copay", "SBC", "EOB", "terms", "plan", "PHR", "health record" strongly indicate an acceptable document.
2. If PDF text extraction failed or content is very short, rely heavily on the filename.
3. ACCEPTED document types include:
   - Pure insurance documents: health plans, dental plans, vision plans, life insurance, property insurance, liability insurance, workers comp, policies, claims, SBC (Summary of Benefits and Coverage), EOB (Explanation of Benefits), coverage summaries, certificates of insurance, endorsements, riders, declarations pages, premium schedules, underwriting docs, loss runs, reinsurance docs, compliance filings, glossaries of insurance terms.
   - PHR (Personal Health Records) that contain ANY insurance-related data such as: insurance provider name, policy number, member ID, coverage details, benefits information, claims history, EOBs, deductibles, copays, or premium information.
4. REJECT only documents that have NO insurance content whatsoever — e.g. a pure medical chart with only clinical notes and no insurance fields, a recipe, a resume, etc.
5. When in doubt and the filename or content suggests insurance or health records — approve it.

Return ONLY valid JSON: { "is_insurance": true | false, "reason": "one sentence explanation", "document_type": "specific type e.g. Health Insurance SBC / PHR with Insurance Data / Policy Glossary / Claim Form / Not Insurance Related" }`,
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
7. Hide any PII data with data masking — e.g. replace member IDs, policy numbers, names with [REDACTED]

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

  const response = await fetch("https://api.anthropic.com/v1/messages", {
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
    <span style={{ color: "#94a3b8", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
  const [step, setStep] = useState("upload"); // upload | search
  const [documents, setDocuments] = useState([]);
  const [files, setFiles] = useState([]);
  const [rejectedFiles, setRejectedFiles] = useState([]);
  const [validating, setValidating] = useState(false);
  const [validationProgress, setValidationProgress] = useState([]);
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [clarification, setClarification] = useState("");
  const fileInputRef = useRef();

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
      setHistory(prev => [{
        id: Date.now(), query: q,
        result, timestamp: new Date().toLocaleTimeString()
      }, ...prev]);
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
    if (!clarification.trim()) return;
    const combined = `${item.query} — Additional context: ${clarification}`;
    await handleSearch(combined);
  };

  // ── Upload Step ────────────────────────────────────────────────────────────
  if (step === "upload") {
    return (
      <div style={{
        minHeight: "100vh", background: "#060b14",
        fontFamily: "'DM Mono', 'Fira Code', monospace",
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", padding: 32,
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
              <span style={{ fontSize: 10, color: "#475569", letterSpacing: "0.14em", fontFamily: "'DM Mono', monospace" }}>
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
              Supports <span style={{ color: "#94a3b8" }}>.pdf .docx .csv .txt .md</span> — unrelated documents will be rejected.
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
            <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 4 }}>
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
                  <span style={{ color: "#94a3b8", flex: 1 }}>{p.name}</span>
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
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: "0.1em", marginBottom: 10 }}>
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
  return (
    <div style={{
      minHeight: "100vh", background: "#060b14",
      fontFamily: "'DM Mono', 'Fira Code', monospace",
      display: "grid", gridTemplateColumns: "260px 1fr",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@600;700;800&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }
        mark { background: #1d4ed840; color: #93c5fd; border-radius: 2px; padding: 0 2px; }
        .search-input:focus { border-color: #3b82f6 !important; outline: none; }
        .result-card { animation: slideIn 0.3s ease; }
        @keyframes slideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
        .add-doc-btn:hover { border-color: #3b82f6 !important; color: #3b82f6 !important; }
      `}</style>

      {/* Sidebar */}
      <div style={{ borderRight: "1px solid #0f172a", padding: "24px 20px", display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.12em", marginBottom: 4 }}>DOCUMENT INTELLIGENCE</div>
          <div style={{ fontSize: 14, fontFamily: "'Syne', sans-serif", fontWeight: 700, color: "#f8fafc" }}>DocSearch</div>
        </div>

        <div>
          <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.1em", marginBottom: 10 }}>
            LOADED DOCUMENTS ({documents.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {documents.map((d, i) => (
              <div key={i} style={{
                background: "#080d17", border: "1px solid #0f172a",
                borderRadius: 6, padding: "8px 10px",
              }}>
                <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {d.name}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: 10, color: "#3b82f6" }}>
                    {d.documentType || "Insurance Doc"}
                  </div>
                  <div style={{ fontSize: 10, color: "#334155" }}>
                    {d.content.length.toLocaleString()} chars
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <button
          className="add-doc-btn"
          onClick={() => setStep("upload")}
          style={{
            background: "none", border: "1px solid #1e293b", borderRadius: 6,
            padding: "8px 12px", color: "#475569", fontSize: 11,
            cursor: "pointer", fontFamily: "'DM Mono', monospace",
            letterSpacing: "0.06em", transition: "all 0.2s", textAlign: "left",
          }}>
          + ADD DOCUMENTS
        </button>

        {history.length > 0 && (
          <div>
            <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.1em", marginBottom: 10 }}>
              SEARCH HISTORY ({history.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {history.slice(0, 8).map(h => (
                <div key={h.id} style={{
                  fontSize: 10, color: "#475569", cursor: "pointer",
                  padding: "4px 6px", borderRadius: 4,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
                  onClick={() => setQuery(h.query)}
                  title={h.query}>
                  <span style={{
                    display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                    background: h.result.state === "found" ? "#4ade80" : h.result.state === "partial" ? "#fb923c" : "#f87171",
                    marginRight: 6, verticalAlign: "middle",
                  }} />
                  {h.query}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Main */}
      <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>

        {/* Search bar */}
        <div style={{ padding: "24px 32px", borderBottom: "1px solid #0f172a" }}>
          <div style={{ display: "flex", gap: 10 }}>
            <input
              className="search-input"
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSearch()}
              placeholder="Ask anything — search is limited to your uploaded documents only..."
              style={{
                flex: 1, background: "#080d17", border: "1px solid #1e293b",
                borderRadius: 8, padding: "12px 16px", color: "#e2e8f0",
                fontSize: 13, fontFamily: "'DM Mono', monospace",
                transition: "border-color 0.2s",
              }}
            />
            <button
              onClick={() => handleSearch()}
              disabled={loading || !query.trim()}
              style={{
                padding: "12px 20px", background: loading ? "#0f172a" : "#3b82f6",
                border: "none", borderRadius: 8, color: "#fff",
                fontSize: 12, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer",
                fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em",
                minWidth: 80, transition: "all 0.2s",
              }}>
              {loading ? "..." : "SEARCH"}
            </button>
          </div>
          {loading && (
            <div style={{ fontSize: 11, color: "#475569", marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>◌</span>
              Scanning {documents.length} document{documents.length > 1 ? "s" : ""} — keyword and contextual match...
            </div>
          )}
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 32px", display: "flex", flexDirection: "column", gap: 20 }}>

          {history.length === 0 && !loading && (
            <div style={{ textAlign: "center", marginTop: 80 }}>
              <div style={{ fontSize: 32, marginBottom: 16, opacity: 0.3 }}>⌕</div>
              <div style={{ fontSize: 13, color: "#334155" }}>
                Search will only return results found in your documents.<br />
                If nothing is found, you will be asked to provide more context.
              </div>
            </div>
          )}

          {history.map((item) => {
            const { result } = item;
            const isFound = result.state === "found";
            const isPartial = result.state === "partial";
            const isUnknown = result.state === "unknown";
            const lowConfidence = result.confidence > 0 && result.confidence < 0.7;

            const borderColor = isFound ? "#1d4ed860" : isPartial ? "#92400e60" : "#7f1d1d60";
            const accentColor = isFound ? "#3b82f6" : isPartial ? "#fb923c" : "#f87171";
            const stateLabel = isFound ? "FOUND" : isPartial ? "PARTIAL MATCH" : "UNKNOWN";

            return (
              <div key={item.id} className="result-card" style={{
                background: "#080d17", border: `1px solid ${borderColor}`,
                borderRadius: 10, overflow: "hidden",
              }}>
                {/* Result header */}
                <div style={{
                  padding: "14px 20px", borderBottom: `1px solid ${borderColor}`,
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  background: `${accentColor}08`,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
                      padding: "3px 8px", borderRadius: 4,
                      background: `${accentColor}20`, color: accentColor,
                      border: `1px solid ${accentColor}40`,
                    }}>{stateLabel}</span>
                    <span style={{ fontSize: 12, color: "#475569" }}>
                      "{item.query}"
                    </span>
                  </div>
                  <span style={{ fontSize: 10, color: "#334155" }}>{item.timestamp}</span>
                </div>

                <div style={{ padding: "20px 20px" }}>

                  {/* Confidence */}
                  {result.confidence > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.1em", marginBottom: 6 }}>
                        CONFIDENCE SCORE
                      </div>
                      <ConfidenceMeter score={result.confidence} />
                    </div>
                  )}

                  {/* Low confidence warning */}
                  {lowConfidence && (
                    <div style={{
                      background: "#431407", border: "1px solid #9a3412",
                      borderRadius: 6, padding: "10px 14px", marginBottom: 14,
                      fontSize: 12, color: "#fb923c", lineHeight: 1.6,
                    }}>
                      ⚠ Confidence below 70% — the information found may not directly answer your query. Verify before relying on this result.
                    </div>
                  )}

                  {/* Answer */}
                  {(isFound || isPartial) && result.answer && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.1em", marginBottom: 8 }}>
                        {isFound ? "ANSWER FROM DOCUMENTS" : "PARTIAL INFORMATION FOUND"}
                      </div>
                      <div style={{
                        background: "#0a1628", border: "1px solid #1e293b",
                        borderRadius: 6, padding: "14px 16px",
                        fontSize: 13, color: "#cbd5e1", lineHeight: 1.8,
                      }}
                        dangerouslySetInnerHTML={{ __html: highlightKeywords(result.answer, item.query) }}
                      />
                    </div>
                  )}

                  {/* Sources */}
                  {result.sources?.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.1em", marginBottom: 8 }}>
                        SOURCES
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {result.sources.map((s, i) => (
                          <div key={i} style={{
                            background: "#0d1f35", border: "1px solid #1e3a5f",
                            borderRadius: 6, padding: "8px 12px",
                            fontSize: 11, color: "#7dd3fc", lineHeight: 1.6,
                          }}
                            dangerouslySetInnerHTML={{ __html: highlightKeywords(s, item.query) }}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Keywords matched */}
                  {result.keywords_matched?.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.1em", marginBottom: 6 }}>
                        KEYWORDS MATCHED
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {result.keywords_matched.map((k, i) => (
                          <span key={i} style={{
                            fontSize: 11, padding: "2px 8px", borderRadius: 4,
                            background: "#1d4ed820", color: "#93c5fd",
                            border: "1px solid #1d4ed840",
                          }}>{k}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Unknown state */}
                  {isUnknown && (
                    <div>
                      <div style={{
                        background: "#1c0b0b", border: "1px solid #7f1d1d",
                        borderRadius: 8, padding: "16px", marginBottom: 16,
                      }}>
                        <div style={{ fontSize: 12, color: "#fca5a5", marginBottom: 6, fontWeight: 600 }}>
                          ✕ Information not found in your documents
                        </div>
                        {result.reason_if_unknown && (
                          <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.6 }}>
                            {result.reason_if_unknown}
                          </div>
                        )}
                        {result.needs_more_info && (
                          <div style={{ fontSize: 12, color: "#64748b", marginTop: 8, lineHeight: 1.6 }}>
                            <span style={{ color: "#f87171" }}>To help answer this: </span>
                            {result.needs_more_info}
                          </div>
                        )}
                      </div>

                      {/* Clarification input */}
                      <div>
                        <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.1em", marginBottom: 8 }}>
                          PROVIDE MORE CONTEXT TO RETRY
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <input
                            type="text"
                            placeholder="Add more context or clarify your query..."
                            value={clarification}
                            onChange={e => setClarification(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && handleClarification(item)}
                            style={{
                              flex: 1, background: "#080d17", border: "1px solid #1e293b",
                              borderRadius: 6, padding: "10px 14px", color: "#e2e8f0",
                              fontSize: 12, fontFamily: "'DM Mono', monospace",
                            }}
                          />
                          <button
                            onClick={() => handleClarification(item)}
                            disabled={!clarification.trim() || loading}
                            style={{
                              padding: "10px 16px", background: "#1c1917",
                              border: "1px solid #44403c", borderRadius: 6,
                              color: "#d6d3d1", fontSize: 11, cursor: "pointer",
                              fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em",
                            }}>
                            RETRY
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
