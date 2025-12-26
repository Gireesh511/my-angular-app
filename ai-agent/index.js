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
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;     // owner/repo
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

const octokit = new Octokit({ auth: GITHUB_TOKEN });

/* ---------------------------------
   Constants
---------------------------------- */
const MAX_FILES = 3;          // Fix max N files per run
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 4000;

/* ---------------------------------
   Logs
---------------------------------- */
console.log("🚀 AI Agent started...");
console.log("OPENAI MODEL:", OPENAI_MODEL);

/* ---------------------------------
   Sonar issues path
---------------------------------- */
const sonarIssuesPath = path.join(__dirname, "sonar-issues.json");

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
    console.log("❌ Failed to fetch:", filePath);
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
            { role: "system", content: "You are a senior code-fixing AI." },
            { role: "user", content: prompt }
          ],
          temperature: 0.2
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
        console.warn(`⚠️ Rate limited. Retrying in ${attempt * 4}s`);
        await new Promise(r => setTimeout(r, BASE_DELAY_MS * attempt));
      } else {
        console.error("❌ OpenAI error:", err.message);
        return null;
      }
    }
  }
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
  const sonarData = JSON.parse(fs.readFileSync(sonarIssuesPath, "utf8"));
  const issues = sonarData.issues || [];

  console.log("Total Sonar Issues:", issues.length);

  /* ---------------------------------
     GROUP ISSUES BY FILE
  ---------------------------------- */
  const issuesByFile = {};

  for (const issue of issues) {
    const filePath = issue.component.split(":").pop();
    const msg = issue.message.toLowerCase();

    // Safety filters
    if (
      filePath.startsWith("ai-agent/") ||
      filePath.endsWith(".spec.ts") ||
      filePath.endsWith(".html") ||
      filePath.endsWith(".css") ||
      msg.includes("replaceall") ||
      msg.includes("accessibility") ||
      msg.includes("empty source") ||
      msg.includes("separator role") ||
      msg.includes("top-level await")
    ) {
      continue;
    }

    if (!issuesByFile[filePath]) {
      issuesByFile[filePath] = [];
    }

    issuesByFile[filePath].push(issue.message);
  }

  const files = Object.keys(issuesByFile).slice(0, MAX_FILES);
  console.log("Files to fix:", files);

  for (const filePath of files) {
    console.log("\n=============================");
    console.log("Processing file:", filePath);
    console.log("Issues:", issuesByFile[filePath]);

    const originalCode = await fetchFileFromGitHub(filePath);
    if (!originalCode) continue;

    const prompt = `
Fix ALL SonarCloud issues listed below in ONE pass.

--- ISSUES ---
${issuesByFile[filePath].map((i, idx) => `${idx + 1}. ${i}`).join("\n")}

--- FILE PATH ---
${filePath}

--- ORIGINAL CODE ---
${originalCode}

Rules:
- Fix ALL issues
- Return FULL updated file
- No markdown
- No explanations
`;

    const fixedCode = await callOpenAI(prompt);
    if (!fixedCode) continue;

    saveFixedFile(filePath, fixedCode.replace(/```+/g, "").trim());

    // Small delay to avoid burst
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log("✅ Multi-issue per file fix completed");
}

main().catch(err => console.error("❌ Agent failed:", err));
