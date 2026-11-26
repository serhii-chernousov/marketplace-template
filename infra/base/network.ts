import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import { budget } from './budget'

const VPC_CIDR = '10.31.0.0/16'
const PUBLIC_CIDRS = ['10.31.0.0/24', '10.31.1.0/24']
const PRIVATE_CIDRS = ['10.31.10.0/24', '10.31.11.0/24']

const zones = aws.getAvailabilityZonesOutput({ state: 'available' }).names

export const vpc = new aws.ec2.Vpc(
	'vpc',
	{
		cidrBlock: VPC_CIDR,
		enableDnsSupport: true,
		enableDnsHostnames: true,
		tags: { Name: 'hw31' },
	},
	{ dependsOn: [budget] },
)

function subnets(tier: 'public' | 'private', cidrs: string[]) {
	return cidrs.map(
		(cidrBlock, i) =>
			new aws.ec2.Subnet(`${tier}-${i}`, {
				vpcId: vpc.id,
				cidrBlock,
				availabilityZone: zones[i],
				mapPublicIpOnLaunch: false,
				tags: { Name: `hw31-${tier}-${i}`, Tier: tier },
			}),
	)
}

export const publicSubnets = subnets('public', PUBLIC_CIDRS)
export const privateSubnets = subnets('private', PRIVATE_CIDRS)

const igw = new aws.ec2.InternetGateway('igw', {
	vpcId: vpc.id,
	tags: { Name: 'hw31' },
})

const publicRoutes = new aws.ec2.RouteTable('public', {
	vpcId: vpc.id,
	tags: { Name: 'hw31-public' },
})
new aws.ec2.Route('public-default', {
	routeTableId: publicRoutes.id,
	destinationCidrBlock: '0.0.0.0/0',
	gatewayId: igw.id,
})

// Only the implicit local route: the database needs no way out of the VPC.
const privateRoutes = new aws.ec2.RouteTable('private', {
	vpcId: vpc.id,
	tags: { Name: 'hw31-private' },
})

function associate(
	table: aws.ec2.RouteTable,
	list: aws.ec2.Subnet[],
	tier: string,
) {
	list.forEach(
		(subnet, i) =>
			new aws.ec2.RouteTableAssociation(`${tier}-${i}`, {
				subnetId: subnet.id,
				routeTableId: table.id,
			}),
	)
}

associate(publicRoutes, publicSubnets, 'public')
associate(privateRoutes, privateSubnets, 'private')

export const subnetIds = (list: aws.ec2.Subnet[]) =>
	pulumi.all(list.map((s) => s.id))
