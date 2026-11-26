export const RATES = {
	vcpuHourUsd: 0.04048,
	gibHourUsd: 0.004445,
	hoursPerMonth: 730,
} as const

const WORKLOAD_TYPES = new Set([
	'kubernetes:apps/v1:Deployment',
	'kubernetes:apps/v1:StatefulSet',
])
const LIVE_OPS = new Set([
	'create',
	'update',
	'replace',
	'same',
	'create-replacement',
])

interface Container {
	resources?: { requests?: { cpu?: string; memory?: string } }
}

interface PlanStep {
	op: string
	newState?: {
		type?: string
		inputs?: {
			metadata?: { name?: string }
			spec?: {
				replicas?: number
				template?: { spec?: { containers?: Container[] } }
			}
		}
	}
}

export interface PulumiPreview {
	steps?: PlanStep[]
}

export interface WorkloadCost {
	name: string
	replicas: number
	vcpu: number
	gib: number
	monthlyUsd: number
}

export function cpuCores(quantity: string | undefined): number {
	if (!quantity) return 0
	return quantity.endsWith('m')
		? Number(quantity.slice(0, -1)) / 1000
		: Number(quantity)
}

const MEMORY_UNITS: Record<string, number> = {
	Ki: 1 / 1024 ** 2,
	Mi: 1 / 1024,
	Gi: 1,
	K: 1e3 / 1024 ** 3,
	M: 1e6 / 1024 ** 3,
	G: 1e9 / 1024 ** 3,
}

export function memoryGib(quantity: string | undefined): number {
	if (!quantity) return 0
	const match = /^(\d+(?:\.\d+)?)([KMG]i?)?$/.exec(quantity)
	if (!match) throw new Error(`unsupported memory quantity "${quantity}"`)
	const [, amount, unit] = match
	return unit ? Number(amount) * MEMORY_UNITS[unit] : Number(amount) / 1024 ** 3
}

export function workloadCosts(plan: PulumiPreview): WorkloadCost[] {
	return (plan.steps ?? [])
		.filter(
			(step) =>
				LIVE_OPS.has(step.op) && WORKLOAD_TYPES.has(step.newState?.type ?? ''),
		)
		.map((step) => {
			const inputs = step.newState?.inputs ?? {}
			const containers = inputs.spec?.template?.spec?.containers ?? []
			const replicas = inputs.spec?.replicas ?? 1
			const vcpu = sum(
				containers.map((c) => cpuCores(c.resources?.requests?.cpu)),
			)
			const gib = sum(
				containers.map((c) => memoryGib(c.resources?.requests?.memory)),
			)
			const hourly = vcpu * RATES.vcpuHourUsd + gib * RATES.gibHourUsd
			return {
				name: inputs.metadata?.name ?? '?',
				replicas,
				vcpu,
				gib,
				monthlyUsd: replicas * hourly * RATES.hoursPerMonth,
			}
		})
}

export function planMonthlyUsd(plan: PulumiPreview): number {
	return sum(workloadCosts(plan).map((w) => w.monthlyUsd))
}

function sum(values: number[]): number {
	return values.reduce((total, value) => total + value, 0)
}
