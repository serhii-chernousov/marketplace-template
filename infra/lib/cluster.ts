import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'

/** Pinned kube context: a stray current-context must never receive this deploy. */
export function clusterProvider(): k8s.Provider {
	const context = new pulumi.Config().get('kubeContext') ?? 'kind-hw28'
	return new k8s.Provider('cluster', { context })
}

/** data, not stringData: stringData is write-only and shows a diff on every up. */
export function secretData(
	values: Record<string, pulumi.Input<string>>,
): pulumi.Output<Record<string, string>> {
	return pulumi.secret(
		pulumi
			.all(values)
			.apply((resolved) =>
				Object.fromEntries(
					Object.entries(resolved).map(([key, value]) => [
						key,
						Buffer.from(value).toString('base64'),
					]),
				),
			),
	)
}

export const restrictedContainer: k8s.types.input.core.v1.SecurityContext = {
	runAsNonRoot: true,
	// distroless :nonroot declares USER by name; kubelet cannot verify a name, only a number.
	runAsUser: 65532,
	runAsGroup: 65532,
	readOnlyRootFilesystem: true,
	allowPrivilegeEscalation: false,
	capabilities: { drop: ['ALL'] },
	seccompProfile: { type: 'RuntimeDefault' },
}
