import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import { base } from './base'

const withNat = new pulumi.Config('hw31').getBoolean('withNat') ?? false

function createNat() {
	const eip = new aws.ec2.Eip('nat', { domain: 'vpc' })
	return new aws.ec2.NatGateway('nat', {
		allocationId: eip.id,
		subnetId: base.publicSubnetIds.apply((ids) => ids[0]),
		tags: { Name: 'hw31-demo-nat' },
	})
}

export const nat = withNat ? createNat() : undefined
