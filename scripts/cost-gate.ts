import { readFileSync } from 'node:fs'
import {
	planMonthlyUsd,
	workloadCosts,
	type PulumiPreview,
} from '../src/mapping'

const DELTA_ABS_USD = 10
const DELTA_REL = 0.2

const planPath = process.env.PLAN_JSON ?? 'plan.json'
const plan = JSON.parse(readFileSync(planPath, 'utf8')) as PulumiPreview

for (const w of workloadCosts(plan)) {
	console.log(
		`workload=${w.name} replicas=${w.replicas} vcpu=${w.vcpu} gib=${w.gib.toFixed(3)} usd=${w.monthlyUsd.toFixed(2)}`,
	)
}

const planUsd = planMonthlyUsd(plan)
const budgetUsd = budget()

console.log(`plan-usd=${planUsd.toFixed(2)}`)
console.log(`budget-usd=${budgetUsd.toFixed(2)}`)
const pass = planUsd <= budgetUsd
console.log(`gate=${pass ? 'pass' : 'fail'}`)
process.exit(pass ? 0 : 1)

// An explicit budget wins; otherwise the gate judges the change against the
// baseline, so one expensive resource does not turn every later PR red.
function budget(): number {
	const explicit = process.env.COST_BUDGET_USD
	if (explicit !== undefined && explicit !== '')
		return toNumber('COST_BUDGET_USD', explicit)
	const baselineFile =
		process.env.COST_BASELINE_FILE ?? 'infra/cost-baseline.json'
	const { monthlyUsd } = JSON.parse(readFileSync(baselineFile, 'utf8')) as {
		monthlyUsd: number
	}
	console.log(`baseline-usd=${monthlyUsd.toFixed(2)}`)
	return monthlyUsd + Math.max(DELTA_ABS_USD, monthlyUsd * DELTA_REL)
}

function toNumber(name: string, raw: string): number {
	const value = Number(raw)
	if (!Number.isFinite(value))
		throw new Error(`${name} must be a number, got "${raw}"`)
	return value
}
