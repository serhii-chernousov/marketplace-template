/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: 'no-foreign-internals',
			comment:
				'A module reaches another module only through its public surface (module, service, event, types); repositories, controllers and consumers stay private.',
			severity: 'error',
			from: { path: '(^|/)src/([^/]+)/', pathNot: '(^|/)src/demo/' },
			to: {
				path: '(^|/)src/([^/]+)/.+\\.(repository|controller|consumer)\\.ts$',
				pathNot: '(^|/)src/$2/',
			},
		},
		{
			name: 'no-production-to-demo',
			comment:
				'Demo harnesses may import anything; production code never imports a demo.',
			severity: 'error',
			from: { path: '(^|/)src/', pathNot: '(^|/)src/demo/' },
			to: { path: '(^|/)src/demo/' },
		},
		{
			name: 'no-circular',
			comment:
				'TypeORM relations point both ways by design, so entities are the one allowed cycle.',
			severity: 'error',
			from: { pathNot: '(^|/)src/entities/' },
			to: { circular: true },
		},
	],
	options: {
		doNotFollow: { path: 'node_modules' },
		exclude: { path: '\\.spec\\.ts$' },
		tsPreCompilationDeps: true,
		tsConfig: { fileName: 'tsconfig.json' },
	},
}
