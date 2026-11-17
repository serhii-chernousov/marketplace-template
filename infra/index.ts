import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'
import { clusterProvider, restrictedContainer, secretData } from './lib/cluster'
import { image, jwtExtraPublicKeys, profile, rev, vault } from './settings'

type Container = k8s.types.input.core.v1.Container
type DeploymentStrategy = k8s.types.input.apps.v1.DeploymentStrategy

const APP_PORT = 3000
const NODE_PORT = 30080
const WARMUP_MS = 4000
const DRAIN_MS = 5000
const SHUTDOWN_TIMEOUT_MS = 5000
const correct = profile === 'correct'

const platform = new pulumi.StackReference(
	`organization/marketplace-platform/${pulumi.getStack()}`,
)
const platformValue = (name: string) =>
	platform.requireOutput(name).apply((v) => String(v))

const provider = clusterProvider()
const opts = { provider }
const namespace = new k8s.core.v1.Namespace(
	'app',
	{ metadata: { name: 'marketplace' } },
	opts,
).metadata.name

const postgresHost = platformValue('postgresHost')
const postgresPort = platformValue('postgresPort')
const postgresUser = platformValue('postgresUser')
const postgresDatabase = platformValue('postgresDatabase')
const redisPort = platformValue('redisPort')
const brokerUser = platformValue('brokerUser')

const enc = encodeURIComponent
// Auto-named: a changed value creates a new Secret before the old one is deleted, and the
// new name in the pod template rolls the Deployment instead of replacing it.
const secret = new k8s.core.v1.Secret(
	'marketplace-api-secrets',
	{
		metadata: { namespace },
		type: 'Opaque',
		data: secretData({
			DB_PASSWORD: vault.DB_PASSWORD,
			DB_URL: pulumi.interpolate`postgres://${postgresUser}:${enc(vault.DB_PASSWORD)}@${postgresHost}:${postgresPort}/${postgresDatabase}`,
			REDIS_URL: pulumi.interpolate`redis://:${enc(vault.REDIS_PASSWORD)}@${platformValue('redisCacheHost')}:${redisPort}`,
			REDIS_QUEUE_URL: pulumi.interpolate`redis://:${enc(vault.REDIS_PASSWORD)}@${platformValue('redisQueueHost')}:${redisPort}`,
			BROKER_URL: pulumi.interpolate`amqp://${brokerUser}:${enc(vault.BROKER_PASSWORD)}@${platformValue('brokerHost')}:${platformValue('brokerPort')}`,
			STORAGE_ACCESS_KEY: vault.STORAGE_ACCESS_KEY,
			STORAGE_SECRET_KEY: vault.STORAGE_SECRET_KEY,
			JWT_PRIVATE_KEY: vault.JWT_PRIVATE_KEY,
			JWT_PUBLIC_KEY: vault.JWT_PUBLIC_KEY,
			JWT_KID: vault.JWT_KID,
			JWT_EXTRA_PUBLIC_KEYS: jwtExtraPublicKeys,
			REFRESH_TOKEN_PEPPER: vault.REFRESH_TOKEN_PEPPER,
		}),
	},
	opts,
)

const config = new k8s.core.v1.ConfigMap(
	'marketplace-api-config',
	{
		metadata: { namespace },
		data: {
			PORT: String(APP_PORT),
			LOG_LEVEL: 'info',
			DB_HOST: postgresHost,
			DB_PORT: postgresPort,
			DB_USER: postgresUser,
			DB_NAME: postgresDatabase,
			STORAGE_ENDPOINT: platformValue('storageEndpoint'),
			STORAGE_REGION: platformValue('storageRegion'),
			STORAGE_BUCKET: platformValue('storageBucket'),
		},
	},
	opts,
)

const envFrom: Container['envFrom'] = [
	{ secretRef: { name: secret.metadata.name } },
	{ configMapRef: { name: config.metadata.name } },
]

// Job specs are immutable: a new REV or image replaces the Job, so migrations run on every deploy.
const migrate = new k8s.batch.v1.Job(
	'migrate',
	{
		metadata: { namespace, labels: { app: 'marketplace-migrate' } },
		spec: {
			backoffLimit: 1,
			template: {
				metadata: { labels: { app: 'marketplace-migrate' } },
				spec: {
					restartPolicy: 'Never',
					containers: [
						{
							name: 'migrate',
							image,
							command: ['/nodejs/bin/node'],
							args: [
								'node_modules/typeorm/cli.js',
								'migration:run',
								'-d',
								'dist/database/data-source.js',
							],
							envFrom,
							env: [{ name: 'REV', value: rev }],
							securityContext: restrictedContainer,
						},
					],
				},
			},
		},
	},
	opts,
)

const apiLabels = { app: 'marketplace-api' }

const probes: Pick<
	Container,
	'readinessProbe' | 'livenessProbe' | 'startupProbe'
> = correct
	? {
			startupProbe: {
				httpGet: { path: '/healthz', port: APP_PORT },
				periodSeconds: 1,
				failureThreshold: 60,
			},
			readinessProbe: {
				httpGet: { path: '/readyz', port: APP_PORT },
				periodSeconds: 1,
				timeoutSeconds: 1,
				failureThreshold: 1,
			},
			livenessProbe: {
				httpGet: { path: '/healthz', port: APP_PORT },
				periodSeconds: 10,
				timeoutSeconds: 2,
				failureThreshold: 3,
			},
		}
	: {}

const strategy: DeploymentStrategy = {
	type: 'RollingUpdate',
	rollingUpdate: correct
		? { maxUnavailable: 0, maxSurge: 1 }
		: { maxUnavailable: 1, maxSurge: 0 },
}

const api = new k8s.apps.v1.Deployment(
	'api',
	{
		metadata: { name: 'marketplace-api', namespace, labels: apiLabels },
		spec: {
			replicas: 2,
			selector: { matchLabels: apiLabels },
			strategy,
			template: {
				metadata: { labels: apiLabels },
				spec: {
					terminationGracePeriodSeconds: 20,
					containers: [
						{
							name: 'api',
							image,
							imagePullPolicy: 'IfNotPresent',
							ports: [{ name: 'http', containerPort: APP_PORT }],
							envFrom,
							env: [
								{ name: 'REV', value: rev },
								{ name: 'WARMUP_MS', value: String(WARMUP_MS) },
								{ name: 'DRAIN_MS', value: String(correct ? DRAIN_MS : 0) },
								{
									name: 'SHUTDOWN_TIMEOUT_MS',
									value: String(SHUTDOWN_TIMEOUT_MS),
								},
							],
							...probes,
							resources: {
								requests: { cpu: '100m', memory: '192Mi' },
								limits: { memory: '384Mi' },
							},
							securityContext: restrictedContainer,
						},
					],
				},
			},
		},
	},
	{ ...opts, dependsOn: [migrate] },
)

new k8s.core.v1.Service(
	'api',
	{
		metadata: { name: 'marketplace-api', namespace, labels: apiLabels },
		spec: {
			type: 'NodePort',
			selector: apiLabels,
			ports: [
				{ name: 'http', port: 80, targetPort: APP_PORT, nodePort: NODE_PORT },
			],
		},
	},
	opts,
)

new k8s.policy.v1.PodDisruptionBudget(
	'api',
	{
		metadata: { name: 'marketplace-api', namespace },
		spec: { minAvailable: 1, selector: { matchLabels: apiLabels } },
	},
	opts,
)

new k8s.autoscaling.v2.HorizontalPodAutoscaler(
	'api',
	{
		metadata: { name: 'marketplace-api', namespace },
		spec: {
			scaleTargetRef: {
				apiVersion: 'apps/v1',
				kind: 'Deployment',
				name: api.metadata.name,
			},
			minReplicas: 2,
			maxReplicas: 5,
			metrics: [
				{
					type: 'Resource',
					resource: {
						name: 'cpu',
						target: { type: 'Utilization', averageUtilization: 70 },
					},
				},
			],
		},
	},
	opts,
)

const workerLabels = { app: 'marketplace-worker' }
new k8s.apps.v1.Deployment(
	'worker',
	{
		metadata: { name: 'marketplace-worker', namespace, labels: workerLabels },
		spec: {
			replicas: 1,
			selector: { matchLabels: workerLabels },
			strategy: {
				type: 'RollingUpdate',
				rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
			},
			template: {
				metadata: { labels: workerLabels },
				spec: {
					// Longer than the slowest job: BullMQ worker.close() waits for active jobs.
					terminationGracePeriodSeconds: 60,
					containers: [
						{
							name: 'worker',
							image,
							imagePullPolicy: 'IfNotPresent',
							args: ['dist/worker.js'],
							envFrom,
							env: [{ name: 'REV', value: rev }],
							resources: {
								requests: { cpu: '50m', memory: '160Mi' },
								limits: { memory: '320Mi' },
							},
							securityContext: restrictedContainer,
						},
					],
				},
			},
		},
	},
	{ ...opts, dependsOn: [api] },
)

export const appNamespace = namespace
export const deployment = api.metadata.name
export const url = `http://127.0.0.1:${NODE_PORT}`
export const activeProfile = profile
export const activeRev = rev
export const activeImage = image
