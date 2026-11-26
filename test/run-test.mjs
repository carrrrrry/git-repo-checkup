/**
 * run-test.mjs - 扫描引擎测试
 * 用法: node test/run-test.mjs
 * 第二部分会用真实 GitHub 仓库做端到端验证（需要网络）。
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const Scanner = require("../js/scanner.js");

let passed = 0;
let failed = 0;

function assert(cond, name, detail) {
  if (cond) {
    passed++;
    console.log("  ✓ " + name);
  } else {
    failed++;
    console.log("  ✗ " + name + (detail ? "  [" + detail + "]" : ""));
  }
}

// ==================================================================
// Part 1: 构造一个"问题仓库" fixture
// ==================================================================
console.log("\n== Part 1: 问题仓库 fixture ==");

const dirtyRepo = [
  { path: "package.json", content: JSON.stringify({
      name: "demo", scripts: { test: "echo test" }, // 故意没有 start/dev
      dependencies: { express: "^4.0.0" }
    }) },
  { path: "README.md", content: "# demo\n\n一个 demo 项目。\n" }, // 太短，无章节
  { path: ".env", content: "OPENAI_API_KEY=sk-aaaaaaaaaaaaaaaaaaaa1234\nDB_PASSWORD=super-secret-pass\n" },
  { path: "run.bat", content: "@echo off\npython C:\\Users\\zhangsan\\projects\\demo\\main.py\n" },
  { path: "config.js", content: "const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';\nconst endpoint = 'https://api.example.com';\nauthHeader = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123';\n" },
  { path: "main.py", content: "if __name__ == '__main__':\n    print('demo')\n" },
  { path: "server.js", content: "const dir = 'C:/Users/lisi/data';\nconst home = '/home/wangwu/app';\n" },
  { path: "id_rsa", content: null, size: 1700 },
  { path: ".gitignore", content: "node_modules\n" } // 没有 .env 条目
];

const dirtyReport = Scanner.scanRepository(dirtyRepo, { repoUrl: "fixture://dirty" });

assert(dirtyReport.score < 50, "问题仓库评分 < 50（实际 " + dirtyReport.score + "）");
assert(dirtyReport.grade === "D" || dirtyReport.grade === "C", "等级为 C/D（实际 " + dirtyReport.grade + "）");
assert(dirtyReport.dimensions.readme.exists === true, "README 存在检测");
assert(dirtyReport.dimensions.readme.qualityScore < 60, "README 质量分低（实际 " + dirtyReport.dimensions.readme.qualityScore + "）");
assert(dirtyReport.dimensions.dependencies.hasAny === true, "依赖清单检测（package.json）");
assert(dirtyReport.dimensions.startup.hasAny === true, "启动方式：Python 入口应被识别");
assert(dirtyReport.dimensions.windowsScripts.files.includes("run.bat"), "Windows 脚本 run.bat 被列出");
assert(dirtyReport.findings.some(f => f.id === "env-committed"), ".env 入库被检出");
assert(dirtyReport.findings.some(f => f.id === "key-files"), "id_rsa 文件被检出");
assert(dirtyReport.findings.some(f => f.id === "aws-akid"), "AWS AKIA 密钥被检出");
assert(dirtyReport.findings.some(f => f.id === "aliyun-akid" || f.id === "openai-sk"), "sk- 密钥被检出");
const skFinding = dirtyReport.findings.find(f => f.id === "openai-sk");
assert(skFinding && skFinding.evidence.every(e => e.snippet.includes("****")), "sk- 证据已脱敏");
assert(dirtyReport.findings.some(f => f.id === "hardcoded-path"), "硬编码路径被检出");
const pathFinding = dirtyReport.findings.find(f => f.id === "hardcoded-path");
assert(pathFinding && pathFinding.evidence.some(e => e.snippet.includes("C:\\Users\\zhangsan")), "C:\\Users 路径捕获");
assert(pathFinding && pathFinding.evidence.some(e => e.snippet.includes("/home/wangwu")), "/home/ 路径捕获");
assert(pathFinding && !pathFinding.evidence.some(e => e.snippet.includes("https://api.example.com")), "URL 不被误报为路径");
assert(dirtyReport.findings.some(f => f.id === "bearer-token"), "Bearer token 被检出");
const suggestions = Scanner.buildSuggestions(dirtyReport);
assert(suggestions.length >= 4, "规则建议 ≥ 4 条（实际 " + suggestions.length + "）");

// ==================================================================
// Part 2: "干净仓库" fixture
// ==================================================================
console.log("\n== Part 2: 干净仓库 fixture ==");

const cleanRepo = [
  { path: "README.md", content: "# Good Project\n\n## Installation\n\n```bash\nnpm install\n```\n\n## Quick Start\n\n```bash\nnpm start\n```\n\n## Configuration\n\nSet environment variables in `.env` file. " + "x".repeat(600) },
  { path: "package.json", content: JSON.stringify({ name: "good", scripts: { start: "node server.js" }, dependencies: {} }) },
  { path: "package-lock.json", content: "{}" },
  { path: ".env.example", content: "API_KEY=\n" },
  { path: ".gitignore", content: ".env\nnode_modules\n" },
  { path: "server.js", content: "const port = process.env.PORT || 3000;\nconsole.log('listening', port);\n" },
  { path: "run.sh", content: "npm start\n" }
];

const cleanReport = Scanner.scanRepository(cleanRepo, { repoUrl: "fixture://clean" });
assert(cleanReport.score >= 85, "干净仓库评分 ≥ 85（实际 " + cleanReport.score + "）");
assert(cleanReport.grade === "A", "等级 A（实际 " + cleanReport.grade + "）");
assert(cleanReport.findings.length === 0, "无风险发现（实际 " + cleanReport.findings.length + "）");
assert(cleanReport.dimensions.dependencies.lockfileOk, "lockfile 检测");
assert(cleanReport.dimensions.startup.methods.some(m => m.includes("scripts.start")), "scripts.start 识别");
assert(cleanReport.findings.every(f => f.id !== "env-committed"), ".env.example 不误报为 .env 入库");

// .env.example 与 .env.sample 均不应报警
const sampleRepo = [{ path: "conf/.env.sample", content: "KEY=" }];
const sampleReport = Scanner.scanRepository(sampleRepo, {});
assert(!sampleReport.findings.some(f => f.id === "env-committed"), "子目录 .env.sample 不误报");

// ==================================================================
// Part 3: 真实仓库端到端（GitHub API）
// ==================================================================
console.log("\n== Part 3: 真实仓库端到端 (expressjs/express) ==");

async function realRepoTest() {
  const repo = "expressjs/express";
  try {
    const repoData = await fetch(`https://api.github.com/repos/${repo}`).then(r => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
    const branch = repoData.default_branch;
    const tree = await fetch(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`).then(r => r.json());
    const candidates = tree.tree.filter(e => e.type === "blob" && e.size <= 200 * 1024 &&
      Scanner._internal.isTextFile(e.path, e.size)).slice(0, 300); // 测试限 300 个文件

    const fileList = [];
    let idx = 0;
    async function worker() {
      while (idx < candidates.length) {
        const cur = candidates[idx++];
        const url = `https://raw.githubusercontent.com/${repo}/${branch}/${cur.path}`;
        try {
          const res = await fetch(url);
          cur.content = res.ok ? await res.text() : null;
        } catch { cur.content = null; }
        fileList.push(cur);
      }
    }
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);

    const report = Scanner.scanRepository(fileList, { repoUrl: `https://github.com/${repo}`, branch });
    console.log(`  expressjs/express: score=${report.score} grade=${report.grade} files=${report.meta.scannedFileCount}/${report.meta.fileCount}`);
    assert(report.score > 0 && report.score <= 100, "评分在合法区间");
    assert(report.meta.scannedFileCount > 50, "扫描了大量文本文件（" + report.meta.scannedFileCount + "）");
    assert(report.dimensions.readme.exists, "README 存在");
    assert(report.dimensions.dependencies.hasAny, "package.json 存在");
    assert(report.dimensions.startup.hasAny, "启动方式/库入口存在（库项目按 main/exports 识别）");
    console.log("  发现项: " + report.findings.map(f => f.id).join(", "));
    assert(Array.isArray(report.findings), "findings 结构正确");
    assert(report.deductions.every(d => d.points > 0), "扣分明细合法");
  } catch (e) {
    console.log("  ⚠️ 真实仓库测试跳过（无网络或限流）: " + e.message);
  }
}

await realRepoTest();

// ==================================================================
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
