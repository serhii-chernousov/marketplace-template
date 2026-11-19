import * as k8s from '@pulumi/kubernetes'
import { clusterProvider, secretData } from '../lib/cluster'
import { requireEnv } from '../lib/env'
import { StatefulService } from './stateful-service'

const env = requireEnv([
	'DB_PASSWORD',
	'REDIS_PASSWORD',
	'BROKER_PASSWORD',
	'STORAGE_ACCESS_KEY',
	'STORAGE_SECRET_KEY',
])

export const postgresUser = 'marketplace'
export const postgresDatabase = 'shop'
export const brokerUser = 'app'
export const storageBucket = 'marketplace-files'
export const storageRegion = 'us-east-1'

const provider = clusterProvider()
const namespace = new k8s.core.v1.Namespace(
	'data',
	{ metadata: { name: 'marketplace-data' } },
	{ provider },
).metadata.name

const credentials = new k8s.core.v1.Secret(
	'platform-credentials',
	{
		metadata: { name: 'platform-credentials', namespace },
		type: 'Opaque',
		data: secretData({
			POSTGRES_PASSWORD: env.DB_PASSWORD,
			REDIS_PASSWORD: env.REDIS_PASSWORD,
			RABBITMQ_DEFAULT_PASS: env.BROKER_PASSWORD,
			MINIO_ROOT_USER: env.STORAGE_ACCESS_KEY,
			MINIO_ROOT_PASSWORD: env.STORAGE_SECRET_KEY,
		}),
	},
	{ provider },
)

function fromCredentials(name: string, key = name) {
	return {
		name,
		valueFrom: { secretKeyRef: { name: credentials.metadata.name, key } },
	}
}

const postgres = new StatefulService(
	'postgres',
	{
		namespace,
		image: 'postgres:16.10-alpine',
		port: 5432,
		env: [
			{ name: 'POSTGRES_USER', value: postgresUser },
			{ name: 'POSTGRES_DB', value: postgresDatabase },
			{ name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
			fromCredentials('POSTGRES_PASSWORD'),
		],
		readinessProbe: {
			exec: {
				command: [
					'pg_isready',
					'-h',
					'127.0.0.1',
					'-U',
					postgresUser,
					'-d',
					postgresDatabase,
				],
			},
			periodSeconds: 3,
		},
		dataPath: '/var/lib/postgresql/data',
		memoryLimit: '256Mi',
	},
	{ provider },
)

function redis(name: string, policy: string, persistent: boolean) {
	return new StatefulService(
		name,
		{
			namespace,
			image: 'redis:7.4.5-alpine',
			port: 6379,
			command: ['redis-server'],
			args: [
				'--requirepass',
				'$(REDIS_PASSWORD)',
				'--maxmemory',
				'64mb',
				'--maxmemory-policy',
				policy,
				'--appendonly',
				persistent ? 'yes' : 'no',
				'--dir',
				'/data',
			],
			env: [fromCredentials('REDIS_PASSWORD')],
			readinessProbe: {
				exec: {
					command: [
						'sh',
						'-c',
						'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping | grep -q PONG',
					],
				},
				periodSeconds: 3,
			},
			dataPath: persistent ? '/data' : undefined,
			memoryLimit: '128Mi',
		},
		{ provider },
	)
}

const redisCache = redis('redis-cache', 'allkeys-lru', false)
const redisQueue = redis('redis-queue', 'noeviction', true)

const rabbitmq = new StatefulService(
	'rabbitmq',
	{
		namespace,
		image: 'rabbitmq:3.13.7-management-alpine',
		port: 5672,
		env: [
			{ name: 'RABBITMQ_DEFAULT_USER', value: brokerUser },
			fromCredentials('RABBITMQ_DEFAULT_PASS'),
		],
		readinessProbe: {
			exec: { command: ['rabbitmq-diagnostics', '-q', 'ping'] },
			periodSeconds: 10,
			timeoutSeconds: 10,
		},
		dataPath: '/var/lib/rabbitmq',
		memoryLimit: '384Mi',
	},
	{ provider },
)

const minio = new StatefulService(
	'minio',
	{
		namespace,
		image: 'pgsty/minio:RELEASE.2026-08-04T00-00-00Z',
		port: 9000,
		args: ['server', '/data'],
		env: [
			fromCredentials('MINIO_ROOT_USER'),
			fromCredentials('MINIO_ROOT_PASSWORD'),
		],
		readinessProbe: {
			httpGet: { path: '/minio/health/ready', port: 9000 },
			periodSeconds: 3,
		},
		dataPath: '/data',
		memoryLimit: '256Mi',
	},
	{ provider },
)

// Buckets belong to the platform: the app only reads and writes objects.
new k8s.batch.v1.Job(
	'minio-bucket',
	{
		metadata: { namespace },
		spec: {
			backoffLimit: 6,
			template: {
				spec: {
					restartPolicy: 'Never',
					containers: [
						{
							name: 'mc',
							image: 'pgsty/minio:RELEASE.2026-08-04T00-00-00Z',
							command: ['sh', '-c'],
							args: [
								`mc alias set local http://$(MINIO_HOST):9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc mb --ignore-existing local/${storageBucket}`,
							],
							env: [
								{ name: 'MINIO_HOST', value: minio.host },
								{ name: 'MC_CONFIG_DIR', value: '/tmp/.mc' },
								fromCredentials('MINIO_ROOT_USER'),
								fromCredentials('MINIO_ROOT_PASSWORD'),
							],
						},
					],
				},
			},
		},
	},
	{ provider, dependsOn: [minio.statefulSet] },
)

export const postgresHost = postgres.host
export const postgresPort = postgres.port
export const redisCacheHost = redisCache.host
export const redisQueueHost = redisQueue.host
export const redisPort = 6379
export const brokerHost = rabbitmq.host
export const brokerPort = rabbitmq.port
export const storageEndpoint = minio.host.apply((host) => `http://${host}:9000`)
