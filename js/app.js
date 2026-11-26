/**
 * app.js - 页面逻辑：GitHub API 抓取、调用 RepoScanner、渲染可视化报告
 * 依赖：js/scanner.js（全局 RepoScanner）
 */
(function () {
  "use strict";

  var API_BASE = "https://api.github.com";
  var RAW_BASE = "https://raw.githubusercontent.com";

  var els = {};
  document.querySelectorAll("[data-el]").forEach(function (el) {
    els[el.getAttribute("data-el")] = el;
  });

  var state = {
    token: "",
    lastReport: null
  };

  // ------------------------------------------------------------------
  // 工具
  // ------------------------------------------------------------------

  function setProgress(text, cls) {
    els.progress.textContent = text;
    els.progress.className = "progress-log" + (cls ? " " + cls : "");
  }

  function appendProgress(text) {
    var div = document.createElement("div");
    div.textContent = text;
    els.progress.appendChild(div);
    els.progress.scrollTop = els.progress.scrollHeight;
  }

  function setBusy(busy) {
    els.scanBtn.disabled = busy;
    els.scanBtn.textContent = busy ? "分析中…" : "开始体检";
  }

  /** 解析 GitHub 仓库地址 → { owner, repo, branch? } */
  function parseRepoUrl(input) {
    input = input.trim();
    if (!input) return null;
    // 允许 owner/repo 简写
    var m = input.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, ""), branch: "" };
    m = input.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^\/#]+))?\/?(?:[?#].*)?$/i);
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, ""), branch: m[3] || "" };
    return null;
  }

  async function apiFetch(url, token) {
    var headers = { Accept: "application/vnd.github+json" };
    if (token) headers.Authorization = "Bearer " + token;
    var res = await fetch(url, { headers: headers });
    if (res.status === 403 || res.status === 429) {
      var remaining = res.headers.get("x-ratelimit-remaining");
      throw new Error("GitHub API 限流（剩余额度 " + (remaining === null ? "未知" : remaining) + "）。可在「高级选项」中填入 GitHub Token 提升额度，或稍后再试。");
    }
    if (res.status === 404) throw new Error("仓库不存在或为私有仓库（404）。请确认链接正确且仓库公开。");
    if (!res.ok) throw new Error("GitHub API 请求失败：" + res.status + " " + res.statusText);
    return res.json();
  }

  // ------------------------------------------------------------------
  // 抓取流程
  // ------------------------------------------------------------------

  async function fetchRepository(repoInfo) {
    var headers = {};
    if (state.token) headers.Authorization = "Bearer " + state.token;

    appendProgress("→ 获取仓库元数据: " + repoInfo.owner + "/" + repoInfo.repo);
    var repoData = await apiFetch(API_BASE + "/repos/" + repoInfo.owner + "/" + repoInfo.repo, state.token);
    var branch = repoInfo.branch || repoData.default_branch;
    appendProgress("  默认分支: " + branch + "（最近提交: " + (repoData.pushed_at || "未知") + "）");

    appendProgress("→ 拉取文件树 (recursive)");
    var tree = await apiFetch(API_BASE + "/repos/" + repoInfo.owner + "/" + repoInfo.repo + "/git/trees/" + encodeURIComponent(branch) + "?recursive=1", state.token);
    if (tree.truncated) {
      appendProgress("  ⚠️ 文件树过大被 GitHub 截断，仅扫描已返回部分", true);
    }

    var entries = (tree.tree || []).filter(function (e) { return e.type === "blob"; });
    appendProgress("  共 " + entries.length + " 个文件");

    // 决定需要抓取内容的文件（文本、不太大）
    var candidates = [];
    entries.forEach(function (e) {
      var ext = (e.path.split("/").pop().split(".").pop() || "").toLowerCase();
      var isText = RepoScanner._internal.isTextFile(e.path, e.size);
      if (isText && (e.size == null || e.size <= 200 * 1024)) {
        candidates.push({ path: e.path, size: e.size, sha: e.sha });
      }
    });
    var MAX_FILES = 1500;
    if (candidates.length > MAX_FILES) {
      appendProgress("  ⚠️ 文本文件超过 " + MAX_FILES + " 个，仅扫描前 " + MAX_FILES + " 个（按路径排序）以控制耗时");
      candidates.sort(function (a, b) { return a.path.localeCompare(b.path); });
      candidates = candidates.slice(0, MAX_FILES);
    }
    appendProgress("  需下载内容扫描的文本文件: " + candidates.length + " 个");

    // 批量并发抓取 raw 内容（raw.githubusercontent 不占用 API 限额）
    var fileList = [];
    var rawHeaders = {};
    if (state.token) rawHeaders.Authorization = "Bearer " + state.token;
    var CONCURRENCY = 8;
    var index = 0;
    var done = 0;

    async function worker() {
      while (index < candidates.length) {
        var cur = candidates[index++];
        try {
          var url = RAW_BASE + "/" + repoInfo.owner + "/" + repoInfo.repo + "/" + branch + "/" + cur.path.split("/").map(encodeURIComponent).join("/");
          var res = await fetch(url, { headers: rawHeaders });
          cur.content = res.ok ? await res.text() : null;
        } catch (e) {
          cur.content = null;
        }
        done++;
        if (done % 20 === 0 || done === candidates.length) {
          setProgress("下载文件内容 " + done + "/" + candidates.length);
        }
        fileList.push(cur);
      }
    }

    var workers = [];
    for (var w = 0; w < Math.min(CONCURRENCY, candidates.length); w++) workers.push(worker());
    await Promise.all(workers);

    var commitSha = "";
    try {
      var commit = await apiFetch(API_BASE + "/repos/" + repoInfo.owner + "/" + repoInfo.repo + "/commits/" + encodeURIComponent(branch) + "?per_page=1", state.token);
      commitSha = commit.sha || "";
      appendProgress("  报告基于 commit: " + commitSha.slice(0, 10));
    } catch (e) {
      appendProgress("  ⚠️ 获取 commit SHA 失败: " + e.message);
    }

    return { fileList: fileList, branch: branch, commitSha: commitSha, repoUrl: repoData.html_url, truncationNote: tree.truncated ? "文件树被 GitHub API 截断，结果可能不完整" : "" };
  }

  // ------------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------------

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderGauge(score, grade, levelText) {
    var angle = Math.round(score / 100 * 270);
    var color = score >= 85 ? "#16a34a" : score >= 70 ? "#f59e0b" : score >= 50 ? "#f97316" : "#dc2626";
    return '<div class="gauge-wrap">' +
      '<svg viewBox="0 0 200 130" class="gauge">' +
      '<path d="M 25 115 A 75 75 0 1 1 175 115" fill="none" stroke="#e5e7eb" stroke-width="18" stroke-linecap="round"/>' +
      '<path d="M 25 115 A 75 75 0 1 1 175 115" fill="none" stroke="' + color + '" stroke-width="18" stroke-linecap="round" ' +
      'stroke-dasharray="' + (angle / 360 * (270 / 360 * 2 * Math.PI * 75)).toFixed(1) + ' ' + (270 / 360 * 2 * Math.PI * 75).toFixed(1) + '"/>' +
      '<text x="100" y="92" text-anchor="middle" font-size="38" font-weight="700" fill="' + color + '">' + score + '</text>' +
      '<text x="100" y="112" text-anchor="middle" font-size="13" fill="#6b7280">/ 100 · 等级 ' + esc(grade) + '</text>' +
      '</svg>' +
      '<div class="gauge-level" style="color:' + color + '">' + esc(levelText) + '</div>' +
      '</div>';
  }

  function renderDimensionCard(title, icon, checks, extraHtml) {
    var rows = checks.map(function (c) {
      return '<div class="check-row"><span class="check-icon ' + (c.pass ? "ok" : "bad") + '">' + (c.pass ? "✓" : "✗") + '</span>' +
        '<span class="check-name">' + esc(c.name) + '</span>' +
        '<span class="check-detail">' + esc(c.detail) + '</span></div>';
    }).join("");
    return '<div class="dim-card"><h3>' + icon + " " + esc(title) + '</h3>' + (extraHtml || "") + rows + '</div>';
  }

  function severityBadge(sev) {
    var map = { high: ["高危", "sev-high"], medium: ["中危", "sev-medium"], low: ["低危/待确认", "sev-low"] };
    var m = map[sev] || [sev, ""];
    return '<span class="sev-badge ' + m[1] + '">' + m[0] + "</span>";
  }

  function renderFindings(findings) {
    if (!findings.length) {
      return '<div class="empty-box">🎉 未发现安全类风险项。</div>';
    }
    return findings.map(function (f) {
      var evRows = (f.evidence || []).map(function (e) {
        return '<div class="ev-row"><code class="ev-path">' + esc(e.path) + (e.line ? ":" + e.line : "") + '</code><pre class="ev-snippet">' + esc(e.snippet) + "</pre></div>";
      }).join("");
      var open = f.severity === "high" ? " open" : "";
      return '<details class="finding' + open + '"><summary>' + severityBadge(f.severity) +
        '<span class="finding-title">' + esc(f.title) + '</span><span class="finding-count">' + (f.evidenceCount || 0) + ' 处</span></summary>' +
        '<p class="finding-detail">' + esc(f.detail) + "</p>" +
        (evRows ? '<div class="evidence">' + evRows + "</div>" : "") +
        "</details>";
    }).join("");
  }

  function renderReport(report) {
    var suggestions = RepoScanner.buildSuggestions(report);
    var m = report.meta;

    var html =
      '<div class="report-head">' +
      '<div class="repo-line"><strong>' + esc(m.repoUrl) + "</strong> · 分支 " + esc(m.branch || "-") +
      (m.commitSha ? ' · <span class="sha" title="报告所基于的提交">commit ' + esc(m.commitSha.slice(0, 10)) + "</span>" : "") +
      ' · 扫描 ' + m.scannedFileCount + "/" + m.fileCount + " 个文件 · " + esc(m.scannedAt.replace("T", " ").slice(0, 19)) + "</div>" +
      (m.truncationNote ? '<div class="warn-box">⚠️ ' + esc(m.truncationNote) + "</div>" : "") +
      "</div>" +

      '<div class="report-grid">' +
      '<div class="panel score-panel"><h2>接入就绪度评分</h2>' + renderGauge(report.score, report.grade, report.levelText) +
      '<div class="deductions"><h4>扣分明细</h4>' +
      (report.deductions.length ? report.deductions.map(function (d) {
        return '<div class="ded-row"><span>' + esc(d.label) + '</span><span class="ded-points">-' + d.points + '</span></div><div class="ded-detail">' + esc(d.detail) + "</div>";
      }).join("") : '<div class="ded-detail">无扣分项，满分通过 🎉</div>') +
      "</div></div>" +

      '<div class="panel"><h2>维度体检</h2>' +
      renderDimensionCard("README 完整度", "📖", report.dimensions.readme.checks,
        '<div class="meter"><div class="meter-fill" style="width:' + report.dimensions.readme.qualityScore + '%"></div></div>') +
      renderDimensionCard("依赖清单", "📦", [
        { name: "存在依赖清单", pass: report.dimensions.dependencies.hasAny, detail: report.dimensions.dependencies.manifests.map(function (x) { return x.file; }).join(", ") || "未发现" },
        { name: "版本锁定 (lockfile)", pass: report.dimensions.dependencies.lockfileOk, detail: report.dimensions.dependencies.lockfiles.join(", ") || "未发现" }
      ]) +
      renderDimensionCard("启动脚本", "🚀", report.dimensions.startup.checks.length ? report.dimensions.startup.checks : [{ name: "启动方式", pass: false, detail: "未发现" }]) +
      renderDimensionCard("Windows 专用脚本", "🪟", [
        { name: ".bat/.cmd/.ps1/.vbs 文件", pass: true, detail: report.dimensions.windowsScripts.note }
      ], report.dimensions.windowsScripts.files.length ?
        '<div class="file-chips">' + report.dimensions.windowsScripts.files.map(function (f) { return '<span class="chip">' + esc(f) + "</span>"; }).join("") + "</div>" : "") +
      "</div>" +
      "</div>" +

      '<div class="panel"><h2>主要风险清单</h2>' + renderFindings(report.findings) + "</div>" +

      '<div class="panel"><h2>接入建议（规则生成）</h2><ol class="suggestion-list">' +
      suggestions.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ol></div>";

    els.report.innerHTML = html;
    els.report.classList.remove("hidden");
    renderAiSection(report);
  }

  // ------------------------------------------------------------------
  // AI 建议（可选，用户提供 OpenAI 兼容接口）
  // ------------------------------------------------------------------

  function renderAiSection(report) {
    var summary = buildAiSummary(report);
    els.aiSection.classList.remove("hidden");
    els.aiPromptData.textContent = summary;
    els.aiResult.innerHTML = "";
  }

  function buildAiSummary(report) {
    var lines = [];
    lines.push("仓库: " + report.meta.repoUrl + " (commit " + (report.meta.commitSha || "?").slice(0, 10) + ")");
    lines.push("评分: " + report.score + "/100, 等级 " + report.grade);
    if (report.deductions.length) {
      lines.push("扣分项: " + report.deductions.map(function (d) { return d.label + "(-" + d.points + ")"; }).join("; "));
    }
    report.findings.slice(0, 8).forEach(function (f) {
      lines.push("风险[" + f.severity + "] " + f.title + ": " + f.evidence.slice(0, 2).map(function (e) { return e.path + ":" + e.line; }).join(", "));
    });
    var d = report.dimensions;
    lines.push("README质量: " + d.readme.qualityScore + "/100; 依赖清单: " + (d.dependencies.hasAny ? "有" : "无") + "; lockfile: " + (d.dependencies.lockfileOk ? "有" : "无") + "; 启动方式: " + d.startup.methods.join(","));
    return lines.join("\n");
  }

  async function requestAiSuggestion() {
    var endpoint = els.aiEndpoint.value.trim().replace(/\/+$/, "");
    var apiKey = els.aiKey.value.trim();
    var model = els.aiModel.value.trim() || "gpt-4o-mini";
    if (!endpoint || !apiKey) {
      els.aiResult.innerHTML = '<div class="warn-box">请先填写 API 地址与密钥（密钥仅保存在当前页面内存中，不会上传到本项目服务器）。</div>';
      return;
    }
    els.aiResult.innerHTML = '<div class="loading">AI 分析中…</div>';
    try {
      var res = await fetch(endpoint + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: "你是资深工程师，负责评估新成员/新团队能否顺利接入一个 Git 仓库。根据扫描摘要，用中文输出：1) 接入就绪度总体评价（2句话）；2) 三个最优先的整改项（按优先级排序，各一句话+具体做法）；3) 一条加分建议。控制在 250 字以内，不要复述原始数据。" },
            { role: "user", content: els.aiPromptData.textContent }
          ],
          temperature: 0.4
        })
      });
      if (!res.ok) throw new Error("接口返回 " + res.status);
      var data = await res.json();
      var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "（模型未返回内容）";
      els.aiResult.innerHTML = '<div class="ai-text">' + esc(text).replace(/\n/g, "<br>") + "</div>";
    } catch (e) {
      els.aiResult.innerHTML = '<div class="warn-box">AI 请求失败: ' + esc(e.message) + "</div>";
    }
  }

  // ------------------------------------------------------------------
  // 主流程
  // ------------------------------------------------------------------

  async function runScan() {
    var repoInfo = parseRepoUrl(els.repoInput.value);
    if (!repoInfo) {
      setProgress("❌ 无法解析仓库地址，请输入形如 https://github.com/owner/repo 的链接", "error");
      return;
    }
    state.token = els.tokenInput.value.trim();
    setBusy(true);
    els.report.classList.add("hidden");
    els.report.innerHTML = "";
    els.aiSection.classList.add("hidden");
    els.progress.innerHTML = "";
    setProgress("开始体检 " + repoInfo.owner + "/" + repoInfo.repo + " …");

    try {
      var fetched = await fetchRepository(repoInfo);
      appendProgress("→ 运行本地扫描引擎");
      var report = RepoScanner.scanRepository(fetched.fileList, {
        repoUrl: fetched.repoUrl,
        branch: fetched.branch,
        commitSha: fetched.commitSha,
        truncationNote: fetched.truncationNote
      });
      state.lastReport = report;
      appendProgress("✅ 体检完成，得分 " + report.score + "/100（等级 " + report.grade + "）");
      setProgress("✅ 完成", "ok");
      renderReport(report);
      els.report.scrollIntoView({ behavior: "smooth" });
    } catch (e) {
      setProgress("❌ " + e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------
  // 事件绑定
  // ------------------------------------------------------------------

  els.scanBtn.addEventListener("click", runScan);
  els.repoInput.addEventListener("keydown", function (e) { if (e.key === "Enter") runScan(); });
  els.aiSubmitBtn.addEventListener("click", requestAiSuggestion);

  document.querySelectorAll(".example-link").forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      els.repoInput.value = a.getAttribute("data-url");
      runScan();
    });
  });
})();
