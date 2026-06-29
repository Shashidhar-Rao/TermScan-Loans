require('dotenv').config();
const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory session store: sessionId -> { agreementText, analysis }
const sessions = new Map();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Scoring system prompt ────────────────────────────────────────────────────

const ANALYSIS_SYSTEM = `You are an expert Indian home loan agreement analyzer with deep knowledge of RBI guidelines, NHB (National Housing Bank) regulations, SARFAESI Act, RERA, and borrower rights in India.

Analyze the provided home loan agreement text using this 5-dimension scoring framework:

Dimensions (each rated 1–5):
- A: Financial Impact      [Weight 30%] 1=very costly to borrower, 5=saves/protects borrower money
- B: Negotiability         [Weight 20%] 1=non-negotiable boilerplate, 5=fully negotiable or waivable
- C: Disclosure Prominence [Weight 20%] 1=buried in fine print, 5=prominently disclosed / in KFS
- D: Borrower Control      [Weight 20%] 1=lender has unilateral power, 5=borrower has full control
- E: Legal Recourse        [Weight 10%] 1=no practical remedy, 5=clear accessible legal remedy

Clause score (out of 10) = (A×0.30 + B×0.20 + C×0.20 + D×0.20 + E×0.10) × 2
Overall score (out of 100) = average of all clause scores × 10, clamped to 0–100.

Identify and score ALL of the following clause types you find in the document. If a clause is not present in the agreement, still include it with found_in_doc: false and note it as a potential gap.

Clause categories to look for:
1. INTEREST RATE: floating rate basis (EBLR/RLLR/MCLR), reset clause, rate spread, benchmark reference
2. PAYMENT PLAN: Pre-EMI vs Full EMI, tranche disbursement, EMI start date, payment application order (fees → interest → principal)
3. CHARGES: processing fee, MOD/MODT, CERSAI, legal/valuation fee, insurance bundling, bounce charges, conversion fee, statement fees
4. PREPAYMENT: prepayment charges (fixed rate), waiver for floating rate, lock-in period, part-payment conditions
5. DEFAULT: definition of default (including expanded triggers like litigation/NRI status/divorce), acceleration/recall clause, penal interest, SARFAESI triggers
6. RESTRICTIONS: negative covenants (sell/rent/modify without permission), assignment to third party, security cover top-up demand, property insurance mandate
7. CO-APPLICANT: joint liability, CIBIL impact, property rights gap, tax benefit conditions
8. REGULATORY PROTECTIONS: KFS mandate, LTV ratio cap, 30-day document return, RBI prepayment ban on floating rate

Return ONLY valid JSON with no markdown, no explanation, just the JSON object:
{
  "overall_score": <0-100, integer>,
  "grade": "<A+ / A / B+ / B / C+ / C / D / F>",
  "overall_verdict": "<one sentence plain-English verdict on how borrower-friendly this agreement is>",
  "lender_name": "<name of lender if found, else null>",
  "loan_amount": "<loan amount if found, else null>",
  "interest_rate": "<interest rate if found, else null>",
  "tenure": "<loan tenure if found, else null>",
  "clauses": [
    {
      "name": "<clause name>",
      "category": "<category from list above>",
      "found_in_doc": <true/false>,
      "actual_text": "<direct quote from document, max 80 chars, or null if not found>",
      "scores": { "A": <1-5>, "B": <1-5>, "C": <1-5>, "D": <1-5>, "E": <1-5> },
      "clause_score": <0.0-10.0>,
      "readability": "<Easy|Medium|Hard>",
      "plain_english": "<1-2 sentences explaining what this means for the borrower in simple language>",
      "risk_flag": <true/false>,
      "risk_reason": "<why this is risky for the borrower, or null>"
    }
  ],
  "top_risks": [
    {
      "title": "<short risk title>",
      "severity": "<High|Medium|Low>",
      "explanation": "<plain English explanation of the risk in 2-3 sentences>",
      "quote": "<relevant quote from agreement or null>",
      "action": "<what the borrower can do about this>"
    }
  ],
  "missing_protections": [
    "<description of any RBI-mandated protection clause that is absent from this agreement>"
  ],
  "positive_aspects": [
    "<borrower-friendly aspect found in the agreement>"
  ],
  "category_scores": {
    "Interest Rate": <0-10>,
    "Payment Plan": <0-10>,
    "Charges": <0-10>,
    "Prepayment": <0-10>,
    "Default": <0-10>,
    "Restrictions": <0-10>,
    "Co-applicant": <0-10>,
    "Regulatory Protections": <0-10>
  },
  "summary_for_voice": "<A 180-word plain English summary of this specific agreement suitable for reading aloud to a first-time borrower. Include: lender, rate, tenure, biggest risks, and top 2 things to watch out for. Use simple conversational language.>"
}`;

// ─── JSON truncation repair ───────────────────────────────────────────────────
// If Claude's output is cut off mid-JSON, close any open arrays/objects so
// JSON.parse can at least recover the data that arrived.
function repairTruncatedJson(raw) {
  let s = raw;
  // Remove trailing incomplete key-value (e.g. , "key": <cut>)
  s = s.replace(/,\s*"[^"]*"\s*:\s*[^,}\]]*$/, '');
  // Remove trailing comma
  s = s.replace(/,\s*$/, '');
  // Close open structures in reverse order
  const stack = [];
  for (const ch of s) {
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  s += stack.reverse().join('');
  try {
    return JSON.parse(s);
  } catch {
    throw new Error('Agreement analysis returned incomplete JSON. Try uploading a shorter document.');
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post('/api/analyze', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

    let text;
    try {
      const pdfData = await pdfParse(req.file.buffer);
      text = pdfData.text;
    } catch {
      return res.status(400).json({ error: 'Could not read PDF. Ensure it is a text-based PDF (not a scanned image).' });
    }

    if (text.trim().length < 100) {
      return res.status(400).json({ error: 'PDF appears to be a scanned image. Please use a text-based PDF.' });
    }

    // Cap input to keep output tokens manageable
    const truncated = text.slice(0, 40000);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: ANALYSIS_SYSTEM,
      messages: [{ role: 'user', content: `Analyze this home loan agreement and return JSON:\n\n${truncated}` }]
    });

    const raw = response.content[0].text;

    // Extract JSON block from response
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Model did not return valid JSON');

    // Attempt parse; if truncated, try to repair by closing open structures
    let analysis;
    try {
      analysis = JSON.parse(match[0]);
    } catch {
      analysis = repairTruncatedJson(match[0]);
    }

    // Store session for follow-up chat
    const sessionId = uuidv4();
    sessions.set(sessionId, {
      agreementText: truncated.slice(0, 15000), // keep top 15k for chat context
      analysis,
      createdAt: Date.now()
    });

    // Clean old sessions (older than 2 hours)
    for (const [id, session] of sessions) {
      if (Date.now() - session.createdAt > 7200000) sessions.delete(id);
    }

    res.json({ sessionId, analysis });

  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, question, history } = req.body;
    if (!question) return res.status(400).json({ error: 'No question provided' });

    const session = sessions.get(sessionId);
    const context = session
      ? `Agreement excerpt:\n${session.agreementText}\n\nOverall score: ${session.analysis.overall_score}/100. Top risks: ${session.analysis.top_risks?.map(r => r.title).join(', ')}.`
      : 'No agreement loaded — answer based on general Indian home loan knowledge.';

    const messages = [
      ...(history || []).slice(-6), // keep last 6 turns for context
      { role: 'user', content: question }
    ];

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: `You are a plain-English home loan advisor helping an Indian borrower understand their loan agreement.
${context}
Rules: Answer in 2-4 sentences maximum. Be specific to the agreement where possible. Flag risks clearly. No jargon. If asked about a clause that wasn't found in the agreement, say so.`,
      messages
    });

    res.json({ answer: response.content[0].text });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message || 'Chat failed' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✓ Loan Analyzer running → http://localhost:${PORT}\n`);
});
