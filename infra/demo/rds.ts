import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import { base } from './base'
import { requireEnv } from './env'

const { DB_PASSWORD } = requireEnv(['DB_PASSWORD'])

const subnetGroup = new aws.rds.SubnetGroup('db', {
	name: 'hw31-demo-db',
	subnetIds: base.privateSubnetIds,
})

export const db = new aws.rds.Instance('db', {
	identifier: 'hw31-demo-db',
	engine: 'postgres',
	engineVersion: '16',
	instanceClass: 'db.t4g.micro',
	multiAz: true,
	allocatedStorage: 20,
	storageType: 'gp3',
	storageEncrypted: true,
	backupRetentionPeriod: 1,
	deleteAutomatedBackups: true,
	dbSubnetGroupName: subnetGroup.name,
	vpcSecurityGroupIds: [base.dbSgId],
	publiclyAccessible: false,
	performanceInsightsEnabled: false,
	monitoringInterval: 0,
	dbName: 'shop',
	username: 'marketplace',
	password: pulumi.secret(DB_PASSWORD),
	applyImmediately: true,
	deletionProtection: false,
	skipFinalSnapshot: true,
})
