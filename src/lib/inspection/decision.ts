import {
  COVERAGE_GROUPS,
  CHECK_LABELS,
  type CheckKey,
  type CheckResult,
  type CoverageEntry,
  type Decision,
  type DecisionOutcome,
  type OverrideEntry,
  type Verdict,
} from "@/lib/types";

/**
 * Deterministic decision engine.
 *
 * FAIL anywhere      → EXCEPTION
 * else UNCERTAIN     → UNCERTAIN
 * else all PASS      → PASS
 * processing failed  → PENDING (set by the inspection route, not here)
 *
 * UNCERTAIN is never promoted to PASS and never demoted to EXCEPTION.
 */
export function decide(checks: CheckResult[]): DecisionOutcome {
  const failed = checks.filter((c) => c.verdict === "FAIL").map((c) => c.check_key);
  const uncertain = checks.filter((c) => c.verdict === "UNCERTAIN").map((c) => c.check_key);

  const coverage = computeCoverage(checks);

  if (failed.length > 0) {
    const summary = `${failed.length} ${failed.length === 1 ? "check" : "checks"} failed: ${failed
      .map((k) => CHECK_LABELS[k])
      .join(", ")}.`;
    const firstFailed = checks.find((c) => c.verdict === "FAIL");
    return {
      decision: "EXCEPTION",
      summary,
      failed_checks: failed,
      uncertain_checks: uncertain,
      recommended_action:
        firstFailed?.recommended_action ??
        "Hold the receiving record for review and record the discrepancy against the supplier.",
      coverage,
    };
  }

  if (uncertain.length > 0) {
    const summary = `${uncertain.length} ${uncertain.length === 1 ? "check" : "checks"} could not be verified from the supplied evidence: ${uncertain
      .map((k) => CHECK_LABELS[k])
      .join(", ")}.`;
    const firstUncertain = checks.find((c) => c.verdict === "UNCERTAIN");
    return {
      decision: "UNCERTAIN",
      summary,
      failed_checks: [],
      uncertain_checks: uncertain,
      recommended_action: firstUncertain?.recommended_action ?? "Capture additional evidence and re-inspect.",
      coverage,
    };
  }

  return {
    decision: "PASS",
    summary: `All ${checks.length} checks passed against the purchase-order line.`,
    failed_checks: [],
    uncertain_checks: [],
    recommended_action: "No additional action required.",
    coverage,
  };
}

/** Same FAIL → EXCEPTION / UNCERTAIN / PASS rules, from verdicts alone. */
export function decisionFromVerdicts(verdicts: Array<Verdict | string>): Decision {
  if (verdicts.some((v) => v === "FAIL")) return "EXCEPTION";
  if (verdicts.some((v) => v === "UNCERTAIN")) return "UNCERTAIN";
  return "PASS";
}

/**
 * Effective view after the append-only override log.
 *
 * Agent `outcome.decision` is never rewritten. If an operator overrode the
 * overall decision, that value is used. Otherwise the overall effective
 * decision is derived from the effective per-check verdicts.
 */
export function effectiveFromOverrides(
  checks: CheckResult[],
  agentDecision: Decision,
  overrides: OverrideEntry[],
): {
  decision: Decision;
  checks: { check_key: CheckKey; verdict: string; overridden: boolean }[];
  overridden: boolean;
  overall_overridden: boolean;
} {
  const latestFor = (target: string | null) =>
    overrides
      .filter((o) => (o.check_key ?? null) === target)
      .slice()
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
      .pop();

  const effectiveChecks = checks.map((c) => {
    const latest = latestFor(c.check_key);
    return {
      check_key: c.check_key,
      verdict: latest ? latest.new_verdict : c.verdict,
      overridden: Boolean(latest),
    };
  });

  const overall = latestFor(null);
  const derived = decisionFromVerdicts(effectiveChecks.map((c) => c.verdict));
  const decision = overall ? (overall.new_verdict as Decision) : derived;

  return {
    decision,
    checks: effectiveChecks,
    overridden: Boolean(overall) || effectiveChecks.some((c) => c.overridden),
    overall_overridden: Boolean(overall),
  };
}

/** Pending outcome for a capture that never reached a valid inspection. */
export function pendingOutcome(reason: string): DecisionOutcome {
  return {
    decision: "PENDING",
    summary: "Inspection could not be completed. The capture and all evidence are saved.",
    failed_checks: [],
    uncertain_checks: [],
    recommended_action: `${reason} Retry the inspection when the service is available.`,
    coverage: [],
  };
}

/**
 * Inspection Coverage — an application UX metric, not an organiser metric.
 * It reports the share of checks in each group that had sufficient evidence,
 * which is what makes an UNCERTAIN verdict explainable.
 */
export function computeCoverage(checks: CheckResult[]): CoverageEntry[] {
  const byKey = new Map<CheckKey, CheckResult>(checks.map((c) => [c.check_key, c]));

  return Object.entries(COVERAGE_GROUPS).map(([group, keys]) => {
    const present = keys.map((k) => byKey.get(k)).filter(Boolean) as CheckResult[];
    if (present.length === 0) {
      return { group, percent: 0, explanation: "No checks were run for this group." };
    }
    const sufficient = present.filter((c) => c.evidence_sufficiency === "sufficient");
    const percentValue = Math.round((sufficient.length / present.length) * 100);
    const weak = present.filter((c) => c.evidence_sufficiency !== "sufficient").map((c) => CHECK_LABELS[c.check_key]);
    return {
      group,
      percent: percentValue,
      explanation:
        weak.length === 0
          ? "Evidence was sufficient for every check in this group."
          : `Evidence insufficient for: ${weak.join(", ")}.`,
    };
  });
}
