// Jarvis Worker Spending Kit Demo (static)
// This demo does NOT execute real payments. It only evaluates a spend request against a sample policy.

(function () {
  const policy = {
    perTxCap: 300,
    monthlyCapDefault: 5000,
    allowlistVendors: ["AWS", "OpenAI", "GitHub", "Amazon", "Upwork", "Coursera", "GiveWell", "MSF"],
    allowlistCategories: ["ops_compute", "tooling", "reliability", "knowledge_assets", "human_services", "charity"],
    humanInLoop: {
      amountGte: 200,
      categories: ["charity", "human_services"],
    },
    requiredFields: ["amount", "vendor", "category", "reason_code", "linked_deliverable_id", "expected_effect"],
  };

  const baseWorkers = "Planner → Policy Worker → Risk Worker → Ledger Worker";

  const examples = {
    tooling: {
      meta: {
        title: "Tooling for reproducibility",
        goal: "Jarvis 正准备交付一份研究/咨询结果，想花 49 美元购买一个工具订阅，用来提高实验追踪和可复现性。",
        workers: baseWorkers,
        output: "示例策略下通常会自动通过，并生成一条可审计的账本记录。"
      },
      request: {
        amount: 49,
        currency: "USD",
        vendor: "GitHub",
        category: "tooling",
        reason_code: "tooling_subscription",
        linked_deliverable_id: "2026-03-demo-clientA",
        expected_effect: "enable experiment tracking / version control for reproducibility",
        risk_level: "R1",
      }
    },
    reliability: {
      meta: {
        title: "Human review before delivery",
        goal: "Jarvis 想在交付前买一次人工复核，降低报告或论文草稿的错误风险，把这笔钱记到可靠性/人类服务支出里。",
        workers: baseWorkers,
        output: "系统会判断是否允许从人类服务类目支出，以及是否需要人工审批。"
      },
      request: {
        amount: 180,
        currency: "USD",
        vendor: "Upwork",
        category: "human_services",
        reason_code: "independent_review",
        linked_deliverable_id: "2026-03-demo-clientB",
        expected_effect: "pay for human review & statistical checks as conclusion insurance",
        risk_level: "R2",
      }
    },
    charity: {
      meta: {
        title: "Small auditable donation",
        goal: "Jarvis 按规则从利润里拿出一小部分，向白名单公益机构做一笔带用途标签和回执要求的捐赠。",
        workers: baseWorkers,
        output: "系统会检查金额、类目、供应商和用途标签，并给出决策及后续要求。"
      },
      request: {
        amount: 50,
        currency: "USD",
        vendor: "GiveWell",
        category: "charity",
        reason_code: "charity_take_rate",
        linked_deliverable_id: "2026-03-profit-pool",
        expected_effect: "auditable donation with purpose tags and receipt requirement",
        purpose_tag: "education",
        risk_level: "R0",
      }
    },
    suspicious: {
      meta: {
        title: "Suspicious request / kill-switch demo",
        goal: "一个异常请求试图从未知供应商发起高频小额支出，系统需要演示如何触发冻结和人工排查。",
        workers: baseWorkers,
        output: "这类请求会被标记为异常，并触发冻结而不是继续执行。"
      },
      request: {
        amount: 10,
        currency: "USD",
        vendor: "UnknownVendor",
        category: "tooling",
        reason_code: "misc",
        linked_deliverable_id: "n/a",
        expected_effect: "",
        risk_level: "R3",
        repeat_count_1h: 12
      }
    }
  };

  const stageConfig = {
    ready: {
      label: "Ready",
      worker: "—",
      explain: "等待一条支出请求。",
      checks: ["选择一个示例，或直接编辑 JSON。"]
    },
    planning: {
      label: "Planning",
      worker: "Planner",
      explain: "把用户目标整理成一条结构化 Spend Request。",
      checks: [
        "核对请求字段与目标是否一致",
        "检查金额、用途和关联交付是否齐全"
      ]
    },
    policy: {
      label: "Policy check",
      worker: "Policy Worker",
      explain: "根据预算、白名单和必填字段进行规则检查。",
      checks: [
        "检查必填字段",
        "检查月度预算与单笔限额",
        "检查商家/类目是否在白名单中"
      ]
    },
    risk: {
      label: "Risk review",
      worker: "Risk Worker",
      explain: "评估风险等级，判断是否需要人工审批，是否触发异常冻结。",
      checks: [
        "检查高风险类目与金额阈值",
        "检查是否存在异常模式（高频小额 / 缺少信息）"
      ]
    },
    ledger: {
      label: "Ledger write",
      worker: "Ledger Worker",
      explain: "把决策和请求写成账本条目预览，用于审计与月度复盘。",
      checks: [
        "生成 decision + reasons + next steps",
        "生成可追踪的 ledger preview"
      ]
    }
  };

  let currentExample = "tooling";
  let runToken = 0;

  function $(id) { return document.getElementById(id); }

  function decisionRank(d) {
    return { "APPROVE": 0, "REQUIRE_HUMAN_APPROVAL": 1, "REJECT": 2, "FREEZE": 3 }[d] ?? 0;
  }

  function upgradeDecision(current, next) {
    return decisionRank(next) > decisionRank(current) ? next : current;
  }

  function nowIso() { return new Date().toISOString(); }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function setScenario(name) {
    currentExample = name;
    const meta = examples[name].meta;
    $("scenarioGoal").textContent = meta.goal;
    $("scenarioWorkers").textContent = meta.workers;
    $("scenarioOutput").textContent = meta.output;
  }

  function setStage(name, markDoneBefore = false) {
    const cfg = stageConfig[name] || stageConfig.ready;
    $("currentStage").textContent = cfg.label;
    $("currentWorker").textContent = cfg.worker;
    $("stageExplain").textContent = cfg.explain;
    renderList($("stageChecks"), cfg.checks);

    const allSteps = document.querySelectorAll(".step");
    allSteps.forEach(step => {
      step.classList.remove("active", "done");
      if (markDoneBefore) {
        const order = ["planning", "policy", "risk", "ledger"];
        const currentIndex = order.indexOf(name);
        const stepIndex = order.indexOf(step.dataset.step);
        if (stepIndex !== -1 && stepIndex < currentIndex) {
          step.classList.add("done");
        }
      }
      if (step.dataset.step === name) {
        step.classList.add("active");
      }
    });
  }

  function setReady() {
    setStage("ready", false);
    document.querySelectorAll(".step").forEach(step => step.classList.remove("active", "done"));
    document.querySelector('.step[data-step="planning"]').classList.add('active');
    $("decision").textContent = "—";
    $("reasons").innerHTML = "";
    $("next").innerHTML = "";
    $("ledger").textContent = "{}";
  }

  function evaluate(req, spentSoFar, monthlyCap) {
    let decision = "APPROVE";
    const reasons = [];
    const next = [];

    const missing = policy.requiredFields.filter((k) => req[k] === undefined || req[k] === null || req[k] === "");
    if (missing.length) {
      decision = upgradeDecision(decision, "REJECT");
      reasons.push("缺少必要字段: " + missing.join(", "));
      next.push("补齐必要字段（amount / vendor / category / reason_code / linked_deliverable_id / expected_effect）。");
    }

    if (req.category && !policy.allowlistCategories.includes(req.category)) {
      decision = upgradeDecision(decision, "REJECT");
      reasons.push("类目不在白名单: " + req.category);
      next.push("将 category 调整为允许的类目，或把该类目加入白名单（需要治理流程）。");
    }

    if (req.vendor && !policy.allowlistVendors.includes(req.vendor)) {
      decision = upgradeDecision(decision, "REQUIRE_HUMAN_APPROVAL");
      reasons.push("商家不在白名单: " + req.vendor + "（需要人工审批）");
      next.push("人工核验供应商身份与收款路径；必要时改用白名单供应商。");
    }

    const cap = (typeof monthlyCap === "number" && monthlyCap >= 0) ? monthlyCap : policy.monthlyCapDefault;
    const remaining = Math.max(0, cap - Math.max(0, spentSoFar || 0));

    if (typeof req.amount === "number") {
      if (req.amount > remaining) {
        decision = upgradeDecision(decision, "REJECT");
        reasons.push("超出当月剩余预算: remaining=" + remaining + " USD");
        next.push("降低金额、等待下个预算周期，或提高预算上限（需要审批/复盘）。");
      }
      if (req.amount > policy.perTxCap) {
        decision = upgradeDecision(decision, "REQUIRE_HUMAN_APPROVAL");
        reasons.push("超过单笔限额: perTxCap=" + policy.perTxCap + " USD（需要人工审批）");
        next.push("人工确认该支出必要性；必要时拆分为里程碑付款。");
      }
    }

    if (req.category && policy.humanInLoop.categories.includes(req.category) && typeof req.amount === "number" && req.amount >= policy.humanInLoop.amountGte) {
      decision = upgradeDecision(decision, "REQUIRE_HUMAN_APPROVAL");
      reasons.push("高风险类目/金额触发人工审批阈值（" + req.category + ", amount≥" + policy.humanInLoop.amountGte + "）");
      next.push("人工确认用途标签/回执要求/验收标准。");
    }

    if (typeof req.repeat_count_1h === "number" && req.repeat_count_1h >= 10 && typeof req.amount === "number" && req.amount <= 20) {
      decision = upgradeDecision(decision, "FREEZE");
      reasons.push("触发异常规则：短时高频小额（repeat_count_1h≥10 & amount≤20）");
      next.push("冻结支出通道；人工排查是否为欺诈/刷单/脚本误触发；复盘后再解冻。");
    }

    if (!reasons.length) {
      reasons.push("未触发风险规则（示例策略下可自动通过）。");
      next.push("记录回执/发票信息，并在月度复盘中评估该支出的实际效果。");
    }

    const badge = (decision === "APPROVE") ? "✅ APPROVE"
      : (decision === "REQUIRE_HUMAN_APPROVAL") ? "🧑‍⚖️ REQUIRE_HUMAN_APPROVAL"
      : (decision === "REJECT") ? "⛔ REJECT"
      : "🧊 FREEZE";

    const ledger = {
      id: "ledger_" + Math.random().toString(16).slice(2),
      ts: nowIso(),
      decision: decision,
      decision_badge: badge,
      reasons: reasons,
      request: {
        amount: req.amount,
        currency: req.currency || "USD",
        vendor: req.vendor,
        category: req.category,
        reason_code: req.reason_code,
        linked_deliverable_id: req.linked_deliverable_id,
        expected_effect: req.expected_effect,
        risk_level: req.risk_level || "R?",
        purpose_tag: req.purpose_tag || null
      }
    };

    return { decision, badge, reasons, next, ledger };
  }

  function setExample(name) {
    setScenario(name);
    $("req").value = JSON.stringify(examples[name].request, null, 2);
    setReady();
  }

  function renderList(el, items) {
    el.innerHTML = "";
    items.forEach((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      el.appendChild(li);
    });
  }

  function renderError(message) {
    $("decision").textContent = "⛔ REJECT";
    renderList($("reasons"), [message]);
    renderList($("next"), ["使用示例请求，或修正 JSON 格式后再试一次。"]);
    $("ledger").textContent = "{}";
  }

  async function run() {
    const token = ++runToken;
    let req;
    try {
      req = JSON.parse($("req").value);
    } catch (e) {
      setStage("planning", false);
      renderError("JSON 解析失败：请检查格式。");
      return;
    }

    const spent = Number($("spent").value || 0);
    const cap = Number($("cap").value || policy.monthlyCapDefault);

    setStage("planning", false);
    await sleep(350);
    if (token !== runToken) return;

    setStage("policy", true);
    await sleep(450);
    if (token !== runToken) return;

    setStage("risk", true);
    await sleep(450);
    if (token !== runToken) return;

    const out = evaluate(req, spent, cap);

    setStage("ledger", true);
    await sleep(300);
    if (token !== runToken) return;

    $("decision").textContent = out.badge;
    renderList($("reasons"), out.reasons);
    renderList($("next"), out.next);
    $("ledger").textContent = JSON.stringify(out.ledger, null, 2);

    document.querySelectorAll('.step').forEach(step => {
      step.classList.add('done');
      step.classList.remove('active');
    });
    $("currentStage").textContent = "Finished";
    $("currentWorker").textContent = "—";
    $("stageExplain").textContent = "一条请求已经完成评估；上面的结果就是本次示例策略给出的判断。";
    renderList($("stageChecks"), [
      "查看 decision / reasons / next steps",
      "检查 ledger preview 是否记录了必要字段",
      "必要时继续编辑请求并重新评估"
    ]);
  }

  function bind() {
    setScenario(currentExample);
    $("req").value = JSON.stringify(examples[currentExample].request, null, 2);

    document.querySelectorAll("[data-example]").forEach((btn) => {
      btn.addEventListener("click", () => setExample(btn.dataset.example));
    });

    $("btnEval").addEventListener("click", run);

    $("spent").addEventListener("input", () => {
      runToken++;
      setReady();
    });
    $("cap").addEventListener("input", () => {
      runToken++;
      setReady();
    });
    $("req").addEventListener("input", () => {
      runToken++;
      setReady();
    });
  }

  window.addEventListener("DOMContentLoaded", () => {
    bind();
    setReady();
  });
})();
