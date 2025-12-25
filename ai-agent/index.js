import fs from "fs";
import axios from "axios";
import { Octokit } from "@octokit/rest";
import path from "path";
import { fileURLToPath } from "url";

/* ---------------------------------
   ESM __dirname replacement
---------------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ---------------------------------
   ENV variables
---------------------------------- */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // ✅ CHANGED
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;     // owner/repo
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

const octokit = new Octokit({ auth: GITHUB_TOKEN });

/* ---------------------------------
   Constants
---------------------------------- */
const MAX_FIXES = 3;          // Fix only N valid issues per run
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 4000;

/* ---------------------------------
   Logs
---------------------------------- */
console.log("🚀 AI Agent started...");
console.log("OPENAI KEY AVAILABLE:", !!OPENAI_API_KEY);
console.log("OPENAI MODEL:", OPENAI_MODEL);
console.log("GITHUB TOKEN AVAILABLE:", !!GITHUB_TOKEN);

/* ---------------------------------
   Sonar issues path
---------------------------------- */
const sonarIssuesPath = path.join(__dirname, "sonar-issues.json");
console.log("Reading sonar issues from:", sonarIssuesPath);

/* ---------------------------------
   Fetch file from GitHub
---------------------------------- */
async function fetchFileFromGitHub(filePath) {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_REPO.split("/")[0],
      repo: GITHUB_REPO.split("/")[1],
      path: filePath,
      ref: GITHUB_BRANCH,
    });

    return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    console.log("❌ Failed to fetch file:", filePath);
    return null;
  }
}

/* ---------------------------------
   Call OpenAI with retry handling
---------------------------------- */
async function callOpenAI(prompt) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: OPENAI_MODEL,
          messages: [
            { role: "system", content: "You are a code-fixing AI agent." },
            { role: "user", content: prompt }
          ],
          temperature: 0.2,
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      return response.data.choices[0].message.content;
    } catch (err) {
      if (err.response?.status === 429) {
        console.warn(`⚠️ Rate limited. Retrying in ${attempt * 4}s...`);
        await new Promise(r => setTimeout(r, BASE_DELAY_MS * attempt));
      } else {
        console.error("❌ OpenAI error:", err.message);
        return null;
      }
    }
  }

  console.warn("⚠️ OpenAI retries exhausted. Skipping issue.");
  return null;
}

/* ---------------------------------
   Save updated file
---------------------------------- */
function saveFixedFile(filePath, content) {
  const fullPath = path.join(__dirname, "..", filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
  console.log("✔ Updated:", filePath);
}

/* ---------------------------------
   MAIN
---------------------------------- */
async function main() {
  if (!fs.existsSync(sonarIssuesPath)) {
    console.error("❌ sonar-issues.json not found");
    return;
  }

  const sonarData = JSON.parse(fs.readFileSync(sonarIssuesPath, "utf8"));
  const issues = sonarData.issues || [];

  console.log("Total Sonar Issues Found:", issues.length);
  console.log(`Fixing first ${MAX_FIXES} valid issues`);

  let fixedCount = 0;

  for (const issue of issues) {
    if (fixedCount >= MAX_FIXES) break;

    const filePath = issue.component.split(":").pop();
    const issueMsg = issue.message.toLowerCase();

    /* -------------------------------
       SAFETY FILTERS
    -------------------------------- */

    if (filePath.startsWith("ai-agent/")) {
      console.log("⛔ Skipping AI agent file:", filePath);
      continue;
    }

    if (filePath.endsWith(".spec.ts")) {
      console.log("⚠️ Skipping test file:", filePath);
      continue;
    }

    if (filePath.endsWith(".html") || filePath.endsWith(".css")) {
      console.log("⚠️ Skipping non-code file:", filePath);
      continue;
    }

    if (
      issueMsg.includes("replaceall") ||
      issueMsg.includes("accessibility") ||
      issueMsg.includes("empty source") ||
      issueMsg.includes("separator role")
    ) {
      console.log("⚠️ Skipping cosmetic issue:", issue.message);
      continue;
    }

    console.log("\n=============================");
    console.log("Processing:", filePath);
    console.log("Issue:", issue.message);

    const originalCode = await fetchFileFromGitHub(filePath);
    if (!originalCode) continue;

    const prompt = `
Fix ONLY the SonarCloud issue below.

--- ISSUE ---
${issue.message}

--- FILE PATH ---
${filePath}

--- CODE ---
${originalCode}

Rules:
- Return FULL updated file only
- No markdown
- No explanations
`;

    const fixedCode = await callOpenAI(prompt);
    if (!fixedCode) continue;

    saveFixedFile(filePath, fixedCode.replace(/```+/g, "").trim());
    fixedCount++;

    // Small delay to avoid burst limits
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`✅ Fixed ${fixedCount} issue(s)`);
}

main().catch(err => console.error("❌ AI Agent crashed:", err));
