
(function () {
  const policy = {
    perTxCap: 300,
    monthlyCapDefault: 5000,
    allowlistVendors: ["AWS", "OpenAI", "GitHub", "Amazon", "Upwork", "Coursera", "GiveWell", "MSF"],
    allowlistCategories: ["ops_compute", "tooling", "reliability", "knowledge_assets", "human_services", "charity"],
    humanInLoop: { amountGte: 200, categories: ["charity", "human_services"] },
    requiredFields: ["amount", "vendor", "category", "reason_code", "linked_deliverable_id", "expected_effect"],
  };

  const workerChain = "Planner → Policy Worker → Risk Worker → Ledger Worker";
  const examples = {
    tooling: {
      goal: "Jarvis is preparing a research or consulting deliverable and wants to spend $49 on a tooling subscription to improve experiment tracking and reproducibility.",
      workers: workerChain,
      output: "Under the sample policy, this request is usually auto-approved and written to the ledger.",
      request: {
        amount: 49,
        currency: "USD",
        vendor: "GitHub",
        category: "tooling",
        reason_code: "tooling_subscription",
        linked_deliverable_id: "2026-03-demo-clientA",
        expected_effect: "enable experiment tracking / version control for reproducibility",
        risk_level: "R1"
      }
    },
    reliability: {
      goal: "Jarvis wants to pay for one round of human review before delivery so that a report or draft is less likely to contain avoidable errors.",
      workers: workerChain,
      output: "The system checks whether human-service spending is allowed and whether the request should move to manual approval.",
      request: {
        amount: 180,
        currency: "USD",
        vendor: "Upwork",
        category: "human_services",
        reason_code: "independent_review",
        linked_deliverable_id: "2026-03-demo-clientB",
        expected_effect: "pay for human review and statistical checks as conclusion insurance",
        risk_level: "R2"
      }
    },
    charity: {
      goal: "Jarvis allocates a small share of profit to an allowlisted charity, with a purpose tag and a receipt requirement.",
      workers: workerChain,
      output: "The system checks amount, category, vendor, and purpose tag, then returns a decision and the follow-up steps.",
      request: {
        amount: 50,
        currency: "USD",
        vendor: "GiveWell",
        category: "charity",
        reason_code: "charity_take_rate",
        linked_deliverable_id: "2026-03-profit-pool",
        expected_effect: "auditable donation with purpose tags and receipt requirement",
        purpose_tag: "education",
        risk_level: "R0"
      }
    },
    suspicious: {
      goal: "An unusual request tries to trigger repeated small outflows through an unknown vendor. The system should demonstrate how a freeze and manual investigation are triggered.",
      workers: workerChain,
      output: "This kind of request should be marked as anomalous and frozen rather than executed.",
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

  const stages = {
    ready: { label: "Ready", worker: "—", explain: "Waiting for a spend request.", checks: ["Choose an example or edit the JSON directly."] },
    planning: { label: "Planning", worker: "Planner", explain: "Turn the user goal into a structured spend request.", checks: ["Check whether the request matches the goal", "Check whether amount, purpose, and linked deliverable are present"] },
    policy: { label: "Policy check", worker: "Policy Worker", explain: "Run rule checks on budget, allowlists, and required fields.", checks: ["Check required fields", "Check monthly budget and per-transaction cap", "Check vendor and category allowlists"] },
    risk: { label: "Risk review", worker: "Risk Worker", explain: "Evaluate risk level, decide whether human review is needed, and detect freeze conditions.", checks: ["Check high-risk categories and approval thresholds", "Check suspicious patterns such as repeated micro-payments or missing information"] },
    ledger: { label: "Ledger write", worker: "Ledger Worker", explain: "Write the request and the decision into a ledger preview for audit and later review.", checks: ["Generate decision, reasons, and next steps", "Generate a traceable ledger preview"] }
  };

  function $(id) { return document.getElementById(id); }
  function renderList(el, items) {
    el.innerHTML = "";
    items.forEach((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      el.appendChild(li);
    });
  }
  function decisionRank(d) { return ({ APPROVE:0, REQUIRE_HUMAN_APPROVAL:1, REJECT:2, FREEZE:3 })[d] ?? 0; }
  function upgradeDecision(current, next) { return decisionRank(next) > decisionRank(current) ? next : current; }
  function nowIso() { return new Date().toISOString(); }
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function setScenario(name) {
    const ex = examples[name];
    $("scenarioGoal").textContent = ex.goal;
    $("scenarioWorkers").textContent = ex.workers;
    $("scenarioOutput").textContent = ex.output;
  }

  function setStage(name) {
    const cfg = stages[name];
    $("currentStage").textContent = cfg.label;
    $("currentWorker").textContent = cfg.worker;
    $("stageExplain").textContent = cfg.explain;
    renderList($("stageChecks"), cfg.checks);
    const order = ["planning", "policy", "risk", "ledger"];
    document.querySelectorAll(".step").forEach((step) => {
      step.classList.remove("active", "done");
      const idx = order.indexOf(step.dataset.step);
      const currentIdx = order.indexOf(name);
      if (idx < currentIdx) step.classList.add("done");
      if (step.dataset.step === name) step.classList.add("active");
    });
  }

  function setReady() {
    $("currentStage").textContent = stages.ready.label;
    $("currentWorker").textContent = stages.ready.worker;
    $("stageExplain").textContent = stages.ready.explain;
    renderList($("stageChecks"), stages.ready.checks);
    document.querySelectorAll(".step").forEach((step) => step.classList.remove("done"));
    document.querySelectorAll(".step").forEach((step) => step.classList.remove("active"));
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
      reasons.push("Missing required field(s): " + missing.join(", "));
      next.push("Fill in the required fields before trying again.");
    }
    if (req.category && !policy.allowlistCategories.includes(req.category)) {
      decision = upgradeDecision(decision, "REJECT");
      reasons.push("Category is not allowlisted: " + req.category);
      next.push("Change the category or extend governance rules first.");
    }
    if (req.vendor && !policy.allowlistVendors.includes(req.vendor)) {
      decision = upgradeDecision(decision, "REQUIRE_HUMAN_APPROVAL");
      reasons.push("Vendor is not allowlisted: " + req.vendor + " (human approval required)");
      next.push("Verify the vendor manually or switch to an allowlisted vendor.");
    }
    const cap = Number.isFinite(monthlyCap) ? monthlyCap : policy.monthlyCapDefault;
    const remaining = Math.max(0, cap - Math.max(0, spentSoFar || 0));
    if (typeof req.amount === "number") {
      if (req.amount > remaining) {
        decision = upgradeDecision(decision, "REJECT");
        reasons.push("Request exceeds remaining monthly budget: remaining=" + remaining + " USD");
        next.push("Reduce the amount or wait for the next budget cycle.");
      }
      if (req.amount > policy.perTxCap) {
        decision = upgradeDecision(decision, "REQUIRE_HUMAN_APPROVAL");
        reasons.push("Request exceeds the per-transaction cap: perTxCap=" + policy.perTxCap + " USD");
        next.push("Require human confirmation or split the spend into milestones.");
      }
    }
    if (req.category && policy.humanInLoop.categories.includes(req.category) && typeof req.amount === "number" && req.amount >= policy.humanInLoop.amountGte) {
      decision = upgradeDecision(decision, "REQUIRE_HUMAN_APPROVAL");
      reasons.push("High-risk category / amount threshold triggered.");
      next.push("Confirm purpose tag, receipt requirement, and acceptance standard manually.");
    }
    if (typeof req.repeat_count_1h === "number" && req.repeat_count_1h >= 10 && typeof req.amount === "number" && req.amount <= 20) {
      decision = upgradeDecision(decision, "FREEZE");
      reasons.push("Anomaly rule triggered: repeated micro-payments in a short window.");
      next.push("Freeze the spending channel and escalate to manual investigation.");
    }
    if (!reasons.length) {
      reasons.push("No blocking rule was triggered under the sample policy.");
      next.push("Record receipts or invoices and review the actual effect of this spend later.");
    }
    const badge = decision === "APPROVE" ? "✅ APPROVE" : decision === "REQUIRE_HUMAN_APPROVAL" ? "🧑‍⚖️ REQUIRE_HUMAN_APPROVAL" : decision === "REJECT" ? "⛔ REJECT" : "🧊 FREEZE";
    const ledger = {
      id: "ledger_" + Math.random().toString(16).slice(2),
      ts: nowIso(),
      decision,
      decision_badge: badge,
      reasons,
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

  async function run() {
    let req;
    try {
      req = JSON.parse($("req").value);
    } catch (e) {
      setStage("planning");
      $("decision").textContent = "⛔ REJECT";
      renderList($("reasons"), ["JSON parsing failed: please check the format."]);
      renderList($("next"), ["Use an example request, or fix the JSON and try again."]);
      $("ledger").textContent = "{}";
      return;
    }
    setStage("planning");
    await sleep(120);
    setStage("policy");
    await sleep(120);
    setStage("risk");
    await sleep(120);
    const spent = Number($("spent").value || 0);
    const cap = Number($("cap").value || policy.monthlyCapDefault);
    const result = evaluate(req, spent, cap);
    setStage("ledger");
    $("decision").textContent = result.badge;
    renderList($("reasons"), result.reasons);
    renderList($("next"), result.next);
    $("ledger").textContent = JSON.stringify(result.ledger, null, 2);
  }

  document.querySelectorAll('.pillbtn[data-example]').forEach((btn) => {
    btn.addEventListener('click', () => setExample(btn.dataset.example));
  });
  $("btnEval").addEventListener("click", run);
  setExample("tooling");
})();
