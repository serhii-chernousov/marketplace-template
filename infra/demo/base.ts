import * as pulumi from '@pulumi/pulumi'

const ref = new pulumi.StackReference(
	`${pulumi.getOrganization()}/hw31-base/base`,
)

const output = <T>(name: string) => ref.requireOutput(name) as pulumi.Output<T>

export const base = {
	vpcId: output<string>('vpcId'),
	publicSubnetIds: output<string[]>('publicSubnetIds'),
	privateSubnetIds: output<string[]>('privateSubnetIds'),
	albSgId: output<string>('albSgId'),
	dbSgId: output<string>('dbSgId'),
}
