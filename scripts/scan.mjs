#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const TRIVY_IMAGE = 'aquasec/trivy:0.65.0'
const DEFAULT_MAX = '20'

const image = process.env.IMG || imageFromGit()
const severities = (process.env.SCAN_SEVERITY || 'CRITICAL,HIGH')
	.split(',')
	.map((s) => s.trim().toUpperCase())
	.filter(Boolean)
const rawMax = process.env.SCAN_MAX ?? DEFAULT_MAX
const maxAllowed = Number(rawMax)

console.log(`image=${image}`)
console.log(`severity=${severities.join(',')}`)

if (!/^-?\d+$/.test(rawMax.trim()) || !Number.isSafeInteger(maxAllowed)) {
	fail(`SCAN_MAX must be an integer, got "${rawMax}"`)
}

const trivy = spawnSync(
	'docker',
	[
		'run',
		'--rm',
		'-v',
		'/var/run/docker.sock:/var/run/docker.sock',
		'-v',
		'hw28-trivy-cache:/root/.cache/',
		TRIVY_IMAGE,
		'image',
		'--quiet',
		'--format',
		'json',
		'--scanners',
		'vuln',
		'--ignore-unfixed',
		'--severity',
		severities.join(','),
		image,
	],
	{ encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
)
if (trivy.status !== 0) {
	fail(`trivy exited with ${trivy.status}: ${trivy.stderr.trim().slice(-500)}`)
}

let report
try {
	report = JSON.parse(trivy.stdout)
} catch {
	fail('trivy report is not valid JSON')
}

const wanted = new Set(severities)
const found = (report.Results ?? [])
	.flatMap((r) => r.Vulnerabilities ?? [])
	.filter((v) => wanted.has(v.Severity)).length

const passed = found <= maxAllowed
console.log(`found=${found}`)
console.log(`max-allowed=${maxAllowed}`)
console.log(`gate=${passed ? 'pass' : 'fail'}`)
process.exit(passed ? 0 : 1)

function imageFromGit() {
	const resolved = spawnSync(
		'bash',
		['-c', 'source scripts/image-tag.sh && printf %s "$IMG"'],
		{ encoding: 'utf8' },
	)
	if (resolved.status !== 0 || !resolved.stdout) {
		fail('could not resolve the image tag (scripts/image-tag.sh)')
	}
	return resolved.stdout
}

// Fail closed: a scanner that could not run must never look like a pass.
function fail(reason) {
	console.error(reason)
	console.log('gate=error')
	process.exit(2)
}
