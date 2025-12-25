import fs from "fs";
import path from "path";
import axios from "axios";
import { Octokit } from "@octokit/rest";
import { fileURLToPath } from "url";

// ------------------------------
// ESM dirname replacement
// ------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------------
// ENV VARIABLES
// ------------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;      // "owner/repo"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

// ------------------------------
// CONSTANTS
// ------------------------------
const MAX_ISSUES_TO_FIX = 3;     // ⛔ Prevents OpenAI rate-limit explosion
const MAX_RETRIES = 4;
const RETRY_DELAY_MS = 5000;

// ------------------------------
// CLIENTS
// ------------------------------
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ------------------------------
// STARTUP LOGS
// ------------------------------
console.log("🚀 AI Agent started...");
console.log("OPENAI KEY AVAILABLE:", !!OPENAI_API_KEY);
console.log("GITHUB TOKEN AVAILABLE:", !!GITHUB_TOKEN);

// ------------------------------
// SONAR FILE PATH
// ------------------------------
const sonarIssuesPath = path.join(__dirname, "sonar-issues.json");
console.log("Reading sonar issues from:", sonarIssuesPath);

// ------------------------------
// FETCH FILE FROM GITHUB
// ------------------------------
async function fetchFileFromGitHub(filePath) {
  try {
    const [owner, repo] = GITHUB_REPO.split("/");

    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: GITHUB_BRANCH,
    });

    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (err) {
    console.error("❌ Failed to fetch file:", filePath, err.message);
    return null;
  }
}

// ------------------------------
// OPENAI CALL WITH RETRY
// ------------------------------
async function callOpenAIWithRetry(prompt) {
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4.1",
          messages: [
            { role: "system", content: "You are a senior software engineer fixing SonarCloud issues." },
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
        attempt++;
        const wait = RETRY_DELAY_MS * attempt;
        console.warn(`⚠️ Rate limited. Retrying in ${wait / 1000}s...`);
        await new Promise(res => setTimeout(res, wait));
      } else {
        throw err;
      }
    }
  }

  throw new Error("❌ OpenAI retries exhausted");
}

// ------------------------------
// SAVE FIXED FILE
// ------------------------------
function saveFixedFile(filePath, content) {
  const targetPath = path.join(__dirname, "..", filePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
  console.log("✔ Updated:", filePath);
}

// ------------------------------
// MAIN EXECUTION
// ------------------------------
async function main() {
  if (!fs.existsSync(sonarIssuesPath)) {
    console.error("❌ sonar-issues.json not found");
    process.exit(1);
  }

  const sonarData = JSON.parse(fs.readFileSync(sonarIssuesPath, "utf8"));
  const issues = sonarData.issues || [];

  if (issues.length === 0) {
    console.log("🎉 No Sonar issues found.");
    return;
  }

  console.log("Total Sonar Issues Found:", issues.length);
  console.log(`Fixing first ${MAX_ISSUES_TO_FIX} issues`);

  let fixedCount = 0;

  for (const issue of issues) {
    if (fixedCount >= MAX_ISSUES_TO_FIX) break;

    const filePath = issue.component.split(":").pop();
    const issueMsg = issue.message;
    const rule = issue.rule || "";

    // ------------------------------
    // SKIP RULES (VERY IMPORTANT)
    // ------------------------------
    if (filePath.startsWith("ai-agent/")) {
      console.log("⛔ Skipping AI agent file:", filePath);
      continue;
    }

    if (filePath.endsWith(".spec.ts")) {
      console.log("⚠️ Skipping test file:", filePath);
      continue;
    }

    if (
      issueMsg.includes("replaceAll") ||
      rule.startsWith("typescript:S")
    ) {
      console.log("⚠️ Skipping cosmetic rule:", issueMsg);
      continue;
    }

    console.log("\n=============================");
    console.log("Processing:", filePath);
    console.log("Issue:", issueMsg);

    const originalCode = await fetchFileFromGitHub(filePath);
    if (!originalCode) continue;

    const prompt = `
Fix ONLY the SonarCloud issue below.

--- ISSUE ---
${issueMsg}

--- FILE PATH ---
${filePath}

--- ORIGINAL CODE ---
${originalCode}

Rules:
- Return FULL updated file
- No explanations
- No markdown
`;

    const fixedCode = (await callOpenAIWithRetry(prompt))
      .replace(/```+/g, "")
      .trim();

    saveFixedFile(filePath, fixedCode);
    fixedCount++;
  }

  console.log(`✅ Fixed ${fixedCount} file(s).`);
}

// ------------------------------
// RUN
// ------------------------------
main().catch(err => {
  console.error("❌ AI Agent failed:", err.message);
  process.exit(1);
});
