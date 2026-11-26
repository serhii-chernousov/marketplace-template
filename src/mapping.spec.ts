import { cpuCores, memoryGib, planMonthlyUsd, RATES } from './mapping'

const deployment = (
	replicas: number,
	cpu: string,
	memory: string,
	op = 'create',
) => ({
	op,
	newState: {
		type: 'kubernetes:apps/v1:Deployment',
		inputs: {
			metadata: { name: 'api' },
			spec: {
				replicas,
				template: {
					spec: { containers: [{ resources: { requests: { cpu, memory } } }] },
				},
			},
		},
	},
})

describe('mapping', () => {
	it('parses Kubernetes quantities', () => {
		expect(cpuCores('100m')).toBeCloseTo(0.1)
		expect(cpuCores('2')).toBe(2)
		expect(memoryGib('512Mi')).toBeCloseTo(0.5)
		expect(memoryGib('1Gi')).toBe(1)
	})

	it('prices requests times replicas for a month', () => {
		const plan = { steps: [deployment(2, '500m', '1Gi')] }
		const hourly = 0.5 * RATES.vcpuHourUsd + 1 * RATES.gibHourUsd
		expect(planMonthlyUsd(plan)).toBeCloseTo(2 * hourly * RATES.hoursPerMonth)
	})

	it('ignores deletes and non-workload resources', () => {
		const plan = {
			steps: [
				deployment(3, '1', '1Gi', 'delete'),
				{
					op: 'create',
					newState: { type: 'kubernetes:core/v1:Secret', inputs: {} },
				},
			],
		}
		expect(planMonthlyUsd(plan)).toBe(0)
	})

	it('grows when a change raises requests', () => {
		const before = planMonthlyUsd({ steps: [deployment(2, '100m', '192Mi')] })
		const after = planMonthlyUsd({ steps: [deployment(2, '200m', '192Mi')] })
		expect(after).toBeGreaterThan(before)
	})
})
