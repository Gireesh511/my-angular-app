import fs from "fs";
import axios from "axios";
import { Octokit } from "@octokit/rest";
import OpenAI from "openai";

// ENV variables (GitHub Actions)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;      // "username/project"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH;  // "main"

const octokit = new Octokit({ auth: GITHUB_TOKEN });

/**
 * Fetch file content from GitHub
 */
async function fetchFileFromGitHub(filePath) {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_REPO.split("/")[0],
      repo: GITHUB_REPO.split("/")[1],
      path: filePath,
      ref: GITHUB_BRANCH,
    });

    const content = Buffer.from(data.content, "base64").toString("utf8");
    return content;
  } catch (err) {
    console.log("❌ Error fetching file:", filePath, err.message);
    return null;
  }
}


console.log("🚀 AI Agent started...");
console.log("OPENAI KEY AVAILABLE:", !!process.env.OPENAI_API_KEY);
console.log("GITHUB TOKEN AVAILABLE:", !!process.env.GITHUB_TOKEN);
console.log("Reading sonar-issues.json...");

/**
 * Call OpenAI to fix issues
 */
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

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4.1",
      messages: [
        { role: "system", content: "You are a code-fixing agent." },
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
}

/**
 * Save updated file
 */
async function saveFixedFile(filePath, updatedContent) {
  const localPath = "../" + filePath; // Stores inside project folder

  fs.mkdirSync(require("path").dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, updatedContent, "utf8");

  console.log("✔ Updated:", localPath);
}

/**
 * Main runner
 */
async function main() {
  const sonarData = JSON.parse(fs.readFileSync("sonar-issues.json", "utf8"));

  if (!sonarData.issues || sonarData.issues.length === 0) {
    console.log("🎉 No issues found.");
    return;
  }
console.log("Total Sonar Issues Found:", sonarData.issues.length);

  for (const issue of sonarData.issues) {
    const filePath = issue.component.split(":").pop(); // Sonar paths like "src/app/file.ts"
    const issueMsg = issue.message;

    console.log("\n=============================");
    console.log("Processing:", filePath);
    console.log("Sonar Issue:", issueMsg);
console.log("Fixing file:", filePath);

    const originalCode = await fetchFileFromGitHub(filePath);
    if (!originalCode) continue;

    let fixedCode = await callOpenAI(filePath, issueMsg, originalCode);

    fixedCode = fixedCode.replace(/```+/g, "").trim(); // Remove markdown blocks

    await saveFixedFile(filePath, fixedCode);
  }
}

main().catch((err) => console.error(err));

