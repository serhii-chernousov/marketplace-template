import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'

type Container = k8s.types.input.core.v1.Container

export interface StatefulServiceArgs {
	namespace: pulumi.Input<string>
	image: string
	port: number
	command?: string[]
	args?: string[]
	env?: Container['env']
	readinessProbe: Container['readinessProbe']
	/** Omit for disposable data (the cache): no volume, nothing to migrate. */
	dataPath?: string
	storage?: string
	memoryLimit: string
}

/** One StatefulSet + ClusterIP Service: the local stand-in for a managed service. */
export class StatefulService extends pulumi.ComponentResource {
	readonly host: pulumi.Output<string>
	readonly port: number
	readonly statefulSet: k8s.apps.v1.StatefulSet

	constructor(
		name: string,
		args: StatefulServiceArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('marketplace:platform:StatefulService', name, {}, opts)
		const child = { parent: this }
		const labels = { app: name }

		const service = new k8s.core.v1.Service(
			name,
			{
				metadata: { name, namespace: args.namespace, labels },
				spec: {
					selector: labels,
					ports: [{ name: 'main', port: args.port, targetPort: args.port }],
				},
			},
			child,
		)

		const volumeName = 'data'
		this.statefulSet = new k8s.apps.v1.StatefulSet(
			name,
			{
				metadata: { name, namespace: args.namespace, labels },
				spec: {
					serviceName: service.metadata.name,
					replicas: 1,
					selector: { matchLabels: labels },
					template: {
						metadata: { labels },
						spec: {
							terminationGracePeriodSeconds: 30,
							containers: [
								{
									name,
									image: args.image,
									imagePullPolicy: 'IfNotPresent',
									command: args.command,
									args: args.args,
									env: args.env,
									ports: [{ containerPort: args.port }],
									readinessProbe: args.readinessProbe,
									resources: {
										requests: { cpu: '50m', memory: '64Mi' },
										limits: { memory: args.memoryLimit },
									},
									volumeMounts: args.dataPath
										? [{ name: volumeName, mountPath: args.dataPath }]
										: undefined,
								},
							],
						},
					},
					volumeClaimTemplates: args.dataPath
						? [
								{
									metadata: { name: volumeName },
									spec: {
										accessModes: ['ReadWriteOnce'],
										resources: {
											requests: { storage: args.storage ?? '1Gi' },
										},
									},
								},
							]
						: undefined,
				},
			},
			child,
		)

		this.host = pulumi.interpolate`${service.metadata.name}.${service.metadata.namespace}.svc.cluster.local`
		this.port = args.port
		this.registerOutputs({ host: this.host })
	}
}
