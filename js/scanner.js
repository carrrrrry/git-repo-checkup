/**
 * RepoScanner - Git 仓库接入体检扫描引擎
 * 纯逻辑模块：浏览器与 Node.js 双端可用（UMD 风格导出）
 *
 * 输入：fileList = [{ path: string, size?: number, content?: string | null }]
 *       content 为 null 时表示文件过大或二进制，仅参与文件名级检查
 * 输出：体检报告（评分、维度检查、风险清单、证据）
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.RepoScanner = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ------------------------------------------------------------------
  // 常量配置
  // ------------------------------------------------------------------

  /** 视为纯文本、需要抓内容做正则扫描的扩展名 */
  var TEXT_EXTENSIONS = new Set([
    "md", "txt", "rst", "adoc", "json", "yaml", "yml", "toml", "ini", "cfg",
    "xml", "html", "htm", "css", "scss", "less", "js", "mjs", "cjs", "ts",
    "tsx", "jsx", "vue", "py", "java", "kt", "kts", "go", "rs", "rb", "php",
    "c", "h", "cpp", "hpp", "cc", "cs", "swift", "dart", "scala", "sh",
    "bash", "bat", "cmd", "ps1", "vbs", "sql", "r", "lua", "pl", "ex",
    "exs", "gradle", "properties", "env", "conf", "makefile", "mk", "dockerfile"
  ]);

  /** 无扩展名但也常是文本的文件名（小写比较） */
  var TEXT_FILENAMES = new Set([
    "dockerfile", "makefile", "gemfile", "rakefile", "procfile", "license",
    "notice", "authors", "contributors", "changelog", "jenkinsfile",
    ".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".nvmrc",
    ".eslintrc", ".prettierrc", ".babelrc", ".dockerignore", ".env.example",
    ".env.sample", ".env.template", ".flake8", ".pep8"
  ]);

  /** 单文件扫描大小上限（字节），防止超大文件拖垮页面 */
  var MAX_SCAN_SIZE = 200 * 1024;

  /** 密钥类正则：命中即高风险（真实凭证格式） */
  var SECRET_HIGH_PATTERNS = [
    { id: "openai-sk", name: "OpenAI 风格密钥 (sk-)", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
    { id: "aws-akid", name: "AWS 访问密钥 (AKIA)", regex: /\bAKIA[0-9A-Z]{16}\b/g },
    { id: "aliyun-akid", name: "阿里云 AccessKey (LTAI/AKID)", regex: /\b(?:LTAI[A-Za-z0-9]{12,}|AKID[A-Za-z0-9]{16,})\b/g },
    { id: "github-token", name: "GitHub Token (ghp_/github_pat_)", regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
    { id: "slack-token", name: "Slack Token (xoxb 等)", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
    { id: "private-key", name: "私钥文件内容 (BEGIN PRIVATE KEY)", regex: /-----BEGIN\s[A-Z ]*PRIVATE KEY-----/g },
    { id: "google-api-key", name: "Google API Key", regex: /\bAIza[0-9A-Za-z_\-]{35}\b/g }
  ];

  /** 携带真实 token 的 Authorization 头（长随机串才报，避免误报头名本身） */
  var SECRET_BEARER_PATTERN = { id: "bearer-token", name: "硬编码 Bearer Token", regex: /[Bb]earer\s+[A-Za-z0-9\-_.~=+/]{20,}/g };

  /** 疑似凭证赋值：低置信度，标为"需人工确认" */
  var SECRET_LOW_PATTERN = /(?:password|passwd|secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|token)\s*[:=]\s*["'][^"'\s]{8,}["']/gi;

  /** 硬编码路径正则 */
  var PATH_PATTERNS = [
    { id: "win-backslash", name: "Windows 绝对路径 (C:\\)", regex: /(?:^|[\s(='",:<>])([A-Za-z]:\\(?:[^\\\s'"]+\\?){1,})/g },
    { id: "win-forwardslash", name: "Windows 绝对路径 (C:/)", regex: /(?:^|[\s(='",:<>])([A-Za-z]:\/(?:[^\/\s'"]+\/?){1,})/g },
    { id: "mac-users", name: "macOS 用户目录 (/Users/)", regex: /\/Users\/[A-Za-z0-9_.\-]+/g },
    { id: "linux-home", name: "Linux 用户目录 (/home/)", regex: /\/home\/[A-Za-z0-9_.\-]+/g }
  ];

  /** README 段落检查词 */
  var README_SECTIONS = [
    { key: "install", label: "安装/部署说明", regex: /(安装|部署|依赖|install|setup|getting\s*started|prerequisite)/i },
    { key: "run", label: "启动/运行说明", regex: /(启动|运行|快速开始|quick\s*start|getting\s*started|how\s*to\s*run|usage|使用)/i },
    { key: "config", label: "配置/环境变量说明", regex: /(配置|环境变量|config|configuration|environment|\.env)/i }
  ];

  /** 各生态依赖清单定义 */
  var DEP_MANIFESTS = [
    { name: "Node.js (package.json)", file: "package.json" },
    { name: "Python (requirements.txt)", file: "requirements.txt" },
    { name: "Python (pyproject.toml)", file: "pyproject.toml" },
    { name: "Java (pom.xml)", file: "pom.xml" },
    { name: "Java/Gradle (build.gradle)", file: "build.gradle" },
    { name: "Go (go.mod)", file: "go.mod" },
    { name: "Rust (Cargo.toml)", file: "Cargo.toml" },
    { name: "PHP (composer.json)", file: "composer.json" },
    { name: "Ruby (Gemfile)", file: "Gemfile" },
    { name: "Flutter (pubspec.yaml)", file: "pubspec.yaml" }
  ];

  var LOCKFILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "uv.lock", "Cargo.lock", "composer.lock", "go.sum", "gradle.lockfile"];

  /** Windows 专用脚本扩展名 */
  var WINDOWS_SCRIPT_EXTS = ["bat", "cmd", "ps1", "vbs"];

  // ------------------------------------------------------------------
  // 工具函数
  // ------------------------------------------------------------------

  function getExtension(path) {
    var base = path.split("/").pop();
    var dot = base.lastIndexOf(".");
    return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
  }

  function getBaseName(path) {
    return path.split("/").pop().toLowerCase();
  }

  function isTextFile(path, size) {
    if (size != null && size > MAX_SCAN_SIZE) return false;
    var ext = getExtension(path);
    // 无扩展名的文件（如 Makefile、LICENSE、密钥文件等）默认按文本处理
    if (!ext) return true;
    if (TEXT_EXTENSIONS.has(ext)) return true;
    return TEXT_FILENAMES.has(getBaseName(path)) || getBaseName(path).charAt(0) === ".";
  }

  /** 逐行扫描，返回 { line, snippet } 证据列表（已去重、限量） */
  function scanLines(content, patternFn, maxEvidence) {
    var lines = content.split(/\r?\n/);
    var evidence = [];
    var seen = {};
    for (var i = 0; i < lines.length && evidence.length < (maxEvidence || 8); i++) {
      var hit = patternFn(lines[i]);
      if (hit) {
        var key = i + ":" + hit;
        if (!seen[key]) {
          seen[key] = true;
          evidence.push({ line: i + 1, snippet: lines[i].trim().slice(0, 160) });
        }
      }
    }
    return evidence;
  }

  function matchFirst(text, regex) {
    regex.lastIndex = 0;
    var m = regex.exec(text);
    return m ? m[0] : null;
  }

  // ------------------------------------------------------------------
  // 主扫描入口
  // ------------------------------------------------------------------

  /**
   * @param {Array} fileList 文件列表
   * @param {Object} options { repoUrl, branch, commitSha, truncationNote }
   */
  function scanRepository(fileList, options) {
    options = options || {};
    var pathSet = {};
    fileList.forEach(function (f) { pathSet[f.path] = f; });

    var findings = [];
    var deductions = [];

    var readmeResult = scanReadme(pathSet, fileList);
    var depsResult = scanDependencies(pathSet, fileList);
    var startupResult = scanStartup(pathSet, fileList);
    var windowsResult = scanWindowsScripts(fileList);
    var pathFindings = scanHardcodedPaths(fileList);
    var secretFindings = scanSecrets(pathSet, fileList);

    if (pathFindings) findings.push(pathFindings);
    findings = findings.concat(secretFindings);

    // ---------------- 评分 ----------------
    var score = 100;

    if (!readmeResult.exists) {
      deductions.push({ label: "缺少 README", points: 25, detail: "未找到 README.md / README 等说明文档" });
      score -= 25;
    } else if (readmeResult.qualityScore < 60) {
      deductions.push({ label: "README 完整度不足", points: 10, detail: "README 过短或缺少安装/启动/配置说明" });
      score -= 10;
    }

    if (!depsResult.hasAny) {
      deductions.push({ label: "缺少依赖清单", points: 20, detail: "未识别到 package.json / requirements.txt / pom.xml 等依赖声明" });
      score -= 20;
    } else if (depsResult.packageJson && !depsResult.packageJson.valid) {
      deductions.push({ label: "package.json 无法解析", points: 8, detail: "文件存在但不是合法 JSON" });
      score -= 8;
    }

    if (!startupResult.hasAny) {
      deductions.push({ label: "缺少明确的启动方式", points: 15, detail: "未找到可执行的启动脚本/命令（scripts.start、Dockerfile、Makefile 等）" });
      score -= 15;
    }

    var secretHigh = findings.filter(function (f) { return f.category === "secret" && f.severity === "high"; });
    var secretPenalty = Math.min(secretHigh.length * 10, 30);
    if (secretPenalty > 0) {
      deductions.push({ label: "疑似密钥/敏感信息入库", points: secretPenalty, detail: secretHigh.length + " 项高风险发现（每项 -10，封顶 -30）" });
      score -= secretPenalty;
    }

    var envPenalty = secretFindings.some(function (f) { return f.id === "env-committed"; }) ? 10 : 0;
    if (envPenalty > 0) {
      deductions.push({ label: ".env 文件已提交入库", points: envPenalty, detail: ".env 应加入 .gitignore，仅保留 .env.example" });
      score -= envPenalty;
    }

    if (pathFindings && pathFindings.evidenceCount > 0) {
      var pathPenalty = Math.min(Math.ceil(pathFindings.evidenceCount / 3) * 5, 15);
      deductions.push({ label: "存在硬编码本机路径", points: pathPenalty, detail: "发现 " + pathFindings.evidenceCount + " 处绝对路径（影响他人接入）" });
      score -= pathPenalty;
    }

    score = Math.max(0, Math.min(100, score));

    var grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 50 ? "C" : "D";
    var levelText = { A: "接入就绪：开箱即用", B: "基本就绪：小改动即可接入", C: "存在阻碍：需补齐关键文档/脚本", D: "高风险：暂不建议直接接入" }[grade];

    return {
      meta: {
        repoUrl: options.repoUrl || "",
        branch: options.branch || "",
        commitSha: options.commitSha || "",
        scannedAt: new Date().toISOString(),
        fileCount: fileList.length,
        scannedFileCount: fileList.filter(function (f) { return f.content; }).length,
        truncationNote: options.truncationNote || ""
      },
      score: score,
      grade: grade,
      levelText: levelText,
      deductions: deductions,
      dimensions: {
        readme: readmeResult,
        dependencies: depsResult,
        startup: startupResult,
        windowsScripts: windowsResult
      },
      findings: findings
    };
  }

  // ------------------------------------------------------------------
  // 各维度扫描实现
  // ------------------------------------------------------------------

  function scanReadme(pathSet, fileList) {
    var readmeFile = null;
    ["README.md", "readme.md", "Readme.md", "README", "README.txt", "README.rst", "README.html", "Readme"].forEach(function (name) {
      if (!readmeFile && pathSet[name]) readmeFile = pathSet[name];
    });
    if (!readmeFile) {
      readmeFile = fileList.find(function (f) { return getBaseName(f.path).indexOf("readme") === 0; }) || null;
    }

    var result = {
      exists: !!readmeFile,
      file: readmeFile ? readmeFile.path : "",
      qualityScore: 0,
      length: 0,
      checks: []
    };
    if (!readmeFile) {
      result.checks.push({ name: "README 文件", pass: false, detail: "未找到任何 README 文件" });
      return result;
    }

    var content = readmeFile.content || "";
    result.length = content.length;

    result.checks.push({ name: "README 文件", pass: true, detail: "找到 " + readmeFile.path });

    var longEnough = content.length >= 500;
    result.checks.push({ name: "内容篇幅", pass: longEnough, detail: longEnough ? "约 " + content.length + " 字符" : "仅 " + content.length + " 字符，过于单薄" });

    README_SECTIONS.forEach(function (sec) {
      var found = sec.regex.test(content);
      result.checks.push({ name: sec.label, pass: found, detail: found ? "已覆盖" : "未发现相关章节" });
      sec.regex.lastIndex = 0;
    });

    var hasCodeBlock = content.indexOf("```") !== -1;
    result.checks.push({ name: "含可复制的命令/代码块", pass: hasCodeBlock, detail: hasCodeBlock ? "存在 ``` 代码块" : "无代码块，接入者可能需要自行摸索命令" });

    var passCount = result.checks.filter(function (c) { return c.pass; }).length;
    result.qualityScore = Math.round((passCount / result.checks.length) * 100);
    return result;
  }

  function scanDependencies(pathSet, fileList) {
    var result = { hasAny: false, manifests: [], lockfiles: [], packageJson: null };

    DEP_MANIFESTS.forEach(function (dep) {
      var f = pathSet[dep.file];
      if (f) {
        result.hasAny = true;
        result.manifests.push({ name: dep.name, file: dep.file });
      }
    });

    LOCKFILES.forEach(function (name) {
      if (pathSet[name]) result.lockfiles.push(name);
    });

    var pkg = pathSet["package.json"];
    if (pkg && pkg.content) {
      try {
        var parsed = JSON.parse(pkg.content);
        var scripts = parsed.scripts || {};
        var startScripts = Object.keys(scripts).filter(function (k) { return k === "start" || k === "dev" || k === "serve"; });
        result.packageJson = {
          valid: true,
          hasName: !!parsed.name,
          hasDeps: !!(parsed.dependencies || parsed.devDependencies),
          startScripts: startScripts
        };
        if (startScripts.length) {
          result.hasAny = true;
          result.manifests.push({ name: "启动命令 scripts." + startScripts.join("/"), file: "package.json" });
        }
      } catch (e) {
        result.packageJson = { valid: false };
      }
    }

    result.lockfileOk = result.lockfiles.length > 0;
    return result;
  }

  function scanStartup(pathSet, fileList) {
    var result = { hasAny: false, methods: [], checks: [] };

    function add(method, ok, detail) {
      result.checks.push({ name: method, pass: ok, detail: detail || "" });
      if (ok) {
        result.hasAny = true;
        result.methods.push(method);
      }
    }

    // package.json scripts
    var hasStartScript = false;
    if (pathSet["package.json"] && pathSet["package.json"].content) {
      try {
        var parsedPkg = JSON.parse(pathSet["package.json"].content);
        var scripts = parsedPkg.scripts || {};
        var keys = ["start", "dev", "serve"];
        for (var i = 0; i < keys.length; i++) {
          if (scripts[keys[i]]) {
            hasStartScript = true;
            add("npm 脚本 scripts." + keys[i], true, "命令: " + String(scripts[keys[i]]).slice(0, 80));
          }
        }
        // 库项目：无 start 脚本属正常，识别 main/exports 入口或约定的 index.js
        if (!hasStartScript && (parsedPkg.main || parsedPkg.exports)) {
          add("库项目入口 (package.json main/exports)", true, "无启动脚本属正常，" + (parsedPkg.main ? "入口: " + parsedPkg.main : "exports 已声明"));
        } else if (!hasStartScript && (pathSet["index.js"] || pathSet["index.mjs"] || pathSet["index.ts"] || pathSet["lib/index.js"] || pathSet["lib/index.mjs"])) {
          add("库项目入口 (约定 index.js)", true, "无 main 字段，但存在约定的根目录 index.js 入口");
        } else if (!hasStartScript) {
          add("npm 脚本 scripts.start/dev", false, "package.json 存在但无 start/dev 脚本");
        }
      } catch (e) { /* 已在依赖维度提示 */ }
    }

    ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml"].forEach(function (name) {
      if (pathSet[name]) add("容器化启动 (" + name + ")", true, "找到 " + name);
    });

    var makefile = pathSet["Makefile"] || pathSet["makefile"];
    if (makefile && makefile.content && /(run|start|dev)\s*:/i.test(makefile.content)) {
      add("Makefile 运行目标", true, "Makefile 中含 run/start/dev 目标");
    }

    ["run.sh", "start.sh", "main.sh", "dev.sh", "run.bat", "start.bat"].forEach(function (name) {
      if (pathSet[name] || pathSet[name.toLowerCase()]) add("启动脚本 " + name, true, "找到 " + name);
    });

    // Python 常见入口
    ["main.py", "app.py", "manage.py"].forEach(function (name) {
      var f = pathSet[name];
      if (f && f.content && /if\s+__name__\s*==\s*['"]__main__['"]/.test(f.content)) {
        add("Python 入口 (" + name + ")", true, "可 python " + name + " 启动");
      }
    });

    if (!result.hasAny) {
      result.checks.push({ name: "任何可执行入口", pass: false, detail: "未发现 Dockerfile / 启动脚本 / npm start / Python 入口等" });
    }
    return result;
  }

  function scanWindowsScripts(fileList) {
    var files = fileList.filter(function (f) {
      return WINDOWS_SCRIPT_EXTS.indexOf(getExtension(f.path)) !== -1;
    }).map(function (f) { return f.path; });

    var hasShell = fileList.some(function (f) { return getExtension(f.path) === "sh"; });
    return {
      files: files,
      hasShellCounterpart: hasShell,
      note: files.length === 0
        ? "未发现 Windows 专用脚本"
        : (hasShell
          ? "发现 " + files.length + " 个 Windows 脚本，且存在 .sh 脚本，跨平台兼容较好"
          : "发现 " + files.length + " 个 Windows 专用脚本但无 .sh 脚本，Linux/macOS 接入者可能需要手工翻译命令")
    };
  }

  function scanHardcodedPaths(fileList) {
    var evidence = [];
    var typeCounts = {};
    fileList.forEach(function (f) {
      if (!f.content) return;
      PATH_PATTERNS.forEach(function (pat) {
        scanLines(f.content, function (line) {
          return matchFirst(line, pat.regex);
        }, 20).forEach(function (ev) {
          // 排除明显误报：指向自家域名的 URL、包导入路径
          if (/https?:\/\//.test(ev.snippet) && pat.id.indexOf("win") === 0) return;
          if (/^\s*(import|from|require|#include|using)\s/.test(ev.snippet)) return;
          typeCounts[pat.id] = (typeCounts[pat.id] || 0) + 1;
          evidence.push({ path: f.path, line: ev.line, snippet: ev.snippet, type: pat.name });
        });
      });
    });

    if (evidence.length === 0) return null;

    evidence.sort(function (a, b) { return a.path.localeCompare(b.path); });
    var topEvidence = evidence.slice(0, 10);
    return {
      category: "path",
      severity: "medium",
      id: "hardcoded-path",
      title: "硬编码本机绝对路径",
      detail: "代码/文档中出现 C:\\、/Users/、/home/ 等本机路径，其他接入者环境不同将直接运行失败。共发现 " + evidence.length + " 处。",
      evidenceCount: evidence.length,
      typeCounts: typeCounts,
      evidence: topEvidence
    };
  }

  function scanSecrets(pathSet, fileList) {
    var findings = [];

    // 1) .env 入库检查
    var envFiles = fileList.filter(function (f) {
      var base = getBaseName(f.path);
      return base === ".env" || /^\.env\.[^.]+$/.test(base) && !/example|sample|template/.test(base);
    });
    if (envFiles.length > 0) {
      findings.push({
        category: "secret",
        severity: "high",
        id: "env-committed",
        title: ".env 文件已提交入库",
        detail: "以下环境变量文件被提交到仓库，可能包含真实凭证。建议加入 .gitignore，只保留 .env.example 作为模板。",
        evidence: envFiles.slice(0, 10).map(function (f) { return { path: f.path, line: 0, snippet: "整个文件入库" }; }),
        evidenceCount: envFiles.length
      });
    }

    // 2) 密钥/证书类文件名
    var keyFiles = fileList.filter(function (f) {
      var base = getBaseName(f.path);
      if (/^id_rsa|^id_dsa|^id_ecdsa|^id_ed25519/.test(base)) return true;
      return /\.(pem|p12|pfx|keystore|jks)$/.test(base) && !/example|sample|public|test|dummy/.test(base);
    });
    if (keyFiles.length > 0) {
      findings.push({
        category: "secret",
        severity: "medium",
        id: "key-files",
        title: "仓库中存在密钥/证书类文件",
        detail: "发现疑似私钥或证书文件，请确认是否为真实凭证。",
        evidence: keyFiles.slice(0, 10).map(function (f) { return { path: f.path, line: 0, snippet: "密钥/证书文件入库" }; }),
        evidenceCount: keyFiles.length
      });
    }

    // 3) 内容正则扫描（高风险格式）
    var highHits = {}; // patternId -> evidence[]
    var lowHits = [];

    fileList.forEach(function (f) {
      if (!f.content) return;
      var pats = SECRET_HIGH_PATTERNS.concat([SECRET_BEARER_PATTERN]);
      pats.forEach(function (pat) {
        var evs = scanLines(f.content, function (line) { return matchFirst(line, pat.regex); }, 5);
        evs.forEach(function (ev) {
          if (!highHits[pat.id]) {
            highHits[pat.id] = { pattern: pat, evidence: [] };
          }
          if (highHits[pat.id].evidence.length < 6) {
            highHits[pat.id].evidence.push({ path: f.path, line: ev.line, snippet: maskSecret(ev.snippet) });
          }
        });
      });

      // 低置信度赋值扫描
      scanLines(f.content, function (line) {
        SECRET_LOW_PATTERN.lastIndex = 0;
        return SECRET_LOW_PATTERN.test(line) ? line.trim() : null;
      }, 3).forEach(function (ev) {
        if (lowHits.length < 15) lowHits.push({ path: f.path, line: ev.line, snippet: maskSecret(ev.snippet) });
      });
    });

    Object.keys(highHits).forEach(function (id) {
      var item = highHits[id];
      findings.push({
        category: "secret",
        severity: "high",
        id: id,
        title: item.pattern.name,
        detail: "代码中命中高危凭证格式（已脱敏展示），若为真实密钥请立即吊销并改用环境变量。",
        evidence: item.evidence,
        evidenceCount: item.evidence.length
      });
    });

    if (lowHits.length > 0) {
      findings.push({
        category: "secret",
        severity: "low",
        id: "generic-credential",
        title: "疑似凭证赋值（需人工确认）",
        detail: "发现 password/token/api_key 等字段被赋以字面量，可能只是示例或占位符，请人工确认。共 " + lowHits.length + " 处（最多展示 15 处）。",
        evidence: lowHits,
        evidenceCount: lowHits.length
      });
    }

    return findings;
  }

  /** 证据脱敏：保留格式特征，隐藏主体 */
  function maskSecret(snippet) {
    return snippet.replace(/(sk-|ghp_|gho_|xox[bpars]-|AKIA|LTAI|github_pat_)[A-Za-z0-9_\-]{6,}/g, function (m) {
      return m.slice(0, Math.min(7, m.length)) + "****";
    }).replace(/(["'][^"']{12,})["']/g, function (m) {
      return m.slice(0, 6) + "****" + m.slice(-2);
    });
  }

  /** 规则版接入建议（不依赖 AI，始终可用） */
  function buildSuggestions(report) {
    var suggestions = [];
    var d = report.dimensions;

    if (!d.readme.exists) {
      suggestions.push("补一份 README：至少包含「项目简介 → 依赖安装 → 一键启动 → 常见问题」四段，接入者 10 分钟内应能跑起来。");
    } else if (d.readme.qualityScore < 60) {
      suggestions.push("README 已存在但完整度不足（" + d.readme.qualityScore + "/100），优先补齐缺失章节：" + d.readme.checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }).join("、") + "。");
    }

    if (!d.dependencies.hasAny) {
      suggestions.push("没有任何依赖清单：请按语言补 package.json / requirements.txt / pom.xml / go.mod 等，否则接入者无法确定环境版本。");
    } else if (!d.dependencies.lockfileOk) {
      suggestions.push("缺少 lockfile（package-lock.json / poetry.lock / go.sum 等）：依赖版本未锁定，不同时间安装结果可能不一致，建议提交锁文件。");
    }

    if (!d.startup.hasAny) {
      suggestions.push("缺少明确启动方式：建议增加 scripts.start（npm）或 Dockerfile，让 `一条命令` 能拉起服务。");
    }

    if (d.windowsScripts.files.length > 0 && !d.windowsScripts.hasShellCounterpart) {
      suggestions.push("项目只有 Windows 脚本（" + d.windowsScripts.files.join(", ") + "）：建议补充等效 .sh 脚本或在 README 写明 macOS/Linux 的替代命令，避免非 Windows 接入者卡壳。");
    }

    var pathFinding = report.findings.find(function (f) { return f.id === "hardcoded-path"; });
    if (pathFinding) {
      suggestions.push("将 " + pathFinding.evidenceCount + " 处硬编码路径改为环境变量或相对路径（如 DATA_DIR、BASE_PATH），并在 README 环境变量表中说明。");
    }

    var envFinding = report.findings.find(function (f) { return f.id === "env-committed"; });
    if (envFinding) {
      suggestions.push("把 .env 从 git 历史中移除（git rm --cached + 重写历史或吊销其中的密钥），并添加到 .gitignore，提交一份 .env.example 模板。");
    }

    report.findings.filter(function (f) { return f.category === "secret" && f.severity === "high" && f.id !== "env-committed"; })
      .forEach(function (f) {
        suggestions.push("处理高风险发现「" + f.title + "」：确认是否为真实凭证，若是，立即在对应平台吊销并轮换，新密钥走环境变量注入。");
      });

    if (suggestions.length === 0) {
      suggestions.push("各项基础检查均通过，接入就绪度高。可进一步：补 CI（GitHub Actions）、加 Dockerfile、编写 CONTRIBUTING.md 提升协作体验。");
    }
    return suggestions;
  }

  return {
    scanRepository: scanRepository,
    buildSuggestions: buildSuggestions,
    _internal: { isTextFile: isTextFile, getExtension: getExtension, maskSecret: maskSecret }
  };
});
