import fs from "fs";
import axios from "axios";
import { Octokit } from "@octokit/rest";
import path from "path";
import { fileURLToPath } from "url";

// --------------------
// ESM dirname fix
// --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------
// ENV VARIABLES
// --------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;     // owner/repo
const GITHUB_BRANCH = process.env.GITHUB_BRANCH; // main

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// --------------------
// CONFIG (TUNE SAFELY)
// --------------------
const MAX_ISSUES = 3;          // prevent rate-limit (increase slowly)
const DELAY_BETWEEN_CALLS = 6000; // 6 seconds
const OPENAI_RETRIES = 5;

// --------------------
// LOG START
// --------------------
console.log("🚀 AI Agent started...");
console.log("OPENAI KEY AVAILABLE:", !!OPENAI_API_KEY);
console.log("GITHUB TOKEN AVAILABLE:", !!GITHUB_TOKEN);

// --------------------
// SONAR FILE PATH
// --------------------
const sonarIssuesPath = path.join(__dirname, "sonar-issues.json");
console.log("Reading sonar issues from:", sonarIssuesPath);

// --------------------
// FETCH FILE FROM GITHUB
// --------------------
async function fetchFileFromGitHub(filePath) {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_REPO.split("/")[0],
      repo: GITHUB_REPO.split("/")[1],
      path: filePath,
      ref: GITHUB_BRANCH,
    });

    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (err) {
    console.log("❌ Failed fetching:", filePath, err.message);
    return null;
  }
}

// --------------------
// OPENAI WITH RETRY
// --------------------
async function callOpenAIWithRetry(payload, retries = OPENAI_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        payload,
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );
      return response.data.choices[0].message.content;
    } catch (err) {
      if (err.response?.status === 429 && attempt < retries) {
        const wait = attempt * 5000;
        console.log(`⚠️ Rate limited. Retrying in ${wait / 1000}s...`);
        await new Promise(res => setTimeout(res, wait));
      } else {
        throw err;
      }
    }
  }
}

// --------------------
// BUILD PROMPT + CALL
// --------------------
async function callOpenAI(filePath, sonarIssue, originalCode) {
  const prompt = `
You are a senior software engineer.
Fix ONLY the SonarCloud issue described below.

--- SONAR ISSUE ---
${sonarIssue}

--- FILE PATH ---
${filePath}

--- ORIGINAL CODE ---
${originalCode}

Rules:
- Return the FULL UPDATED FILE content only.
- No explanations.
- No markdown.
- Keep formatting as close as possible.
`;

  const payload = {
    model: "gpt-4.1",
    messages: [
      { role: "system", content: "You are a code-fixing agent." },
      { role: "user", content: prompt }
    ],
    temperature: 0.2
  };

  return callOpenAIWithRetry(payload);
}

// --------------------
// SAVE FIXED FILE
// --------------------
async function saveFixedFile(filePath, updatedContent) {
  const projectFilePath = path.join(__dirname, "..", filePath);

  fs.mkdirSync(path.dirname(projectFilePath), { recursive: true });
  fs.writeFileSync(projectFilePath, updatedContent, "utf8");

  console.log("✔ Updated:", projectFilePath);
}

// --------------------
// MAIN
// --------------------
async function main() {
  if (!fs.existsSync(sonarIssuesPath)) {
    console.log("❌ sonar-issues.json not found");
    return;
  }

  const sonarData = JSON.parse(fs.readFileSync(sonarIssuesPath, "utf8"));
  const issues = sonarData.issues || [];

  if (issues.length === 0) {
    console.log("🎉 No Sonar issues found.");
    return;
  }

  console.log(`Total Sonar Issues Found: ${issues.length}`);
  console.log(`Fixing first ${Math.min(MAX_ISSUES, issues.length)} issues`);

  for (const issue of issues.slice(0, MAX_ISSUES)) {
    const filePath = issue.component.split(":").pop();

    // 🔕 Skip test files (recommended)
    if (filePath.endsWith(".spec.ts")) {
      console.log("⚠️ Skipping test file:", filePath);
      continue;
    }

    console.log("\n=============================");
    console.log("Processing:", filePath);
    console.log("Issue:", issue.message);

    const originalCode = await fetchFileFromGitHub(filePath);
    if (!originalCode) continue;

    let fixedCode = await callOpenAI(filePath, issue.message, originalCode);
    fixedCode = fixedCode.replace(/```+/g, "").trim();

    await saveFixedFile(filePath, fixedCode);

    console.log(`⏳ Waiting ${DELAY_BETWEEN_CALLS / 1000}s...`);
    await new Promise(res => setTimeout(res, DELAY_BETWEEN_CALLS));
  }
}

main().catch(err => {
  console.error("❌ AI Agent failed:", err.message);
  process.exit(1);
});
