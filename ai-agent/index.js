import fs from "fs";
import axios from "axios";
import { Octokit } from "@octokit/rest";
import path from "path";
import { fileURLToPath } from "url";

/* -----------------------------
   Setup
------------------------------ */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const MAX_FILES = 3;
const MAX_RETRIES = 3;
const RETRY_DELAY = 4000;

console.log("🚀 AI Agent started...");
console.log("OPENAI MODEL:", OPENAI_MODEL);

/* -----------------------------
   Load Sonar issues
------------------------------ */
const sonarIssuesPath = path.join(__dirname, "sonar-issues.json");
const sonarData = JSON.parse(fs.readFileSync(sonarIssuesPath, "utf8"));
const issues = sonarData.issues || [];

console.log("Total Sonar Issues:", issues.length);

/* -----------------------------
   Helpers
------------------------------ */
async function fetchFile(filePath) {
  const { data } = await octokit.repos.getContent({
    owner: GITHUB_REPO.split("/")[0],
    repo: GITHUB_REPO.split("/")[1],
    path: filePath,
    ref: GITHUB_BRANCH,
  });
  return Buffer.from(data.content, "base64").toString("utf8");
}

async function callOpenAI(prompt) {
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const res = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: OPENAI_MODEL,
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
      return res.data.choices[0].message.content;
    } catch (e) {
      if (e.response?.status === 429) {
        console.warn(`⚠️ Rate limited, retry ${i}`);
        await new Promise(r => setTimeout(r, RETRY_DELAY * i));
      } else {
        throw e;
      }
    }
  }
  return null;
}

function saveFile(filePath, content) {
  const fullPath = path.join(__dirname, "..", filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
  console.log("✔ Updated:", filePath);
}

/* -----------------------------
   GROUP ISSUES BY FILE
------------------------------ */
const issuesByFile = {};

for (const issue of issues) {
  const filePath = issue.component.split(":").pop();

  // 🚫 Hard safety blocks
  if (
    filePath.startsWith("ai-agent/") ||
    filePath.endsWith(".spec.ts") ||
    filePath.includes("node_modules")
  ) {
    console.log("⛔ Skipping file:", filePath);
    continue;
  }

  // ✅ Allow ONLY real TS source files
  if (!filePath.endsWith(".ts")) {
    console.log("⚠️ Skipping non-code file:", filePath);
    continue;
  }

  if (!issuesByFile[filePath]) {
    issuesByFile[filePath] = [];
  }

  issuesByFile[filePath].push(issue.message);
}

const filesToFix = Object.keys(issuesByFile).slice(0, MAX_FILES);
console.log("Files to fix:", filesToFix);

/* -----------------------------
   FIX FILES
------------------------------ */
for (const file of filesToFix) {
  console.log("\n=============================");
  console.log("Fixing:", file);

  const originalCode = await fetchFile(file);

  const prompt = `
Fix ALL SonarCloud issues below.

ISSUES:
${issuesByFile[file].map((i, n) => `${n + 1}. ${i}`).join("\n")}

FILE:
${file}

CODE:
${originalCode}

Rules:
- Fix all issues
- Return full updated file
- No markdown
- No explanations
`;

  const fixed = await callOpenAI(prompt);
  if (!fixed) continue;

  saveFile(file, fixed.replace(/```+/g, "").trim());
}

console.log("✅ AI auto-fix completed");
